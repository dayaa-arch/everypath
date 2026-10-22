import { posix } from "node:path";
import {
  dirOf,
  isPunct,
  isWord,
  joinPath,
  lex,
  type Manifest,
  nameOf,
  type Syntax,
  type Token,
} from "./imports-common.js";

const RUST: Syntax = { nestedComments: true, backtick: "punct", rust: true };

/** Cargo's target directories beside `src/`: each `.rs` in one is a crate of its own. */
const TARGET_DIRECTORIES: ReadonlySet<string> = new Set(["tests", "examples", "benches"]);
/** A `use` tree nested deeper than this is not read. Real ones stay under four. */
const MAX_USE_DEPTH = 16;
/** An attribute that does not close within this many tokens is not read as one. */
const MAX_ATTRIBUTE_TOKENS = 256;

/** The `.rs` files, the Cargo packages, and the library crates that other crates can `use` by name. */
export type RustCrates = {
  readonly files: ReadonlySet<string>;
  /** Directories that hold a package: a `Cargo.toml`, or a `src/lib.rs` or `src/main.rs`. */
  readonly packages: ReadonlySet<string>;
  /** Crate name as written in a `use`, to its `src/lib.rs`. A name two packages claim is absent. */
  readonly libs: ReadonlyMap<string, string>;
};

function tomlName(line: string): string | null {
  const match = /^name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
  return match === null ? null : (match[1] ?? match[2] ?? null);
}

/** `[package] name` and `[lib] name` of a `Cargo.toml`: the two keys that decide what a `use` names. */
function cargoNames(text: string): {
  readonly package: string | null;
  readonly lib: string | null;
} {
  let table = "";
  let packageName: string | null = null;
  let libName: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      table = /^\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/.exec(line)?.[1] ?? "";
      continue;
    }
    const name = tomlName(line);
    if (name === null) continue;
    if (table === "package") packageName ??= name;
    else if (table === "lib") libName ??= name;
  }
  return { package: packageName, lib: libName };
}

export function rustCrates(files: readonly string[], manifests: readonly Manifest[]): RustCrates {
  const rust = new Set(files.filter((file) => file.endsWith(".rs")));
  const cargos = manifests.filter((manifest) => nameOf(manifest.path) === "Cargo.toml");
  const packages = new Set(cargos.map((manifest) => dirOf(manifest.path)));
  for (const file of rust) {
    const name = nameOf(file);
    if ((name === "lib.rs" || name === "main.rs") && nameOf(dirOf(file)) === "src") {
      packages.add(dirOf(dirOf(file)));
    }
  }
  const claims = new Map<string, string[]>();
  for (const { path, text } of cargos) {
    const names = cargoNames(text);
    const crate = (names.lib ?? names.package)?.replaceAll("-", "_");
    const root = joinPath(dirOf(path), "src", "lib.rs");
    if (crate === undefined || !rust.has(root)) continue;
    claims.set(crate, [...(claims.get(crate) ?? []), root]);
  }
  const libs = new Map<string, string>();
  for (const [crate, roots] of claims) {
    const [only] = roots;
    if (roots.length === 1 && only !== undefined) libs.set(crate, only);
  }
  return { files: rust, packages, libs };
}

/** `P/tests`, `P/examples`, `P/benches` and `P/src/bin` of a package `P`. */
function isTargetDirectory(dir: string, crates: RustCrates): boolean {
  if (TARGET_DIRECTORIES.has(nameOf(dir))) return crates.packages.has(dirOf(dir));
  return (
    nameOf(dir) === "bin" && nameOf(dirOf(dir)) === "src" && crates.packages.has(dirOf(dirOf(dir)))
  );
}

/** Whether Cargo builds this file as the root of a crate, which then looks for its modules beside itself. */
function isCrateRoot(file: string, crates: RustCrates): boolean {
  const dir = dirOf(file);
  const name = nameOf(file);
  if (nameOf(dir) === "src" && (name === "lib.rs" || name === "main.rs")) return true;
  return (
    isTargetDirectory(dir, crates) || (name === "main.rs" && isTargetDirectory(dirOf(dir), crates))
  );
}

/** The crate roots that live directly in `dir`. */
function rootsIn(dir: string, crates: RustCrates): string[] {
  const candidates =
    nameOf(dir) === "src"
      ? ["lib.rs", "main.rs"]
      : isTargetDirectory(dirOf(dir), crates)
        ? ["main.rs"]
        : [];
  return candidates.map((name) => joinPath(dir, name)).filter((root) => crates.files.has(root));
}

/**
 * The roots a non-root `file` can belong to, found by walking up to the `src` (or `bin/x`) directory.
 * Under `tests/` and the like several crates share the directory, so which one it is stays unknown.
 */
function crateRootsOf(file: string, crates: RustCrates): string[] {
  if (isCrateRoot(file, crates)) return [file];
  for (let dir = dirOf(file); ; dir = dirOf(dir)) {
    if (isTargetDirectory(dir, crates)) return [];
    const roots = rootsIn(dir, crates);
    if (roots.length > 0 || dir === "") return roots;
  }
}

/**
 * A module as the walk of a path sees it: the file it lives in and the inline modules inside that file.
 * `ambiguous` is a crate root that `lib.rs` and `main.rs` both could be, until a path leaves it.
 */
type Place = {
  readonly file: string;
  readonly inline: readonly string[];
  readonly ambiguous: boolean;
};

/** The directory where the child modules of `place` have their files. */
function childDirectory(place: Place, crates: RustCrates): string {
  const { file } = place;
  const own =
    isCrateRoot(file, crates) || nameOf(file) === "mod.rs"
      ? dirOf(file)
      : joinPath(dirOf(file), nameOf(file).slice(0, -".rs".length));
  return joinPath(own, ...place.inline);
}

/** `name.rs` or `name/mod.rs` below `place`; nothing when neither exists or both do. */
function childModule(place: Place, name: string, crates: RustCrates): string | null {
  const dir = childDirectory(place, crates);
  const found = [joinPath(dir, `${name}.rs`), joinPath(dir, name, "mod.rs")].filter((file) =>
    crates.files.has(file),
  );
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** The module that holds `place`: the file that declares it, or the enclosing inline module. */
function parentOf(place: Place, crates: RustCrates): Place | null {
  if (place.inline.length > 0) {
    return { file: place.file, inline: place.inline.slice(0, -1), ambiguous: false };
  }
  const { file } = place;
  if (isCrateRoot(file, crates)) return null;
  const dir = dirOf(file);
  const slot = nameOf(file) === "mod.rs" ? dirOf(dir) : dir;
  if (isTargetDirectory(slot, crates)) return null;
  const plain = [
    joinPath(slot, "mod.rs"),
    slot === "" ? "" : joinPath(dirOf(slot), `${nameOf(slot)}.rs`),
  ].filter((candidate) => candidate !== "" && candidate !== file && crates.files.has(candidate));
  const roots = rootsIn(slot, crates);
  const [plainOne] = plain;
  if (plain.length === 1 && roots.length === 0 && plainOne !== undefined) {
    return { file: plainOne, inline: [], ambiguous: false };
  }
  const [root] = roots;
  if (plain.length === 0 && root !== undefined) {
    return { file: root, inline: [], ambiguous: roots.length > 1 };
  }
  return null;
}

type ModuleDeclaration = {
  readonly inline: readonly string[];
  readonly name: string;
  /** `mod name;` against `mod name { ... }`. */
  readonly external: boolean;
  /** The literal of a `#[path = "..."]` on it. */
  readonly path: string | null;
};

type UseDeclaration = {
  readonly inline: readonly string[];
  /** Every path the tree names, whole: `a::{b, c::d}` is `a::b` and `a::c::d`. */
  readonly leaves: readonly (readonly string[])[];
};

/** An attribute that starts at the `#` at `at`: its last token, and the literal when it is `path = "..."`. */
function attributeAt(
  tokens: readonly Token[],
  at: number,
): { readonly end: number; readonly path: string | null } | null {
  let open = at + 1;
  if (isPunct(tokens[open] ?? null, "!")) open += 1;
  if (!isPunct(tokens[open] ?? null, "[")) return null;
  let depth = 0;
  for (let index = open; index < tokens.length && index < open + MAX_ATTRIBUTE_TOKENS; index += 1) {
    const token = tokens[index] ?? null;
    if (isPunct(token, "[")) depth += 1;
    if (isPunct(token, "]")) depth -= 1;
    if (depth === 0) {
      const [name, equals, literal, ...rest] = tokens.slice(open + 1, index);
      const path =
        isWord(name ?? null, "path") &&
        isPunct(equals ?? null, "=") &&
        literal?.kind === "string" &&
        rest.length === 0
          ? literal.text
          : null;
      return { end: index, path };
    }
  }
  return null;
}

/**
 * The tree of a `use`, after the keyword. `end` is the first token it does not consume. A path that
 * `self` ends is the module before it, and a glob is the module it globs.
 */
function useTree(
  tokens: readonly Token[],
  start: number,
): { readonly leaves: string[][]; readonly end: number } {
  const leaves: string[][] = [];
  let at = start;
  const peek = (): Token | null => tokens[at] ?? null;

  function tree(prefix: readonly string[], depth: number): boolean {
    if (depth > MAX_USE_DEPTH) return false;
    const path = [...prefix];
    if (isPunct(peek(), "::")) at += 1;
    for (;;) {
      const token = peek();
      if (token?.kind === "ident") {
        path.push(token.text);
        at += 1;
        if (!isPunct(peek(), "::")) break;
        at += 1;
      } else if (isPunct(token, "*")) {
        at += 1;
        leaves.push(path);
        return true;
      } else if (isPunct(token, "{")) {
        at += 1;
        return group(path, depth);
      } else {
        break;
      }
    }
    if (path.length === prefix.length) return false;
    if (isWord(peek(), "as")) at += 2;
    if (path.length > 1 && path.at(-1) === "self") path.pop();
    leaves.push(path);
    return true;
  }

  function group(path: readonly string[], depth: number): boolean {
    for (;;) {
      if (isPunct(peek(), "}")) {
        at += 1;
        return true;
      }
      if (!tree(path, depth + 1)) return false;
      if (isPunct(peek(), ",")) at += 1;
      else if (!isPunct(peek(), "}")) return false;
    }
  }

  tree([], 0);
  if (isPunct(peek(), ";")) at += 1;
  return { leaves, end: at };
}

/** Every `mod` and `use` item, at any depth of inline modules, in the order they appear. */
function scanItems(content: string): {
  readonly modules: ModuleDeclaration[];
  readonly uses: UseDeclaration[];
} {
  const tokens = [...lex(content, RUST)];
  const modules: ModuleDeclaration[] = [];
  const uses: UseDeclaration[] = [];
  /** The inline modules around the current token; `null` is a block that is no module. */
  const frames: (string | null)[] = [];
  let pendingPath: string | null = null;

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === undefined) break;
    if (token.kind === "punct") {
      switch (token.text) {
        case "{":
          frames.push(null);
          pendingPath = null;
          break;
        case "}":
          frames.pop();
          pendingPath = null;
          break;
        case ";":
          pendingPath = null;
          break;
        case "#": {
          const attribute = attributeAt(tokens, at);
          if (attribute !== null) {
            pendingPath = attribute.path ?? pendingPath;
            at = attribute.end;
          }
          break;
        }
      }
    } else if (token.kind === "ident" && token.text === "mod") {
      const name = tokens[at + 1];
      const after = tokens[at + 2] ?? null;
      if (name?.kind !== "ident" || (!isPunct(after, ";") && !isPunct(after, "{"))) continue;
      const external = isPunct(after, ";");
      if (frames.every((frame) => frame !== null)) {
        modules.push({ inline: moduleNames(frames), name: name.text, external, path: pendingPath });
      }
      if (!external) frames.push(name.text);
      pendingPath = null;
      at += 2;
    } else if (token.kind === "ident" && token.text === "use") {
      const parsed = useTree(tokens, at + 1);
      if (parsed.leaves.length > 0)
        uses.push({ inline: moduleNames(frames), leaves: parsed.leaves });
      pendingPath = null;
      at = parsed.end - 1;
    }
  }
  return { modules, uses };
}

const moduleNames = (frames: readonly (string | null)[]): string[] =>
  frames.filter((frame) => frame !== null);

const declaredKey = (inline: readonly string[], name: string): string =>
  [...inline, name].join("/");

/** Where a path begins: the module it is relative to, and what is left of it to follow. */
function startOf(
  leaf: readonly string[],
  here: Place,
  declared: ReadonlySet<string>,
  crates: RustCrates,
): { readonly from: Place; readonly rest: readonly string[] } | null {
  const [first] = leaf;
  if (first === undefined) return null;
  if (first === "crate") {
    const roots = crateRootsOf(here.file, crates);
    const [root] = roots;
    if (root === undefined) return null;
    return { from: { file: root, inline: [], ambiguous: roots.length > 1 }, rest: leaf.slice(1) };
  }
  if (first === "self" || first === "super") {
    let place: Place = here;
    let at = 0;
    for (; at < leaf.length; at += 1) {
      const step = leaf[at];
      if (step === "super") {
        const parent = parentOf(place, crates);
        if (parent === null) return null;
        place = parent;
      } else if (step !== "self") {
        break;
      }
    }
    return { from: place, rest: leaf.slice(at) };
  }
  if (declared.has(declaredKey(here.inline, first))) return { from: here, rest: leaf };
  const lib = crates.libs.get(first);
  if (lib === undefined) return null;
  return { from: { file: lib, inline: [], ambiguous: false }, rest: leaf.slice(1) };
}

/** The file of the deepest module the path reaches; the items and inline modules after it live there. */
function followModules(from: Place, names: readonly string[], crates: RustCrates): string | null {
  let place = from;
  for (const name of names) {
    const child = childModule(place, name, crates);
    if (child === null) break;
    place = { file: child, inline: [], ambiguous: false };
  }
  return place.ambiguous ? null : place.file;
}

/** The file a `mod name;` declares. Only a plain `#[path]` outside inline modules is followed. */
function declaredFile(
  file: string,
  declaration: ModuleDeclaration,
  crates: RustCrates,
): string | null {
  if (declaration.path === null) {
    return childModule(
      { file, inline: declaration.inline, ambiguous: false },
      declaration.name,
      crates,
    );
  }
  if (declaration.inline.length > 0 || declaration.path.startsWith("/")) return null;
  const target = posix.normalize(joinPath(dirOf(file), declaration.path));
  return !target.startsWith("../") && crates.files.has(target) ? target : null;
}

/** The files `path` reaches through `mod` declarations and `use` paths. */
export function resolveRust(path: string, content: string, crates: RustCrates): string[] {
  const { modules, uses } = scanItems(content);
  const declared = new Set(modules.map(({ inline, name }) => declaredKey(inline, name)));
  const targets: (string | null)[] = modules
    .filter(({ external }) => external)
    .map((declaration) => declaredFile(path, declaration, crates));
  for (const { inline, leaves } of uses) {
    const here: Place = { file: path, inline, ambiguous: false };
    for (const leaf of leaves) {
      const start = startOf(leaf, here, declared, crates);
      if (start !== null) targets.push(followModules(start.from, start.rest, crates));
    }
  }
  return targets.filter((target) => target !== null);
}
