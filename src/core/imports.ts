import { posix } from "node:path";

export type ImportContext = {
  /** Every walked source file, root-relative. Imports resolve only to these. */
  readonly files: ReadonlySet<string>;
  /** `config.aliases` as `[prefix, root-relative directory]`, longest prefix first. */
  readonly aliases: readonly (readonly [string, string])[];
};

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

/** The files `path` imports, as root-relative paths. Unresolvable imports (packages, builtins) are dropped. */
export function resolveImports(path: string, content: string, context: ImportContext): string[] {
  const extension = posix.extname(path);
  const targets = JS_EXTENSIONS.includes(extension)
    ? jsSpecifiers(content).map((specifier) => resolveJs(path, specifier, context))
    : extension === ".py"
      ? pythonModules(path, content).map((module) => resolvePython(module, context))
      : [];
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
