import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProofEntry } from "../src/core/types.js";
import { makeRepo, node, readGraph, runCli, ts } from "./helpers/repo.js";

// docs/specs/proofs.md conditions 5 and 7, through the real CLI with a fake prover.

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** Passes when every file it gets is absolute and says PROVEN. Writes into its working directory. */
const PROVER = [
  "#!/bin/sh",
  'echo "made by the prover" > artifact.out',
  'for f in "$@"; do',
  '  case "$f" in /*) ;; *) echo "not absolute: $f"; exit 9;; esac',
  '  if ! grep -q PROVEN "$f"; then echo "obligation failed in $f"; exit 1; fi',
  "done",
  'echo "all proven"',
  "",
].join("\n");

const A = `${ts("@state A", "@state-require proof", "@state-spec ensures ok")}// PROVEN\n`;
const B = ts("@state B", "@state-require proof");
const C = ts("@state C");

const COMMAND_CONFIG = { proof: { tool: "command", command: "./prove.sh {files}" } };

async function proverRepo(
  files: Record<string, string>,
  config: unknown = COMMAND_CONFIG,
  script = PROVER,
): Promise<string> {
  const root = await makeRepo({
    "everypath.config.json": JSON.stringify(config),
    "prove.sh": script,
    ...files,
  });
  await chmod(join(root, "prove.sh"), 0o755);
  return root;
}

async function readProofs(root: string): Promise<Record<string, ProofEntry>> {
  return JSON.parse(await readFile(join(root, ".everypath", "proofs.json"), "utf8")) as Record<
    string,
    ProofEntry
  >;
}

async function outputs(root: string): Promise<string[]> {
  return (await readdir(join(root, ".everypath")).catch(() => [])).sort();
}

describe("everypath prove: a command prover", () => {
  it("runs each node that requires a proof and writes its verdict with the node's hash", async () => {
    const root = await proverRepo({ "src/a.ts": A, "src/b.ts": B, "src/c.ts": C });
    const started = Date.now();

    const result = runCli(["prove", root]);

    assert.equal(result.status, 1, result.stderr);
    const proofs = await readProofs(root);
    assert.deepEqual(Object.keys(proofs).sort(), ["A", "B"]);
    assert.equal(proofs.A?.result, "passed");
    assert.equal(proofs.A?.tool, "command");
    assert.equal(proofs.A?.hash, sha1(A));
    const at = Date.parse(proofs.A?.at ?? "");
    assert.ok(at >= started - 1000 && at <= Date.now() + 1000, proofs.A?.at);
    assert.equal(proofs.B?.result, "failed");
    assert.equal(proofs.B?.hash, sha1(B));
    assert.match(proofs.B?.message ?? "", /終了コード 1/);
    assert.match(proofs.B?.message ?? "", /obligation failed in src\/b\.ts/);
    assert.match(result.stdout, /成功 A/);
    assert.match(result.stdout, /失敗 B/);
    assert.deepEqual(await outputs(root), ["proofs.json"]);
  });

  it("shows on the next scan, and turns stale when the node's file changes", async () => {
    const root = await proverRepo({ "src/a.ts": A, "src/b.ts": B });
    runCli(["prove", root]);

    assert.equal(runCli(["scan", root]).status, 0);
    let graph = await readGraph(root);
    assert.equal(node(graph, "A").status.proof, "passed");
    assert.equal(node(graph, "B").status.proof, "failed");

    await writeFile(join(root, "src", "a.ts"), `${A}// changed\n`);
    assert.equal(runCli(["scan", root]).status, 0);
    graph = await readGraph(root);
    assert.equal(node(graph, "A").status.proof, "pending");
    assert.equal(node(graph, "A").proof?.stale, true);
  });

  it("exits 0 when every proof passes, and keeps the entries of other ids as they were", async () => {
    const other = {
      result: "passed",
      tool: "kani",
      message: "",
      at: "2026-10-01T00:00:00.000Z",
      hash: "x",
    };
    const root = await proverRepo({
      "src/a.ts": A,
      "src/c.ts": C,
      ".everypath/proofs.json": JSON.stringify({ Other: other }),
    });

    const result = runCli(["prove", root]);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const proofs = await readProofs(root);
    assert.deepEqual(proofs.Other, other);
    assert.equal(proofs.A?.result, "passed");
  });

  it("stops a prover that runs past --timeout and records it as failed", async () => {
    const slow = ["#!/bin/sh", "sleep 30", ""].join("\n");
    const root = await proverRepo({ "src/b.ts": B }, COMMAND_CONFIG, slow);
    const started = Date.now();

    const result = runCli(["prove", "--timeout", "1", root]);

    assert.equal(result.status, 1, result.stderr);
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
    const proofs = await readProofs(root);
    assert.equal(proofs.B?.result, "failed");
    assert.match(proofs.B?.message ?? "", /1 秒/);
  });

  it("refuses a --timeout that is not a positive whole number of seconds", async () => {
    const root = await proverRepo({ "src/b.ts": B });

    for (const timeout of ["0", "1.5", "soon"]) {
      assert.equal(runCli(["prove", "--timeout", timeout, root]).status, 2, timeout);
    }
  });
});

describe("everypath prove: nothing to run", () => {
  it("guides and writes nothing when the prover is not found", async () => {
    const root = await proverRepo(
      { "src/b.ts": B },
      { proof: { tool: "command", command: "no-such-prover-everypath {files}" } },
    );

    const result = runCli(["prove", root]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-such-prover-everypath/);
    assert.deepEqual(await outputs(root), []);
  });

  it("asks for the proof key and writes nothing without one", async () => {
    const root = await makeRepo({ "src/b.ts": B });

    const result = runCli(["prove", root]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /everypath\.config\.json/);
    assert.match(result.stderr, /proof/);
    assert.deepEqual(await outputs(root), []);
  });

  it("exits 0 and writes nothing when no node requires a proof", async () => {
    const root = await proverRepo({ "src/c.ts": C });

    const result = runCli(["prove", root]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await outputs(root), []);
  });
});

const FIXTURES = fileURLToPath(new URL("./fixtures/proofs/", import.meta.url));

describe("everypath prove: tool dafny, with a fake dafny that prints a quoted dafny verify output", () => {
  /** A `dafny` on the PATH that records its arguments and prints Bug73.dfy.expect with exit 4. */
  async function fakeDafny(): Promise<{ readonly env: NodeJS.ProcessEnv; readonly args: string }> {
    const quoted = await readFile(join(FIXTURES, "dafny", "assertions.txt"), "utf8");
    const output = quoted.slice(quoted.indexOf("\n---\n") + "\n---\n".length);
    const bin = await makeRepo({ "output.txt": output });
    const args = join(bin, "args.txt");
    const script = [
      "#!/bin/sh",
      `for a in "$@"; do echo "$a"; done > '${args}'`,
      `cat '${join(bin, "output.txt")}'`,
      "exit 4",
      "",
    ].join("\n");
    await writeFile(join(bin, "dafny"), script);
    await chmod(join(bin, "dafny"), 0o755);
    return { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }, args };
  }

  it("passes only the node's .dfy files to dafny verify and records the failed obligations", async () => {
    const dafny = await fakeDafny();
    const root = await makeRepo({
      "everypath.config.json": JSON.stringify({ proof: { tool: "dafny" } }),
      "src/pay.ts": ts("@state 決済", "@state-require proof"),
      "proofs/pay.dfy": ts("@state 決済"),
      "src/admin.ts": ts("@state 権限", "@state-require proof"),
    });

    const result = runCli(["prove", root], undefined, dafny.env);

    assert.equal(result.status, 1, result.stderr);
    const args = (await readFile(dafny.args, "utf8")).trim().split("\n");
    assert.deepEqual(args, ["verify", join(root, "proofs", "pay.dfy")]);
    const proofs = await readProofs(root);
    assert.deepEqual(Object.keys(proofs), ["決済"]);
    assert.equal(proofs.決済?.result, "failed");
    assert.equal(proofs.決済?.tool, "dafny");
    assert.equal(
      proofs.決済?.message,
      [
        "Bug73.dfy(7,13): Error: assertion could not be proved",
        "Bug73.dfy(13,13): Error: assertion could not be proved",
      ].join("\n"),
    );
    assert.match(result.stdout, /対象外 権限/);
    assert.match(result.stdout, /\.dfy/);
  });
});

describe("everypath check: nodes that require a proof", () => {
  async function provedRepo(): Promise<string> {
    const root = await proverRepo({ "src/a.ts": A, "src/b.ts": B, "src/c.ts": C });
    runCli(["prove", root]);
    return root;
  }

  it("lists the ones without a passed proof and keeps the exit code", async () => {
    const root = await provedRepo();
    const plain = await makeRepo({ "src/a.ts": A, "src/b.ts": B, "src/c.ts": C });

    const result = runCli(["check", root]);

    assert.equal(result.status, runCli(["check", plain]).status, result.stderr);
    assert.equal(result.status, 0, result.stdout);
    const lines = result.stdout.split("\n");
    assert.ok(
      lines.some((line) => /^ +失敗 B/.test(line)),
      result.stdout,
    );
    assert.ok(!lines.some((line) => /^ +\S+ A(（|$)/.test(line)), result.stdout);
    assert.ok(!lines.some((line) => /^ +\S+ C(（|$)/.test(line)), result.stdout);
  });

  it("exits 1 under --require-proof while one is missing, and 0 once every one passed", async () => {
    const root = await provedRepo();

    assert.equal(runCli(["check", "--require-proof", root]).status, 1);

    await writeFile(join(root, "src", "b.ts"), `${B}// PROVEN\n`);
    runCli(["prove", root]);
    const result = runCli(["check", "--require-proof", root]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("says nothing about proofs where no node requires one", async () => {
    const root = await makeRepo({ "src/c.ts": C });

    const result = runCli(["check", "--require-proof", root]);

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /証明/);
  });
});
