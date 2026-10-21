import { posix } from "node:path";
import { asItems, asText, isRecord } from "./json.js";
import type { ScanWarning } from "./types.js";

export const CONFIG_FILE = "everypath.config.json";

/** `everypath.config.json` after validation. Unknown keys such as `colors` belong to the viewer. */
export type Config = {
  /** `[prefix, root-relative directory]`, longest prefix first. */
  readonly aliases: readonly (readonly [string, string])[];
  readonly includeTests: boolean;
  /** Where to look for findings before the default locations. */
  readonly findings: string | null;
  readonly ignore: readonly RegExp[];
};

export const DEFAULT_CONFIG: Config = {
  aliases: [],
  includeTests: false,
  findings: null,
  ignore: [],
};

const GLOB_TOKENS: ReadonlyMap<string, string> = new Map([
  ["**/", "(?:.*/)?"],
  ["**", ".*"],
  ["*", "[^/]*"],
  ["?", "[^/]"],
]);

/** `**` crosses directories, `*` and `?` stay inside one. The pattern is anchored at the root. */
function globToRegExp(glob: string): RegExp {
  const pattern = glob.replaceAll("\\", "/").replace(/^\.?\//, "");
  const source = pattern.replace(
    /\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g,
    (token) => GLOB_TOKENS.get(token) ?? `\\${token}`,
  );
  return new RegExp(`^${source}$`);
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

function globsOf(raw: unknown): RegExp[] | null {
  if (!Array.isArray(raw)) return null;
  const globs: RegExp[] = [];
  for (const item of asItems(raw)) {
    if (typeof item !== "string") return null;
    globs.push(globToRegExp(item));
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
  };
  return { config, warnings };
}
