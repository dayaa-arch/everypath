import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import { isScanInput } from "../src/core/workspace.js";
import { makeRepo, node, ts } from "./helpers/repo.js";

// docs/specs/proofs.md conditions 2 and 3.

const PAY = ts("@state 決済", "@state-require proof", "@state-spec ensures paid => receipt");
const HOME = ts("@state Home");
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const AT = "2026-10-22T03:00:00.000Z";

function entry(result: string, hash: string, extra: Record<string, unknown> = {}) {
  return { result, tool: "dafny", message: `${result} の記録`, at: AT, hash, ...extra };
}

async function graphOf(files: Record<string, string>) {
  return (await analyze(await makeRepo(files))).graph;
}

const proofsFile = (entries: unknown): Record<string, string> => ({
  ".everypath/proofs.json": JSON.stringify(entries),
});

describe("proofs.json: a node's proof", () => {
  it("is the entry's result when the entry's hash is the node's hash", async () => {
    for (const result of ["passed", "failed", "pending"] as const) {
      const graph = await graphOf({
        "src/pay.ts": PAY,
        ...proofsFile({ 決済: entry(result, sha1(PAY)) }),
      });

      const pay = node(graph, "決済");
      assert.equal(pay.status.proof, result);
      assert.deepEqual(pay.proof, {
        result,
        tool: "dafny",
        message: `${result} の記録`,
        at: AT,
        stale: false,
      });
    }
  });

  it("is pending and keeps the old result as stale once the node's files changed", async () => {
    const graph = await graphOf({
      "src/pay.ts": PAY,
      ...proofsFile({ 決済: entry("passed", sha1("before the edit")) }),
    });

    const pay = node(graph, "決済");
    assert.equal(pay.status.proof, "pending");
    assert.equal(pay.proof?.result, "passed");
    assert.equal(pay.proof?.stale, true);
  });

  it("is none, with no proof key, for a node the file does not name", async () => {
    const graph = await graphOf({
      "src/pay.ts": PAY,
      "src/home.ts": HOME,
      ...proofsFile({ 決済: entry("passed", sha1(PAY)), 消えた状態: entry("passed", "x") }),
    });

    const home = node(graph, "Home");
    assert.equal(home.status.proof, "none");
    assert.equal("proof" in home, false);
    assert.equal(graph.warnings.length, 0, JSON.stringify(graph.warnings));
  });

  it("drops each malformed entry with a warning naming its id, and uses the others", async () => {
    const graph = await graphOf({
      "src/pay.ts": PAY,
      "src/home.ts": HOME,
      ...proofsFile({
        決済: entry("passed", sha1(PAY)),
        Home: entry("proved", sha1(HOME)),
        A: "passed",
        B: entry("passed", sha1(HOME), { hash: 7 }),
        C: entry("failed", sha1(HOME), { at: "yesterday" }),
        D: entry("failed", sha1(HOME), { tool: "" }),
        E: entry("failed", sha1(HOME), { message: null }),
      }),
    });

    assert.equal(node(graph, "決済").status.proof, "passed");
    assert.equal(node(graph, "Home").status.proof, "none");
    const warned = graph.warnings.filter((w) => w.file === ".everypath/proofs.json");
    assert.equal(warned.length, 6, JSON.stringify(graph.warnings));
    for (const id of ["Home", "A", "B", "C", "D", "E"]) {
      assert.ok(
        warned.some((w) => w.message.includes(`「${id}」`)),
        `${id} in ${warned.map((w) => w.message).join(" / ")}`,
      );
    }
  });

  it("gives one warning and no proofs for a file that is not JSON or not an object", async () => {
    for (const text of ["{ not json", "[1, 2]"]) {
      const graph = await graphOf({ "src/pay.ts": PAY, ".everypath/proofs.json": text });

      assert.equal(node(graph, "決済").status.proof, "none");
      const warned = graph.warnings.filter((w) => w.file === ".everypath/proofs.json");
      assert.equal(warned.length, 1, text);
    }
  });

  it("writes neither proof nor prover into graph.json without proofs.json and the proof key", async () => {
    const graph = await graphOf({ "src/pay.ts": PAY });

    assert.equal("prover" in graph, false);
    assert.equal(
      graph.nodes.some((n) => "proof" in n),
      false,
    );
    assert.equal(node(graph, "決済").status.requireProof, true);
    assert.equal(node(graph, "決済").status.proof, "none");
  });

  it("is a scan input, so serve rescans when it changes", () => {
    assert.equal(isScanInput(".everypath/proofs.json"), true);
    assert.equal(isScanInput(".everypath", true), true);
    assert.equal(isScanInput(".everypath/proofs.json.1234.tmp"), false);
  });

  it("puts a .dfy file with @state into the node, so its proof file joins the hash", async () => {
    const proof = ts("@state 決済");
    const graph = await graphOf({ "src/pay.ts": PAY, "proofs/pay.dfy": proof });

    const pay = node(graph, "決済");
    assert.deepEqual(pay.files, ["proofs/pay.dfy", "src/pay.ts"]);
    assert.equal(isScanInput("proofs/pay.dfy"), true);
  });
});

describe("everypath.config.json: proof", () => {
  const configOf = (proof: unknown): Record<string, string> => ({
    "src/pay.ts": PAY,
    "everypath.config.json": JSON.stringify({ proof }),
  });

  it("fills the command each tool runs by default", async () => {
    const defaults = { dafny: "dafny verify {files}", verus: "verus {files}" } as const;
    for (const [tool, command] of Object.entries(defaults)) {
      const graph = await graphOf(configOf({ tool }));

      assert.deepEqual(graph.prover, { tool, command });
      assert.equal(graph.warnings.length, 0, JSON.stringify(graph.warnings));
    }
  });

  it("keeps a command that is written", async () => {
    const graph = await graphOf(configOf({ tool: "command", command: "./prove.sh {files}" }));

    assert.deepEqual(graph.prover, { tool: "command", command: "./prove.sh {files}" });
  });

  it("warns and leaves prover out for an unknown tool, a missing command or a command that is not text", async () => {
    for (const proof of [
      { tool: "kani" },
      { tool: "command" },
      { tool: "dafny", command: ["dafny", "verify"] },
      { tool: "verus", command: "   " },
      "dafny",
    ]) {
      const graph = await graphOf(configOf(proof));

      assert.equal("prover" in graph, false, JSON.stringify(proof));
      const warned = graph.warnings.filter((w) => w.file === "everypath.config.json");
      assert.equal(warned.length, 1, JSON.stringify(proof));
      assert.match(warned[0]?.message ?? "", /proof/);
    }
  });
});
