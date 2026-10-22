import { posix } from "node:path";
import type { ParseResult, ScanWarning, StateName } from "./types.js";

/** One segment of a route. A parameter (`:id`) stands for any one non-empty segment. */
type Segment = { readonly kind: "literal"; readonly text: string } | { readonly kind: "param" };

/** A `@state-route` path. `path` is as written, less one trailing `/`. */
export type Route = { readonly path: string; readonly segments: readonly Segment[] };

/** A `@state-route` one file declares, with the state that file belongs to. */
export type RouteClaim = {
  readonly file: string;
  readonly line: number;
  readonly route: Route;
  readonly state: StateName;
};

export type RouteTable = {
  /** Routes without a parameter, by path. */
  readonly exact: ReadonlyMap<string, StateName>;
  readonly patterns: readonly {
    readonly segments: readonly Segment[];
    readonly state: StateName;
  }[];
};

const JS_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PARAM = /^:[A-Za-z_][A-Za-z0-9_]*$/;

/** One string literal with no escapes. A template literal never matches: its text is not known. */
const LITERAL = String.raw`(?:"([^"\\\n]*)"|'([^'\\\n]*)')`;
/**
 * SPEC §8.5. A call takes the literal as its whole first argument, so `push("/a" + id)` is not read.
 * `href=` with nothing between the name and `=` is an attribute, not an assignment to a variable.
 */
const NAVIGATION = new RegExp(
  [
    String.raw`\brouter\s*\.\s*(?:push|replace)\s*\(\s*${LITERAL}\s*[,)]`,
    String.raw`\bredirect\s*\(\s*(?:\d{3}\s*,\s*)?${LITERAL}\s*[,)]`,
    String.raw`\bnavigate\s*\(\s*${LITERAL}\s*[,)]`,
    String.raw`(?<![\w$.-])href=(?:${LITERAL}|\{\s*${LITERAL}\s*\})`,
  ].join("|"),
  "g",
);
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** The text after `@state-route`: `/` and segments, each a literal or `:name`. */
export function parseRoute(input: string): ParseResult<Route> {
  const fail = (column: number, message: string): ParseResult<Route> => ({
    ok: false,
    warning: { message, input, column },
  });
  if (!input.startsWith("/")) return fail(1, "パスは / で始めます");
  const forbidden = input.search(/[\s?#]/);
  if (forbidden >= 0) return fail(forbidden + 1, "パスに空白・?・# は書けません");
  const empty = input.indexOf("//");
  if (empty >= 0) return fail(empty + 2, "空のセグメントがあります");

  const path = withoutTrailingSlash(input);
  const segments: Segment[] = [];
  let column = 2;
  for (const text of segmentsOf(path)) {
    if (!text.startsWith(":")) segments.push({ kind: "literal", text });
    else if (PARAM.test(text)) segments.push({ kind: "param" });
    else return fail(column, ": の後には識別子を書きます");
    column += text.length + 1;
  }
  return { ok: true, value: { path, segments } };
}

/**
 * The paths `file` navigates to with a literal, without query and fragment. Only JS and TS files are
 * read, and a line that starts as a comment is skipped. URLs and paths starting with `//` are not routes.
 */
export function navigationPaths(file: string, content: string): string[] {
  if (!JS_EXTENSIONS.has(posix.extname(file))) return [];
  const paths = new Set<string>();
  for (const match of content.matchAll(NAVIGATION)) {
    const lineStart = content.lastIndexOf("\n", match.index) + 1;
    if (COMMENT_LINE.test(content.slice(lineStart, match.index))) continue;
    const literal = match.slice(1).find((group) => group !== undefined) ?? "";
    if (!literal.startsWith("/") || literal.startsWith("//")) continue;
    paths.add(withoutTrailingSlash(literal.replace(/[?#].*$/s, "")));
  }
  return [...paths].sort();
}

/**
 * Claims in file order. Parameter names do not tell routes apart, so `/users/:id` and `/users/:uid`
 * are one route; when two states claim one, the first file keeps it and the later one is warned.
 */
export function routeTable(claims: readonly RouteClaim[]): {
  readonly table: RouteTable;
  readonly warnings: readonly ScanWarning[];
} {
  const owners = new Map<string, RouteClaim>();
  const warnings: ScanWarning[] = [];
  for (const claim of claims) {
    const shape = claim.route.segments.map((s) => (s.kind === "param" ? ":" : s.text)).join("/");
    const first = owners.get(shape);
    if (first === undefined) {
      owners.set(shape, claim);
    } else if (first.state !== claim.state) {
      warnings.push({
        file: claim.file,
        line: claim.line,
        message: `@state-route ${claim.route.path} は ${first.file}:${first.line} の ${first.state} が先に使っています。先の宣言を使います`,
        detail: null,
      });
    }
  }
  const exact = new Map<string, StateName>();
  const patterns: { segments: readonly Segment[]; state: StateName }[] = [];
  for (const { route, state } of owners.values()) {
    if (route.segments.every((segment) => segment.kind === "literal")) exact.set(route.path, state);
    else patterns.push({ segments: route.segments, state });
  }
  return { table: { exact, patterns }, warnings };
}

/** An exact route first, else the one state whose patterns match. `null` when none or several do. */
export function resolveRoute(table: RouteTable, path: string): StateName | null {
  const exact = table.exact.get(path);
  if (exact !== undefined) return exact;
  const parts = segmentsOf(path);
  const fits = (segment: Segment, index: number): boolean => {
    const part = parts[index];
    if (part === undefined) return false;
    return segment.kind === "param" ? part !== "" : segment.text === part;
  };
  const states = new Set(
    table.patterns
      .filter(({ segments }) => segments.length === parts.length && segments.every(fits))
      .map(({ state }) => state),
  );
  const [only] = states;
  return states.size === 1 && only !== undefined ? only : null;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function segmentsOf(path: string): string[] {
  return path === "/" ? [] : path.slice(1).split("/");
}
