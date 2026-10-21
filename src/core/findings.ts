import { isAbsolute, posix, relative } from "node:path";
import { asInteger, asItems, asText, isRecord } from "./json.js";
import type { Finding } from "./types.js";

const SEVERITIES: ReadonlyMap<string, Finding["severity"]> = new Map([
  ["ERROR", "high"],
  ["HIGH", "high"],
  ["CRITICAL", "high"],
  ["WARNING", "medium"],
  ["MEDIUM", "medium"],
  ["INFO", "low"],
  ["LOW", "low"],
]);

export type ParsedFindings = {
  readonly findings: readonly Finding[];
  /** Entries of `results` that named no file or were not objects. */
  readonly skipped: number;
};

/**
 * semgrep (`path`, `check_id`, `extra.message`, `extra.severity`, `start.line`) and bandit
 * (`filename`, `test_id`, `issue_text`, `issue_severity`, `line_number`) share one `results` array,
 * so one entry is read by whichever of the two field sets it has.
 */
export function parseFindings(value: unknown, root: string): ParsedFindings | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null;
  const findings: Finding[] = [];
  let skipped = 0;
  for (const item of asItems(value.results)) {
    const finding = normalize(item, root);
    if (finding === null) skipped += 1;
    else findings.push(finding);
  }
  return { findings, skipped };
}

function normalize(item: unknown, root: string): Finding | null {
  if (!isRecord(item)) return null;
  const file = rootRelative(asText(item.path) ?? asText(item.filename), root);
  if (file === null) return null;
  const extra: Record<string, unknown> = isRecord(item.extra) ? item.extra : {};
  const start: Record<string, unknown> = isRecord(item.start) ? item.start : {};
  const severity = asText(extra.severity) ?? asText(item.issue_severity) ?? "";
  return {
    file,
    line: asInteger(start.line) ?? asInteger(item.line_number),
    severity: SEVERITIES.get(severity.toUpperCase()) ?? "medium",
    rule: asText(item.check_id) ?? asText(item.test_id) ?? "",
    message: asText(extra.message) ?? asText(item.issue_text) ?? "",
  };
}

/** `./src/a.ts` and absolute paths both become `src/a.ts`. A path outside the root is `null`. */
export function rootRelative(raw: string | null, root: string): string | null {
  if (raw === null || raw === "") return null;
  const inRoot = isAbsolute(raw) ? relative(root, raw) : raw;
  const path = posix.normalize(inRoot.replaceAll("\\", "/"));
  return path === ".." || path.startsWith("../") || posix.isAbsolute(path) ? null : path;
}
