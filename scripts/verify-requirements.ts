import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type CheckResult =
  | { kind: "ok" }
  | { kind: "skip"; reason: string }
  | { kind: "fail"; violations: readonly [string, ...string[]] };

type Check = {
  id: string;
  name: string;
  run: (root: string) => Promise<CheckResult>;
};

function fail(violations: string[]): CheckResult {
  const [first, ...rest] = violations;
  return first === undefined ? { kind: "ok" } : { kind: "fail", violations: [first, ...rest] };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function checkNoDependencies(root: string): Promise<CheckResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail([`package.json cannot be read: ${reason}`]);
  }
  if (!isRecord(parsed)) return fail(["package.json must be a JSON object"]);

  const dependencies = parsed.dependencies;
  if (dependencies === undefined) return { kind: "ok" };
  if (!isRecord(dependencies)) return fail(["package.json dependencies must be an object"]);

  return fail(
    Object.entries(dependencies).map(
      ([name, range]) => `dependencies must be empty but declares ${name}@${String(range)}`,
    ),
  );
}

const absoluteUrl = /https?:\/\/[^\s"'<>()\\]+/gi;
const protocolRelativeAttribute = /\b(?:src|href)\s*=\s*["']?\s*(\/\/[^\s"'<>]+)/gi;
const protocolRelativeUrlFunction = /url\(\s*["']?\s*(\/\/[^\s"')]+)/gi;

function findNetworkReferences(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(absoluteUrl)) found.add(match[0]);
  for (const pattern of [protocolRelativeAttribute, protocolRelativeUrlFunction]) {
    for (const match of html.matchAll(pattern)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return [...found];
}

async function checkUiHasNoNetworkReferences(root: string): Promise<CheckResult> {
  let html: string;
  try {
    html = await readFile(join(root, "dist", "ui.html"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return { kind: "skip", reason: "dist/ui.html not built" };
    throw error;
  }
  return fail(
    findNetworkReferences(html).map((reference) => `dist/ui.html references ${reference}`),
  );
}

const checks: readonly Check[] = [
  { id: "R-02", name: "no runtime dependencies", run: checkNoDependencies },
  { id: "R-02", name: "ui.html is offline", run: checkUiHasNoNetworkReferences },
];

async function main(root: string): Promise<number> {
  let failed = false;
  for (const check of checks) {
    const result = await check.run(root);
    switch (result.kind) {
      case "ok":
        console.log(`ok: ${check.id} ${check.name}`);
        break;
      case "skip":
        console.log(`skip: ${result.reason}`);
        break;
      case "fail":
        failed = true;
        for (const violation of result.violations) {
          console.error(`${check.id} ${check.name}: ${violation}`);
        }
        break;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }
  return failed ? 1 : 0;
}

process.exitCode = await main(resolve(process.argv[2] ?? process.cwd()));
