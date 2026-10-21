import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { DepEdge, FlowEdge, Graph, StateNode } from "../../src/core/types.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(repoRoot, "src", "cli.ts");
const tsx = import.meta.resolve("tsx");
const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Writes `files` (root-relative path to content) into a fresh temporary directory. */
export async function makeRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everypath-scan-"));
  roots.push(root);
  await writeFiles(root, files);
  return root;
}

export async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

export async function readGraph(root: string): Promise<Graph> {
  return JSON.parse(await readFile(join(root, ".everypath", "graph.json"), "utf8")) as Graph;
}

export function runCli(args: readonly string[], cwd = repoRoot, env = process.env) {
  const result = spawnSync(process.execPath, ["--import", tsx, cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** For tests that serve HTTP from this process: `spawnSync` would block the server. */
export function runCliAsync(
  args: readonly string[],
  cwd = repoRoot,
  env = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsx, cli, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

export function node(graph: Graph, id: string): StateNode {
  const found = graph.nodes.find((n) => n.id === id);
  if (found === undefined) {
    throw new Error(`node ${id} is missing; nodes are ${graph.nodes.map((n) => n.id).join(", ")}`);
  }
  return found;
}

export const ids = (graph: Graph): string[] => graph.nodes.map((n) => n.id).sort();

export const flows = (graph: Graph): FlowEdge[] =>
  graph.edges.filter((e): e is FlowEdge => e.type === "flow");

export const deps = (graph: Graph): DepEdge[] =>
  graph.edges.filter((e): e is DepEdge => e.type === "dep");

export const depPairs = (graph: Graph): string[] =>
  deps(graph)
    .map((e) => `${e.from}->${e.to}`)
    .sort();

/** Annotation lines joined as a `//` comment block. */
export const ts = (...lines: string[]): string => `${lines.map((l) => `// ${l}`).join("\n")}\n`;
