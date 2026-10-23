import { posix } from "node:path";
import { asItems, asText, isRecord } from "./json.js";
import type { ProofTool, Prover, ScanWarning } from "./types.js";

export const CONFIG_FILE = "everypath.config.json";

/** `everypath.config.json` after validation. Unknown keys such as `colors` belong to the viewer. */
export type Config = {
  /** `[prefix, root-relative directory]`, longest prefix first. */
  readonly aliases: readonly (readonly [string, string])[];
  readonly includeTests: boolean;
  /** Where to look for findings before the default locations. */
  readonly findings: string | null;
  readonly ignore: readonly Glob[];
  /** What `everypath prove` runs, or `null` when the key is absent or unusable. */
  readonly proof: Prover | null;
  /** `tla.maxHeap`: TLC's `-Xmx`, in megabytes. */
  readonly tla: { readonly maxHeapMb: number };
};

/** A compiled `ignore` pattern, tested against a root-relative `/` path. */
export type Glob = { readonly test: (path: string) => boolean };

/**
 * 3g: the largest Model.tla `generateTla` makes (`MAX_ARCS` arcs, `MAX_TLA_BYTES` of text) ran out
 * of memory at 1536m and ran as fast as under the JVM's default from 2560m. The number of states
 * barely matters: TLC keeps them on disk. Measured by `scripts/bench-tlc-heap.ts`, in
 * docs/specs/tlc-limits.md.
 */
const DEFAULT_TLA: Config["tla"] = { maxHeapMb: 3 * 1024 };

/** The JVM does not start under `-Xmx1m` and rounds anything below about 8 MB up to it. */
const MIN_HEAP_MB = 8;

export const DEFAULT_CONFIG: Config = {
  aliases: [],
  includeTests: false,
  findings: null,
  ignore: [],
  proof: null,
  tla: DEFAULT_TLA,
};

/** A heap size as `-Xmx` and `tla.maxHeap` write it: whole gigabytes as `g`, else megabytes. */
export function heapText(megabytes: number): string {
  return megabytes % 1024 === 0 ? `${megabytes / 1024}g` : `${megabytes}m`;
}

/** `"3g"` or `"512m"`, either case, at least `MIN_HEAP_MB`. */
function heapOf(raw: unknown): number | null {
  const match = typeof raw === "string" ? /^([1-9]\d*)([mg])$/i.exec(raw) : null;
  if (match === null) return null;
  const [, digits = "", unit = ""] = match;
  const megabytes = Number(digits) * (unit.toLowerCase() === "g" ? 1024 : 1);
  return Number.isSafeInteger(megabytes) && megabytes >= MIN_HEAP_MB ? megabytes : null;
}

function tlaOf(raw: unknown): Config["tla"] | null {
  if (!isRecord(raw)) return null;
  if (raw.maxHeap === undefined) return DEFAULT_TLA;
  const maxHeapMb = heapOf(raw.maxHeap);
  return maxHeapMb === null ? null : { maxHeapMb };
}

/** The command of each tool when `proof.command` is left out. `command` has none: it must be written. */
const DEFAULT_COMMANDS: Readonly<Record<ProofTool, string | null>> = {
  dafny: "dafny verify {files}",
  verus: "verus {files}",
  command: null,
};

const isProofTool = (raw: unknown): raw is ProofTool =>
  typeof raw === "string" && Object.hasOwn(DEFAULT_COMMANDS, raw);

function proverOf(raw: unknown): Prover | null {
  if (!isRecord(raw) || !isProofTool(raw.tool)) return null;
  const written = raw.command === undefined ? DEFAULT_COMMANDS[raw.tool] : asText(raw.command);
  const command = written?.trim() ?? "";
  return command === "" ? null : { tool: raw.tool, command };
}

/**
 * `dirs` is `**` and a slash: no directory or any run of them. `globstar` is a bare `**`, any run of
 * characters. `star` and `one` (`*`, `?`) stay inside one name. A repeated `dirs` is kept once.
 */
type GlobToken =
  | { readonly kind: "char"; readonly char: string }
  | { readonly kind: "one" }
  | { readonly kind: "star" }
  | { readonly kind: "globstar" }
  | { readonly kind: "dirs" };

function tokenize(glob: string): GlobToken[] {
  const pattern = glob.replaceAll("\\", "/").replace(/^\.?\//, "");
  const tokens: GlobToken[] = [];
  for (let at = 0; at < pattern.length; ) {
    if (pattern.startsWith("**/", at)) {
      if (tokens.at(-1)?.kind !== "dirs") tokens.push({ kind: "dirs" });
      at += 3;
    } else if (pattern.startsWith("**", at)) {
      tokens.push({ kind: "globstar" });
      at += 2;
    } else {
      const char = pattern.charAt(at);
      tokens.push(
        char === "*" ? { kind: "star" } : char === "?" ? { kind: "one" } : { kind: "char", char },
      );
      at += 1;
    }
  }
  return tokens;
}

/**
 * Whether the whole of `path` matches, anchored at the root. A table over (token, position) filled
 * from the end, so the time is the pattern length times the path length for any pattern: a
 * backtracking regex takes minutes on ten `dirs` in a row against a deep path.
 */
function matches(tokens: readonly GlobToken[], path: string): boolean {
  const on = (table: Uint8Array, at: number): boolean => table[at] === 1;
  const n = path.length;
  /** `rest[p]`: the tokens after the current one match `path` from `p`. */
  let rest = new Uint8Array(n + 1);
  rest[n] = 1;
  for (const token of tokens.toReversed()) {
    const here = new Uint8Array(n + 1);
    /** For `dirs`: a `/` at or after `p` closes the directories and the rest matches after it. */
    const closes = new Uint8Array(n + 1);
    for (let p = n; p >= 0; p--) {
      const char = p < n ? path.charAt(p) : null;
      const inName = char !== null && char !== "/";
      let match: boolean;
      switch (token.kind) {
        case "char":
          match = char === token.char && on(rest, p + 1);
          break;
        case "one":
          match = inName && on(rest, p + 1);
          break;
        case "star":
          match = on(rest, p) || (inName && on(here, p + 1));
          break;
        case "globstar":
          match = on(rest, p) || (char !== null && on(here, p + 1));
          break;
        case "dirs":
          closes[p] = (char === "/" && on(rest, p + 1)) || on(closes, p + 1) ? 1 : 0;
          match = on(rest, p) || on(closes, p);
          break;
      }
      here[p] = match ? 1 : 0;
    }
    rest = here;
  }
  return on(rest, 0);
}

function compileGlob(glob: string): Glob {
  const tokens = tokenize(glob);
  return { test: (path) => matches(tokens, path) };
}

function aliasesOf(raw: unknown): [string, string][] | null {
  if (!isRecord(raw)) return null;
  const pairs: [string, string][] = [];
  for (const [prefix, target] of Object.entries(raw)) {
    if (typeof target !== "string") return null;
    pairs.push([prefix.replace(/\/$/, ""), posix.normalize(target)]);
  }
  return pairs.sort(([a], [b]) => b.length - a.length);
}

function globsOf(raw: unknown): Glob[] | null {
  if (!Array.isArray(raw)) return null;
  const globs: Glob[] = [];
  for (const item of asItems(raw)) {
    if (typeof item !== "string") return null;
    globs.push(compileGlob(item));
  }
  return globs;
}

/** The config is a boundary: each wrong-typed key becomes a warning and keeps its default. */
export function parseConfig(value: unknown): {
  readonly config: Config;
  readonly warnings: readonly ScanWarning[];
} {
  const warnings: ScanWarning[] = [];
  const reject = (key: string, expected: string): void => {
    warnings.push({
      file: CONFIG_FILE,
      line: null,
      message: `${CONFIG_FILE} の ${key} は ${expected} にしてください。既定値を使います`,
      detail: null,
    });
  };
  if (!isRecord(value)) {
    reject("全体", "JSON オブジェクト");
    return { config: DEFAULT_CONFIG, warnings };
  }
  const read = <T>(
    key: string,
    expected: string,
    parse: (raw: unknown) => T | null,
    fallback: T,
  ): T => {
    const raw = value[key];
    if (raw === undefined) return fallback;
    const parsed = parse(raw);
    if (parsed === null) reject(key, expected);
    return parsed ?? fallback;
  };

  const config: Config = {
    aliases: read("aliases", "「接頭辞: ディレクトリ」の文字列の組", aliasesOf, []),
    includeTests: read(
      "includeTests",
      "true か false",
      (raw) => (typeof raw === "boolean" ? raw : null),
      false,
    ),
    findings: read("findings", "ファイルのパス（文字列）", asText, null),
    ignore: read("ignore", "glob の配列（文字列）", globsOf, []),
    proof: read(
      "proof",
      '{"tool": "dafny" か "verus" か "command", "command": "{files} を含む命令"}（tool が command なら command は必須）',
      proverOf,
      null,
    ),
    tla: read(
      "tla",
      `{"maxHeap": "6g"} の形（maxHeap は ${MIN_HEAP_MB}m 以上の整数に m か g を付けた、TLC の Java のヒープの上限）`,
      tlaOf,
      DEFAULT_TLA,
    ),
  };
  return { config, warnings };
}
