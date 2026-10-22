import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseStateName } from "../src/core/expr.js";
import {
  foldReview,
  parseRecordFile,
  planChange,
  REVIEW_DIRECTORY,
  type ReviewChange,
} from "../src/core/review.js";
import { analyze } from "../src/core/scan.js";

// Measures graft 3 of decision 0004 (docs/specs/team-review.md condition 8): the first scan of a
// process reads every approval record, a later one reads only the records it has not read.
// `tsx scripts/bench-review.ts [--records 5000] [--nodes 500] [--runs 5]` builds a repository whose
// nodes each carry a chain of approvals and revocations, then scans it in fresh processes.

const { values } = parseArgs({
  options: {
    records: { type: "string", default: "5000" },
    nodes: { type: "string", default: "500" },
    runs: { type: "string", default: "5" },
    measure: { type: "string" },
  },
});

/** Milliseconds of each call, in order. */
async function time(calls: number, call: () => Promise<unknown>): Promise<number[]> {
  const taken: number[] = [];
  for (let i = 0; i < calls; i++) {
    const start = performance.now();
    await call();
    taken.push(performance.now() - start);
  }
  return taken;
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

/** One fresh process: its first scan finds the cache empty, the next five find it full. */
async function measure(root: string): Promise<void> {
  const [cold = Number.NaN] = await time(1, () => analyze(root));
  const warm = await time(5, () => analyze(root));
  process.stdout.write(`${JSON.stringify({ cold, warm: median(warm) })}\n`);
}

/** `nodes` sources and `records` records: per node a chain where each record replaces the last. */
async function build(records: number, nodes: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everypath-bench-review-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, REVIEW_DIRECTORY), { recursive: true });
  for (let n = 0; n < nodes; n++) {
    await writeFile(join(root, "src", `n${n}.ts`), `// @state N${n}\n`);
  }
  const perNode = Math.ceil(records / nodes);
  let written = 0;
  for (let n = 0; n < nodes && written < records; n++) {
    const parsed = parseStateName(`N${n}`);
    if (!parsed.ok) throw new Error(`N${n} is not a state name`);
    let last: { readonly name: string; readonly text: string } | null = null;
    for (let k = 0; k < perNode && written < records; k++, written++) {
      const at = new Date(Date.UTC(2026, 9, 22, 0, 0, k)).toISOString();
      const change: ReviewChange =
        k % 2 === 0
          ? {
              kind: "approve",
              node: parsed.value,
              hash: `${k}`.padStart(40, "0"),
              at,
              by: "bench",
              note: "",
            }
          : { kind: "revoke", node: parsed.value, at, by: "bench" };
      const files = last === null ? [] : [parseRecordFile(last.name, last.text)];
      const planned = planChange(foldReview({ files, legacy: null }).state, change);
      if (planned === null) throw new Error(`record ${k} of N${n} changes nothing`);
      await writeFile(join(root, REVIEW_DIRECTORY, planned.name), planned.text);
      last = planned;
    }
  }
  return root;
}

async function main(): Promise<void> {
  if (values.measure !== undefined) return measure(values.measure);
  const records = Number(values.records);
  const nodes = Number(values.nodes);
  const runs = Number(values.runs);
  const withRecords = await build(records, nodes);
  const without = await build(0, nodes);
  try {
    const script = fileURLToPath(import.meta.url);
    const sample = (root: string): { cold: number; warm: number } => {
      const child = spawnSync(process.execPath, ["--import", "tsx", script, "--measure", root], {
        encoding: "utf8",
      });
      if (child.status !== 0) throw new Error(child.stderr);
      return JSON.parse(child.stdout);
    };
    const rows = [
      ["records", withRecords],
      ["no records", without],
    ] as const;
    process.stdout.write(`${records} records over ${nodes} nodes, ${runs} fresh processes each\n`);
    for (const [label, root] of rows) {
      const samples = Array.from({ length: runs }, () => sample(root));
      const cold = median(samples.map((s) => s.cold)).toFixed(0);
      const warm = median(samples.map((s) => s.warm)).toFixed(0);
      process.stdout.write(`${label}: first scan ${cold} ms, later scans ${warm} ms (medians)\n`);
    }
  } finally {
    await rm(withRecords, { recursive: true, force: true });
    await rm(without, { recursive: true, force: true });
  }
}

await main();
