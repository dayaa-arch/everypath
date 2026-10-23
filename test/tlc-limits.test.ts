import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG_FILE } from "../src/core/config.js";
import type { PropertyResult } from "../src/core/types.js";
import { readGraph, runCli, writeFiles } from "./helpers/repo.js";
import {
  exampleRepo,
  type FakeJavaScript,
  fakeJava,
  fixture,
  forExample,
  type Reply,
} from "./helpers/tlc.js";

// docs/specs/tlc-limits.md, through the real CLI with a fake `java` that logs its arguments.

const allHold = async (): Promise<FakeJavaScript> => ({
  rules: [],
  otherwise: { output: await fixture("ok") },
});

/** The first run, which checks every invariant, answers `first`; the rest hold. */
const firstRun = async (first: Reply): Promise<FakeJavaScript> => ({
  rules: [{ when: "INVARIANT P1_no_unauth_home", reply: first }],
  otherwise: { output: await fixture("ok") },
});

async function checkExample(script: FakeJavaScript, config?: unknown) {
  const root = await exampleRepo();
  if (config !== undefined) await writeFiles(root, { [CONFIG_FILE]: JSON.stringify(config) });
  const java = await fakeJava(script);
  const result = runCli(["check", "--tlc", root], root, java.env);
  return { root, java, result, calls: await java.calls() };
}

const heapsOf = (calls: readonly string[]): string[] =>
  calls.map((call) => /\s(-Xmx\S+) -XX:\+UseParallelGC -jar /.exec(call)?.[1] ?? `none in ${call}`);

function resultOf(properties: readonly PropertyResult[], id: string): PropertyResult {
  const found = properties.find((p) => p.id === id);
  assert.ok(found, `${id} in ${properties.map((p) => p.id)}`);
  return found;
}

describe("the heap TLC runs with (docs/specs/tlc-limits.md conditions 2 and 3)", () => {
  it("is 3g on every run of a repository without a setting", async () => {
    const { calls, result } = await checkExample(await allHold());

    assert.equal(result.status, 0, result.stdout);
    assert.equal(calls.length, 2);
    assert.deepEqual(heapsOf(calls), ["-Xmx3g", "-Xmx3g"]);
  });

  for (const [written, flag] of [
    ["6g", "-Xmx6g"],
    ["512m", "-Xmx512m"],
    ["2G", "-Xmx2g"],
  ] as const) {
    it(`is ${flag} for tla.maxHeap ${written}`, async () => {
      const { calls, result } = await checkExample(await allHold(), {
        tla: { maxHeap: written },
      });

      assert.equal(result.status, 0, result.stdout);
      assert.doesNotMatch(result.stderr, /maxHeap/);
      assert.deepEqual(heapsOf(calls), [flag, flag]);
    });
  }

  for (const tla of [
    { maxHeap: "3" },
    { maxHeap: "3gb" },
    { maxHeap: 3 },
    { maxHeap: "0g" },
    { maxHeap: "4m" },
    "x",
  ]) {
    it(`warns about ${JSON.stringify(tla)} and keeps 3g`, async () => {
      const { calls, result } = await checkExample(await allHold(), { tla });

      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stderr, /警告 everypath\.config\.json: .*tla.*maxHeap/);
      assert.deepEqual(heapsOf(calls), ["-Xmx3g", "-Xmx3g"]);
    });
  }

  it("lets a scan with a bad value finish", async () => {
    const root = await exampleRepo();
    await writeFiles(root, { [CONFIG_FILE]: JSON.stringify({ tla: { maxHeap: "lots" } }) });

    const result = runCli(["scan", root], root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /tla.*maxHeap/);
  });
});

describe("TLC's output (docs/specs/tlc-limits.md condition 4)", () => {
  it("reads the violation after 600 MB of progress lines", async () => {
    const violation = forExample(await fixture("violation"));
    const progress = {
      line: "Progress(3) at 2026-10-23 01:00:00: 9 states generated (9 s/min), 1 distinct states found, 0 states left on queue.",
      bytes: 600_000_000,
      where: "before",
    } as const;
    const { root, result } = await checkExample(
      await firstRun({ output: violation, exit: 12, noise: progress }),
    );

    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /Invalid string length|エラー:/);
    const violated = resultOf((await readGraph(root)).properties, "no-unauth-home");
    assert.equal(violated.result, "violated");
    assert.equal(violated.statesExplored, 25);
    assert.deepEqual(violated.counterexamples[0]?.path, ["ログイン", "パスワードリセット", "Home"]);
  });

  it("says it dropped the start when a trace outgrows what it keeps", async () => {
    const header = forExample(await fixture("violation")).split("State 2:")[0] ?? "";
    const trace = { line: "/\\ v1_authed = FALSE", bytes: 40_000_000, where: "after" } as const;
    const { root, result } = await checkExample(
      await firstRun({ output: header, exit: 12, noise: trace }),
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /エラー TLC: TLC の出力が.*先頭を捨て/);
    assert.equal(resultOf((await readGraph(root)).properties, "no-unauth-home").result, "error");
  });
});

describe("TLC out of memory (docs/specs/tlc-limits.md condition 5)", () => {
  const MEMORY =
    /エラー TLC: TLC のメモリが足りませんでした（Java のヒープの上限 (\S+)）.*tla\.maxHeap/;

  it("is an error for every TLC property, with how to raise the limit, after one run", async () => {
    const { root, java, result } = await checkExample(
      await firstRun({ output: await fixture("out-of-memory"), exit: 255 }),
    );

    assert.equal(result.status, 1);
    assert.equal(MEMORY.exec(result.stdout)?.[1], "3g", result.stdout);
    assert.equal((await java.cfgs()).length, 1);
    const graph = await readGraph(root);
    for (const id of ["no-unauth-home", "lock-after-3", "logout-eventually-login", "TypeOK"]) {
      assert.equal(resultOf(graph.properties, id).result, "error", id);
    }
  });

  it("names the configured limit", async () => {
    const { result } = await checkExample(
      await firstRun({ output: await fixture("out-of-memory"), exit: 255 }),
      { tla: { maxHeap: "512m" } },
    );

    assert.equal(MEMORY.exec(result.stdout)?.[1], "512m", result.stdout);
  });

  it("reads the JVM's own OutOfMemoryError the same way", async () => {
    const thrown = [
      'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space',
      "\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537)",
      "",
    ].join("\n");
    const { result } = await checkExample(await firstRun({ output: thrown, exit: 1 }));

    assert.equal(MEMORY.exec(result.stdout)?.[1], "3g", result.stdout);
  });
});
