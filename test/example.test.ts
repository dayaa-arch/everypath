import assert from "node:assert/strict";
import { cp, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseProperty } from "../src/core/expr.js";
import type { Graph } from "../src/core/types.js";
import { depPairs, flows, ids, makeRepo, runCli } from "./helpers/repo.js";

const example = fileURLToPath(new URL("../example", import.meta.url));

const bool = (value: boolean) => ({ kind: "bool", value });
const int = (value: number) => ({ kind: "int", value });
const cmp = (op: string, name: string, value: unknown) => ({ kind: "cmp", op, name, value });

/** Scans a copy so the run leaves `example/.everypath/` alone. */
async function scanExample(): Promise<Graph> {
  const root = await makeRepo({});
  await cp(example, root, { recursive: true, filter: (path) => basename(path) !== ".everypath" });
  const result = runCli(["scan", root, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Graph;
}

describe("example", () => {
  it("scans to the eight states with no warnings", async () => {
    const graph = await scanExample();

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(ids(graph), [
      "DB層",
      "Home",
      "パスワードリセット",
      "マイページ",
      "ログアウト",
      "ログイン",
      "ロック",
      "新規登録",
    ]);
    assert.equal(graph.model.initial, "ログイン");
    assert.deepEqual(graph.model.vars, [
      { kind: "boolean", name: "authed", init: false },
      { kind: "range", name: "retries", min: 0, max: 3, init: 0 },
    ]);
  });

  it("declares the flows with their events, guards and assignments", async () => {
    const graph = await scanExample();

    const actual = flows(graph).map(({ from, to, event, guard, set }) => ({
      from,
      to,
      event,
      guard,
      set,
    }));
    const flow = (from: string, to: string, event: string | null, guard = null as unknown) => ({
      from,
      to,
      event,
      guard,
      set: [] as unknown[],
    });
    assert.deepEqual(actual, [
      flow("Home", "マイページ", "open_mypage"),
      flow("パスワードリセット", "Home", "reset_done"),
      flow("パスワードリセット", "パスワードリセット", "code_invalid"),
      flow("パスワードリセット", "ログイン", "cancel"),
      flow("マイページ", "Home", "back"),
      {
        ...flow("マイページ", "ログアウト", "logout"),
        set: [{ target: "authed", value: bool(false) }],
      },
      flow("ログアウト", "ログイン", null),
      {
        ...flow("ログイン", "Home", "login_ok"),
        set: [
          { target: "authed", value: bool(true) },
          { target: "retries", value: int(0) },
        ],
      },
      flow("ログイン", "パスワードリセット", null),
      {
        ...flow("ログイン", "ログイン", "login_fail", cmp("<", "retries", int(3))),
        set: [{ target: "retries", value: { kind: "offset", of: "retries", delta: 1 } }],
      },
      flow("ログイン", "ロック", "login_fail", cmp("==", "retries", int(3))),
      flow("ログイン", "新規登録", null),
      flow("新規登録", "ログイン", "signup_done"),
    ]);
    assert.deepEqual(depPairs(graph), [
      "Home->DB層",
      "パスワードリセット->DB層",
      "マイページ->DB層",
      "ログイン->DB層",
      "新規登録->DB層",
    ]);
  });

  it("marks only the states the example test imports as tested", async () => {
    const graph = await scanExample();

    const tested = graph.nodes.filter((n) => n.status.tested).map((n) => n.id);
    assert.deepEqual(tested.sort(), ["Home", "ログイン", "新規登録"]);
  });

  it("ships the reset bug on line 42 and properties that parse", async () => {
    const reset = (await readFile(join(example, "src/auth/reset.ts"), "utf8")).split("\n");
    assert.equal(reset[41]?.trim(), 'return navigate("Home");');

    const config = JSON.parse(
      await readFile(join(example, "everypath.properties.json"), "utf8"),
    ) as { properties: { id: string; expr?: string; from?: string; to?: string }[] };
    assert.deepEqual(
      config.properties.map((p) => p.id),
      ["no-unauth-home", "lock-after-3", "logout-eventually-login", "no-dead-end"],
    );
    for (const p of config.properties) {
      for (const text of [p.expr, p.from, p.to]) {
        if (text !== undefined) assert.equal(parseProperty(text).ok, true, `${p.id}: ${text}`);
      }
    }
  });
});
