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

const login = {
  "src/login.ts": ts(
    "@state ログイン",
    "@state-initial",
    "@state-next パスワードリセット on:forgot",
  ),
  "src/reset.ts": ts("@state パスワードリセット", "@state-next Home on:reset_done"),
  "src/home.ts": ts("@state Home", "@state-next ログイン"),
};

const withProperties = (properties: unknown[]) => ({
  ...login,
  "everypath.properties.json": JSON.stringify({ properties }),
});

describe("everypath check", () => {
  it("exits 1 and prints the counterexample path for a never-reach violation", async () => {
    const root = await makeRepo(
      withProperties([
        { id: "no-reset-home", kind: "never-reach", description: "d", target: ["Home"] },
      ]),
    );
    const result = runCli(["check", root]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /no-reset-home/);
    assert.ok(
      result.stdout.includes("ログイン →(forgot) パスワードリセット →(reset_done) Home"),
      result.stdout,
    );
    const graph = await readGraph(root);
    assert.equal(graph.properties[0]?.result, "violated");
  });

  it("prints an event-less edge as a bare arrow", async () => {
    const root = await makeRepo({
      ...login,
      "everypath.properties.json": JSON.stringify({
        entry: ["Home"],
        properties: [{ id: "loop", kind: "invariant", expr: "state != ログイン" }],
      }),
    });
    const result = runCli(["check", root]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes("Home → ログイン"), result.stdout);
  });

  it("exits 0 when every property holds or waits for TLC", async () => {
    const root = await makeRepo(
      withProperties([
        { id: "nd", kind: "no-dead-end" },
        { id: "lt", kind: "leads-to", from: "state == Home", to: "state == ログイン" },
      ]),
    );
    const result = runCli(["check", root]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it("exits 1 when a property definition was rejected", async () => {
    const root = await makeRepo(withProperties([{ id: "bad", kind: "eventually" }]));
    assert.equal(runCli(["check", root]).status, 1);
  });

  it("says there are no properties and exits 0 without the file", async () => {
    const root = await makeRepo(login);
    const result = runCli(["check", root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /性質がありません/);
  });

  it("exits 2 for a missing directory", async () => {
    const root = await makeRepo(login);
    assert.equal(runCli(["check", join(root, "missing")]).status, 2);
  });
});
