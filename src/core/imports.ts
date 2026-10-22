import { posix } from "node:path";
import type { Manifest } from "./imports-common.js";
import { type GoModules, goModules, resolveGo } from "./imports-go.js";
import { type JvmRoots, jvmRoots, resolveJvm } from "./imports-jvm.js";
import { type RustCrates, resolveRust, rustCrates } from "./imports-rust.js";

export type ImportContext = {
  /** Every walked source file, root-relative. Imports resolve only to these. */
  readonly files: ReadonlySet<string>;
  /** `config.aliases` as `[prefix, root-relative directory]`, longest prefix first. */
  readonly aliases: readonly (readonly [string, string])[];
  readonly go: GoModules;
  readonly rust: RustCrates;
  readonly jvm: JvmRoots;
};

/** What a scan knows before it reads any one file: the walked paths, the config and the manifests. */
export function importContext(input: {
  readonly files: readonly string[];
  readonly aliases: ImportContext["aliases"];
  readonly manifests: readonly Manifest[];
}): ImportContext {
  return {
    files: new Set(input.files),
    aliases: input.aliases,
    go: goModules(input.files, input.manifests),
    rust: rustCrates(input.files, input.manifests),
    jvm: jvmRoots(input.files),
  };
}

const JS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: ReadonlyMap<string, readonly string[]> = new Map([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
]);
const PYTHON_BASES: readonly string[] = ["", "src", "app"];

const JS_SPECIFIER =
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const PYTHON_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm;
const PYTHON_IMPORT = /^[ \t]*import[ \t]+([^\n#;]+)/gm;

/** The files one source file imports, each `null` where an import resolves to nothing in the repository. */
type Resolver = (
  path: string,
  content: string,
  context: ImportContext,
) => readonly (string | null)[];

const resolveJsFile: Resolver = (path, content, context) =>
  jsSpecifiers(content).map((specifier) => resolveJs(path, specifier, context));

const resolvePythonFile: Resolver = (path, content, context) =>
  pythonModules(path, content).map((module) => resolvePython(module, context));

/** Which resolver reads a file, by extension. A language is a row; a file of any other extension imports nothing. */
const RESOLVERS: ReadonlyMap<string, Resolver> = new Map<string, Resolver>([
  ...JS_EXTENSIONS.map((extension): [string, Resolver] => [extension, resolveJsFile]),
  [".py", resolvePythonFile],
  [".go", (path, content, context) => resolveGo(path, content, context.go)],
  [".rs", (path, content, context) => resolveRust(path, content, context.rust)],
  ...[".java", ".kt"].map((extension): [string, Resolver] => [
    extension,
    (path, content, context) => resolveJvm(path, content, context.jvm),
  ]),
]);

/** The files `path` imports, as root-relative paths. Unresolvable imports (packages, builtins) are dropped. */
export function resolveImports(path: string, content: string, context: ImportContext): string[] {
  const targets = RESOLVERS.get(posix.extname(path))?.(path, content, context) ?? [];
  return [
    ...new Set(targets.flatMap((target) => (target === null || target === path ? [] : [target]))),
  ].sort();
}

function jsSpecifiers(content: string): string[] {
  return [...content.matchAll(JS_SPECIFIER)].flatMap(
    (match) => match[1] ?? match[2] ?? match[3] ?? [],
  );
}

function isRelative(specifier: string): boolean {
  return /^\.\.?(\/|$)/.test(specifier);
}

function resolveJs(from: string, specifier: string, context: ImportContext): string | null {
  const base = isRelative(specifier)
    ? posix.join(posix.dirname(from), specifier)
    : aliased(specifier, context.aliases);
  if (base === null) return null;
  return firstExisting(jsCandidates(posix.normalize(base)), context.files);
}

function aliased(specifier: string, aliases: ImportContext["aliases"]): string | null {
  for (const [prefix, directory] of aliases) {
    if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
      return posix.join(directory, specifier.slice(prefix.length));
    }
  }
  return null;
}

function jsCandidates(base: string): string[] {
  const extension = posix.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  return [
    base,
    ...(JS_TO_TS.get(extension) ?? []).map((ts) => stem + ts),
    ...JS_EXTENSIONS.map((ext) => base + ext),
    ...JS_EXTENSIONS.map((ext) => posix.join(base, `index${ext}`)),
  ];
}

/** A module to look up, and the directories to look it up from, in the order they are tried. */
type PythonModule = { readonly name: string; readonly bases: readonly string[] };

function pythonModules(from: string, content: string): PythonModule[] {
  const dir = posix.dirname(from) === "." ? "" : posix.dirname(from);
  const modules: PythonModule[] = [];
  for (const [, dots = "", name = "", imported = ""] of content.matchAll(PYTHON_FROM)) {
    if (dots === "") {
      modules.push({ name, bases: [dir, ...PYTHON_BASES] });
      continue;
    }
    const up = Array.from({ length: dots.length - 1 }, () => "..");
    const base = posix.normalize(posix.join(dir === "" ? "." : dir, ...up));
    const names = name === "" ? importedNames(imported) : [name];
    for (const each of names) modules.push({ name: each, bases: [base === "." ? "" : base] });
  }
  for (const [, list = ""] of content.matchAll(PYTHON_IMPORT)) {
    for (const part of list.split(",")) {
      const name = part.trim().split(/\s+/)[0] ?? "";
      if (/^[\w.]+$/.test(name)) modules.push({ name, bases: [dir, ...PYTHON_BASES] });
    }
  }
  return modules;
}

/** The names in `from . import a, b as c` or its parenthesized form; a package's submodules. */
function importedNames(list: string): string[] {
  return list
    .replace(/#.*$/gm, "")
    .replace(/[()\\]/g, " ")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((name) => /^\w+$/.test(name));
}

function resolvePython(module: PythonModule, context: ImportContext): string | null {
  const relativePath = module.name.replaceAll(".", "/");
  const candidates = module.bases.flatMap((base) => {
    const path = posix.normalize(posix.join(base === "" ? "." : base, relativePath));
    return [`${path}.py`, `${path}/__init__.py`];
  });
  return firstExisting(candidates, context.files);
}

function firstExisting(candidates: readonly string[], files: ReadonlySet<string>): string | null {
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}
