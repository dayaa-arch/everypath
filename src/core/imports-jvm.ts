import {
  type Cursor,
  cursor,
  dirOf,
  isPunct,
  isWord,
  joinPath,
  lexer,
  type Syntax,
} from "./imports-common.js";

const JAVA: Syntax = { nestedComments: false, backtick: "punct", rust: false };
const KOTLIN: Syntax = { nestedComments: true, backtick: "identifier", rust: false };

const EXTENSIONS: readonly string[] = [".java", ".kt"];
/** A source set directory, and the module path (if any) before it. */
const SOURCE_SET = /^(?:(.*?)\/)?src\/(main|test)\/(?:java|kotlin)\//;
/** An import with more names than this is not resolved. Real packages stay far below it. */
const MAX_SEGMENTS = 32;

/**
 * Where classes of one source set are looked up from: `dir` is `<module>/src/main/java` and the like,
 * or `""` for a repository that keeps `com/x/Y.java` at its root, which belongs to no module.
 */
type Root = {
  readonly dir: string;
  readonly module: string | null;
  readonly set: "main" | "test";
};

export type JvmRoots = {
  readonly roots: readonly Root[];
  /** Every `.java` and `.kt` file. */
  readonly files: ReadonlySet<string>;
  /** The `.java` and `.kt` files directly in each directory, which is what a wildcard import names. */
  readonly directories: ReadonlyMap<string, readonly string[]>;
};

/** The source set a file lies in: its module (`""` when the set is at the repository root) and root directory. */
function sourceSetOf(
  file: string,
): { readonly module: string; readonly set: "main" | "test"; readonly dir: string } | null {
  const match = SOURCE_SET.exec(file);
  const set = match?.[2];
  if (match === null || (set !== "main" && set !== "test")) return null;
  return { module: match[1] ?? "", set, dir: match[0].slice(0, -1) };
}

export function jvmRoots(files: readonly string[]): JvmRoots {
  const sources = files.filter((file) => EXTENSIONS.some((extension) => file.endsWith(extension)));
  const roots = new Map<string, Root>([["", { dir: "", module: null, set: "main" }]]);
  const directories = new Map<string, string[]>();
  for (const file of sources) {
    const dir = dirOf(file);
    directories.set(dir, [...(directories.get(dir) ?? []), file]);
    const sourceSet = sourceSetOf(file);
    if (sourceSet !== null) roots.set(sourceSet.dir, sourceSet);
  }
  return { roots: [...roots.values()], files: new Set(sources), directories };
}

/**
 * The roots a file looks in, own module first. A main file sees main source sets only; a test file also
 * sees the test source set of its own module. A file outside any source set sees the repository root.
 */
function lookupTiers(file: string, jvm: JvmRoots): readonly (readonly Root[])[] {
  const origin = sourceSetOf(file) ?? { module: null, set: "main" };
  const visible = jvm.roots.filter(
    (root) =>
      root.set === "main" ||
      (origin.set === "test" && origin.module !== null && root.module === origin.module),
  );
  return [
    visible.filter((root) => root.module === origin.module),
    visible.filter((root) => root.module !== origin.module),
  ];
}

type JvmImport = { readonly segments: readonly string[]; readonly wildcard: boolean };

/** The files `path` imports. A class that two files in one tier both define is nobody's. */
export function resolveJvm(path: string, content: string, jvm: JvmRoots): string[] {
  const tiers = lookupTiers(path, jvm);
  const syntax = path.endsWith(".kt") ? KOTLIN : JAVA;
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const imported of jvmImports(content, syntax)) {
    const key = `${imported.segments.join(".")}${imported.wildcard ? ".*" : ""}`;
    if (seen.has(key) || imported.segments.length > MAX_SEGMENTS) continue;
    seen.add(key);
    targets.push(...resolveImport(imported, tiers, jvm));
  }
  return targets;
}

function resolveImport(
  { segments, wildcard }: JvmImport,
  tiers: readonly (readonly Root[])[],
  jvm: JvmRoots,
): string[] {
  const names = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  if (wildcard) {
    const directory = names.at(-1);
    for (const tier of tiers) {
      const found = tier.flatMap((root) =>
        directory === undefined ? [] : (jvm.directories.get(joinPath(root.dir, directory)) ?? []),
      );
      if (found.length > 0) return found;
    }
  }
  for (const tier of tiers) {
    for (let length = names.length; length >= 1; length -= 1) {
      const name = names[length - 1];
      const found = [
        ...new Set(
          tier.flatMap((root) =>
            EXTENSIONS.map((extension) => joinPath(root.dir, `${name}${extension}`)),
          ),
        ),
      ].filter((file) => jvm.files.has(file));
      if (found.length > 0) return found.length === 1 ? found : [];
    }
  }
  return [];
}

/** The imports of the file's head: after the package clause and the annotations on it, before any declaration. */
function jvmImports(content: string, syntax: Syntax): JvmImport[] {
  const tokens = cursor(lexer(content, syntax));
  const found: JvmImport[] = [];
  for (;;) {
    const token = tokens.peek();
    if (isPunct(token, ";")) {
      tokens.next();
    } else if (isPunct(token, "@")) {
      if (!skipAnnotation(tokens)) return found;
    } else if (isWord(token, "package")) {
      tokens.next();
      if (qualifiedName(tokens) === null) return found;
    } else if (isWord(token, "import")) {
      tokens.next();
      if (syntax === JAVA && isWord(tokens.peek(), "static")) tokens.next();
      const name = qualifiedName(tokens);
      if (name === null) return found;
      if (isWord(tokens.peek(), "as")) {
        tokens.next();
        tokens.next();
      }
      found.push(name);
    } else {
      return found;
    }
  }
}

/** `a.b.C` or `a.b.*`. Null when the tokens stop being a name. */
function qualifiedName(tokens: Cursor): JvmImport | null {
  const first = tokens.next();
  if (first?.kind !== "ident") return null;
  const segments = [first.text];
  while (isPunct(tokens.peek(), ".")) {
    tokens.next();
    const part = tokens.next();
    if (isPunct(part, "*")) return { segments, wildcard: true };
    if (part?.kind !== "ident") return null;
    segments.push(part.text);
  }
  return { segments, wildcard: false };
}

/** `@Name`, `@file:Name`, with its parenthesized or bracketed arguments. False when it does not close. */
function skipAnnotation(tokens: Cursor): boolean {
  tokens.next();
  if (tokens.next()?.kind !== "ident") return false;
  for (;;) {
    const token = tokens.peek();
    if (isPunct(token, ":") || isPunct(token, ".")) {
      tokens.next();
      if (isPunct(tokens.peek(), "[")) return skipBalanced(tokens, "[", "]");
      if (tokens.next()?.kind !== "ident") return false;
    } else if (isPunct(token, "(")) {
      return skipBalanced(tokens, "(", ")");
    } else {
      return true;
    }
  }
}

function skipBalanced(tokens: Cursor, open: string, close: string): boolean {
  let depth = 0;
  for (;;) {
    const token = tokens.next();
    if (token === null) return false;
    if (isPunct(token, open)) {
      depth += 1;
    } else if (isPunct(token, close)) {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
}
