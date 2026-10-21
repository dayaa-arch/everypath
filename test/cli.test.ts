import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeRepo, readGraph, runCli, ts } from "./helpers/repo.js";

const files = {
  "src/a.ts": ts("@state A", "@state-next B if:isValid(x)"),
  "src/b.ts": ts("@state B"),
};

describe("everypath scan", () => {
  it("exits 0 with warnings and writes graph.json", async () => {
    const root = await makeRepo(files);
    const result = runCli(["scan", root]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readGraph(root)).warnings.length, 1);
  });

  it("prints graph.json to stdout under --json", async () => {
    const root = await makeRepo(files);
    const result = runCli(["scan", root, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), await readGraph(root));
  });

  it("prints nothing under --quiet", async () => {
    const root = await makeRepo(files);
    const result = runCli(["scan", "--quiet", root]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("scans the current directory by default", async () => {
    const root = await makeRepo(files);
    const result = runCli(["scan", "--quiet"], root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readGraph(root)).nodes.length, 2);
  });

  it("exits 2 for a missing directory or an unknown command", async () => {
    const root = await makeRepo(files);
    assert.equal(runCli(["scan", join(root, "missing")]).status, 2);
    assert.equal(runCli(["bogus"]).status, 2);
  });
});
