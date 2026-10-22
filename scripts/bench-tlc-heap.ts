import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyze } from "../src/core/scan.js";
import { exportTla } from "../src/core/tla/run.js";

// Measures the heap TLC needs (docs/specs/tlc-limits.md). `tsx scripts/bench-tlc-heap.ts
// [--models example,parent,grid] [--heaps none,3g,256m] [--children 140] [--terms 0] [--grid 499]`
// exports Model.tla for each model and runs TLC on it under every `-Xmx`, as `runTlc` does, printing
// one JSON line per run: the outcome, the wall time and the peak resident memory of the JVM.
// `example` is a copy of example/. `parent` is a parent with `children` children whose guarded
// self-loop gives children² arcs (140 is 19,740 arcs, near MAX_ARCS); `terms` more `|| n==k` in its
// guard grow Model.tla toward MAX_TLA_BYTES (10 is 8.06 MB). `grid` is one state with two counters
// 0..`grid`, few arcs and many states.

const { values } = parseArgs({
  options: {
    models: { type: "string", default: "example,parent" },
    heaps: { type: "string", default: "none,1024m,512m,256m,128m,64m,32m,16m" },
    children: { type: "string", default: "140" },
    terms: { type: "string", default: "0" },
    grid: { type: "string", default: "499" },
  },
});

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const jar = process.env.EVERYPATH_TLA_JAR ?? join(homedir(), ".everypath", "tla2tools.jar");

async function exampleCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everypath-heap-example-"));
  await cp(join(repoRoot, "example"), root, {
    recursive: true,
    filter: (path) => basename(path) !== ".everypath",
  });
  return root;
}

/** The arc explosion of docs/specs/hierarchy.md, kept under MAX_ARCS by the number of children. */
async function parentCopy(children: number, terms: number): Promise<string> {
  const longer = Array.from({ length: terms }, (_, index) => ` || n==${index % 3}`).join("");
  const root = await mkdtemp(join(tmpdir(), "everypath-heap-parent-"));
  const files: Record<string, string> = {
    "src/s.ts": "// @state S\n// @state-initial\n// @state-next P on:go\n",
    "src/p.ts": `// @state P\n// @state-var n: 0..3 = 0\n// @state-next P on:reset if:n<3${longer} set:n=n+1\n`,
    "everypath.properties.json": JSON.stringify({
      properties: [{ id: "n-small", kind: "invariant", expr: "n <= 3" }],
    }),
  };
  for (let index = 0; index < children; index++) {
    files[`src/c${index}.ts`] = `// @state C${index}\n// @state-parent P\n`;
  }
  return written(root, files);
}

/** (max + 1)² counter values times the events that led there. */
async function gridCopy(max: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everypath-heap-grid-"));
  const lines = [
    "@state G",
    "@state-initial",
    `@state-var a: 0..${max} = 0`,
    `@state-var b: 0..${max} = 0`,
    `@state-next G on:a_up if:a<${max} set:a=a+1`,
    "@state-next G on:a_down if:a>0 set:a=a-1",
    `@state-next G on:b_up if:b<${max} set:b=b+1`,
    "@state-next G on:b_down if:b>0 set:b=b-1",
  ];
  return written(root, {
    "src/g.ts": lines.map((line) => `// ${line}\n`).join(""),
    "everypath.properties.json": JSON.stringify({
      properties: [{ id: "a-bounded", kind: "invariant", expr: `a <= ${max}` }],
    }),
  });
}

async function written(root: string, files: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(join(root, "src"));
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  return root;
}

const RSS =
  platform() === "darwin"
    ? /(\d+)\s+maximum resident set size/
    : /Maximum resident set size \(kbytes\): (\d+)/;
const RSS_UNIT = platform() === "darwin" ? 1 : 1024;

function runOnce(directory: string, heap: string) {
  const metadir = join(directory, `meta-${heap}`);
  const java = [
    ...(heap === "none" ? [] : [`-Xmx${heap}`]),
    "-XX:+UseParallelGC",
    "-jar",
    jar,
    "-workers",
    "1",
    "-deadlock",
    "-config",
    "Model.cfg",
    "-metadir",
    metadir,
    "Model.tla",
  ];
  const timeFlag = platform() === "darwin" ? "-l" : "-v";
  const start = performance.now();
  const run = spawnSync("/usr/bin/time", [timeFlag, "java", ...java], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  const ms = Math.round(performance.now() - start);
  const output = `${run.stdout}\n${run.stderr}`;
  const rss = Number(RSS.exec(run.stderr)?.[1] ?? Number.NaN) * RSS_UNIT;
  const outcome = /OutOfMemoryError|ran out of memory/.test(output)
    ? `out of memory (exit ${run.status})`
    : /No error has been found/.test(output)
      ? "completed"
      : /is violated/.test(output)
        ? "violated"
        : `other (exit ${run.status}): ${/^Error: .*$/m.exec(output)?.[0] ?? ""}`;
  const states = [...output.matchAll(/([\d,]+) distinct states found/g)].at(-1)?.[1] ?? null;
  const heapLine = /with (\d+)MB heap/.exec(output)?.[1] ?? null;
  return {
    heap,
    outcome,
    ms,
    peakRssMb: Math.round(rss / 1024 / 1024),
    tlcHeapMb: heapLine === null ? null : Number(heapLine),
    states,
    outputBytes: Buffer.byteLength(output),
  };
}

const MODELS: Readonly<Record<string, () => { name: string; root: Promise<string> }>> = {
  example: () => ({ name: "example", root: exampleCopy() }),
  parent: () => ({
    name: `parent-${values.children}-terms-${values.terms}`,
    root: parentCopy(Number(values.children), Number(values.terms)),
  }),
  grid: () => ({ name: `grid-${values.grid}`, root: gridCopy(Number(values.grid)) }),
};

const heaps = values.heaps.split(",");
for (const model of values.models.split(",")) {
  const make = MODELS[model];
  if (make === undefined) throw new Error(`unknown model ${model}: ${Object.keys(MODELS)}`);
  const made = make();
  const { name } = made;
  const root = await made.root;
  const { flat } = await analyze(root);
  const exported = await exportTla(root);
  if (!exported.ok) throw new Error(`${name}: ${exported.reason}`);
  const directory = join(root, exported.directory);
  for (const heap of heaps) {
    const result = runOnce(directory, heap);
    const tlaBytes = (await stat(join(directory, "Model.tla"))).size;
    const facts = { model: name, arcs: flat.model.arcs.length, tlaBytes, ...result };
    process.stdout.write(`${JSON.stringify(facts)}\n`);
  }
  await rm(root, { recursive: true, force: true });
}
