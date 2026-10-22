import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hasFlow, launchServe, openEvents } from "./serve-client.js";

type CheckResult =
  | { kind: "ok"; detail?: string }
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

/** XML namespace names the SVG markup and its script carry. They identify a vocabulary and are never fetched. */
const NAMESPACE_URIS: ReadonlySet<string> = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
]);

const absoluteUrl = /https?:\/\/[^\s"'<>()\\]+/gi;
const protocolRelativeAttribute = /\b(?:src|href)\s*=\s*["']?\s*(\/\/[^\s"'<>]+)/gi;
const protocolRelativeUrlFunction = /url\(\s*["']?\s*(\/\/[^\s"')]+)/gi;

function findNetworkReferences(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(absoluteUrl)) {
    if (!NAMESPACE_URIS.has(match[0])) found.add(match[0]);
  }
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

const SAVES = 10;
const DEADLINE_MS = 2_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * R-05: a file added to a repository that `everypath serve` watches reaches an SSE client as a graph
 * event with its node and edge within 2 s. Ten saves, each timed from the write to the matching event.
 */
async function checkSaveReachesViewer(root: string): Promise<CheckResult> {
  const cli = join(root, "src", "cli.ts");
  if (!(await exists(cli))) return { kind: "skip", reason: "R-05 needs src/cli.ts" };

  const directory = await mkdtemp(join(tmpdir(), "everypath-r05-"));
  const source = (name: string) => join(directory, "src", name);
  const serving: { stop?: () => Promise<void>; close?: () => void } = {};
  try {
    await mkdir(join(directory, "src"));
    await writeFile(source("home.ts"), "// @state Home\n// @state-initial\n");
    const serve = await launchServe({ directory, cli });
    serving.stop = serve.stop;
    const events = await openEvents(serve.url);
    serving.close = events.close;
    await events.graph();

    const elapsed: number[] = [];
    for (let save = 1; save <= SAVES; save++) {
      const id = `R05_${save}`;
      const since = events.received.length;
      const started = performance.now();
      await writeFile(source(`r05-${save}.ts`), `// @state ${id}\n// @state-next Home\n`);
      await events.graph((graph) => hasFlow(graph, id, "Home"), {
        since,
        timeoutMs: DEADLINE_MS * 5,
      });
      elapsed.push(performance.now() - started);
    }
    const slowest = Math.max(...elapsed);
    if (slowest >= DEADLINE_MS) {
      return fail([
        `the slowest of ${SAVES} saves took ${Math.round(slowest)} ms (limit ${DEADLINE_MS} ms)`,
      ]);
    }
    return {
      kind: "ok",
      detail: `max ${Math.round(slowest)} ms of ${SAVES} saves, limit ${DEADLINE_MS} ms`,
    };
  } catch (error) {
    return fail([`could not measure: ${error instanceof Error ? error.message : String(error)}`]);
  } finally {
    serving.close?.();
    await serving.stop?.();
    await rm(directory, { recursive: true, force: true });
  }
}

const checks: readonly Check[] = [
  { id: "R-02", name: "no runtime dependencies", run: checkNoDependencies },
  { id: "R-02", name: "ui.html is offline", run: checkUiHasNoNetworkReferences },
  { id: "R-05", name: "a saved file reaches the viewer", run: checkSaveReachesViewer },
];

async function main(root: string, only: string | undefined): Promise<number> {
  const selected = only === undefined ? checks : checks.filter((check) => check.id === only);
  if (selected.length === 0) {
    console.error(`no check has the id ${only}`);
    return 2;
  }
  let failed = false;
  for (const check of selected) {
    const result = await check.run(root);
    switch (result.kind) {
      case "ok":
        console.log(
          `ok: ${check.id} ${check.name}${result.detail === undefined ? "" : ` (${result.detail})`}`,
        );
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

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { only: { type: "string" } },
});
process.exitCode = await main(resolve(positionals[0] ?? process.cwd()), values.only);
