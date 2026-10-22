import {
  type Cursor,
  cursor,
  dirOf,
  isPunct,
  isWord,
  joinPath,
  lex,
  type Manifest,
  nameOf,
  type Syntax,
} from "./imports-common.js";

const GO: Syntax = { nestedComments: false, backtick: "raw-string", rust: false };

const TEST_SUFFIX = "_test.go";
/** `module` and its path, in the one-line form and the parenthesized one. A comment line cannot match. */
const MODULE_DIRECTIVE = /^[ \t]*module(?=[\s(])\s*\(?\s*("[^"\n]*"|`[^`\n]*`|[^\s()]+)/m;

type GoModule = { readonly path: string; readonly dir: string };

/** Every `go.mod` in the repository, and the non-test `.go` files of each directory (a Go package). */
export type GoModules = {
  /** Longest module path first, so the most specific module claims an import. */
  readonly modules: readonly GoModule[];
  /** Where each `go.mod` lies, including those that name no usable module: they still end their parent. */
  readonly moduleDirs: ReadonlySet<string>;
  readonly packages: ReadonlyMap<string, readonly string[]>;
};

function modulePath(text: string): string | null {
  const quoted = MODULE_DIRECTIVE.exec(text)?.[1];
  if (quoted === undefined) return null;
  const path = /^["`]/.test(quoted) ? quoted.slice(1, -1) : quoted;
  return path === "" ? null : path;
}

export function goModules(files: readonly string[], manifests: readonly Manifest[]): GoModules {
  const gomods = manifests.filter((manifest) => nameOf(manifest.path) === "go.mod");
  const claims = new Map<string, GoModule[]>();
  for (const { path, text } of gomods) {
    const claimed = modulePath(text);
    if (claimed === null) continue;
    claims.set(claimed, [...(claims.get(claimed) ?? []), { path: claimed, dir: dirOf(path) }]);
  }
  const modules = [...claims.values()]
    .flatMap((claimants) => (claimants.length === 1 ? claimants : []))
    .sort((a, b) => b.path.length - a.path.length);

  const packages = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith(".go") || file.endsWith(TEST_SUFFIX)) continue;
    const dir = dirOf(file);
    packages.set(dir, [...(packages.get(dir) ?? []), file]);
  }
  return { modules, moduleDirs: new Set(gomods.map(({ path }) => dirOf(path))), packages };
}

/** The directory of the nearest `go.mod` at or above `dir`, which owns every file below it. */
function ownerOf(dir: string, moduleDirs: ReadonlySet<string>): string | null {
  for (let at = dir; ; at = dirOf(at)) {
    if (moduleDirs.has(at)) return at;
    if (at === "") return null;
  }
}

/** The files `path` imports: every non-test file of each package it names, and for a test, its own. */
export function resolveGo(path: string, content: string, go: GoModules): string[] {
  const targets: string[] = [];
  for (const specifier of new Set(goImports(content))) {
    const module = go.modules.find(
      ({ path: name }) => specifier === name || specifier.startsWith(`${name}/`),
    );
    if (module === undefined) continue;
    const rest =
      specifier === module.path ? [] : specifier.slice(module.path.length + 1).split("/");
    if (rest.some((name) => name === "" || name === "." || name === "..")) continue;
    const dir = joinPath(module.dir, ...rest);
    if (ownerOf(dir, go.moduleDirs) === module.dir) targets.push(...(go.packages.get(dir) ?? []));
  }
  if (path.endsWith(TEST_SUFFIX)) targets.push(...(go.packages.get(dirOf(path)) ?? []));
  return targets;
}

/** The paths in the import declarations that follow the package clause. Nothing after them is read. */
function goImports(content: string): string[] {
  const tokens = cursor(lex(content, GO));
  const found: string[] = [];
  if (!isWord(tokens.next(), "package")) return found;
  tokens.next();
  for (;;) {
    const token = tokens.peek();
    if (isPunct(token, ";")) {
      tokens.next();
    } else if (isWord(token, "import")) {
      tokens.next();
      if (!importDeclaration(tokens, found)) return found;
    } else {
      return found;
    }
  }
}

/** One `import "p"` or `import ( ... )`, after the keyword. False when the text stops being an import. */
function importDeclaration(tokens: Cursor, found: string[]): boolean {
  if (!isPunct(tokens.peek(), "(")) return importSpec(tokens, found);
  tokens.next();
  for (;;) {
    const token = tokens.peek();
    if (token === null) return false;
    if (isPunct(token, ")")) {
      tokens.next();
      return true;
    }
    if (isPunct(token, ";")) tokens.next();
    else if (!importSpec(tokens, found)) return false;
  }
}

/** `[name | _ | .] "path"`. */
function importSpec(tokens: Cursor, found: string[]): boolean {
  let token = tokens.next();
  if (token?.kind === "ident" || isPunct(token, ".")) token = tokens.next();
  if (token?.kind !== "string" || token.text === "" || token.text.includes("\\")) return false;
  found.push(token.text);
  return true;
}
