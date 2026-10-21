import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkProperties, PROPERTIES_FILE, parseProperties } from "../src/core/properties.js";
import { scan } from "../src/core/scan.js";
import type { Graph, PropertyResult } from "../src/core/types.js";
import { makeRepo, node, readGraph, ts } from "./helpers/repo.js";

const T1 = new Date("2026-10-21T00:00:00.000Z");

/** ログイン is initial. Edges leave ログイン in the order Home, パスワードリセット, ログイン. ロック is isolated. */
const LOGIN = {
  "src/login.ts": ts(
    "@state ログイン",
    "@state-initial",
    "@state-var authed: BOOLEAN = FALSE",
    "@state-next Home on:login_ok set:authed=TRUE",
    "@state-next パスワードリセット on:forgot",
    "@state-next ログイン on:login_fail",
  ),
  "src/reset.ts": ts("@state パスワードリセット", "@state-next Home on:reset_done"),
  "src/home.ts": ts("@state Home", "@state-next ログアウト on:logout"),
  "src/logout.ts": ts("@state ログアウト", "@state-next ログイン on:again"),
  "src/lock.ts": ts("@state ロック"),
};

/** P -> Q dead end, X <-> Y trap, S self-loop only, ロック isolated, 設定 planned. */
const TRAPS = {
  "src/login.ts": ts(
    "@state ログイン",
    "@state-initial",
    "@state-next Home on:go",
    "@state-next ログイン on:retry",
  ),
  "src/home.ts": ts("@state Home", "@state-next ログイン on:back", "@state-next 設定 on:settings"),
  "src/p.ts": ts("@state P", "@state-next Q"),
  "src/q.ts": ts("@state Q"),
  "src/x.ts": ts("@state X", "@state-next Y"),
  "src/y.ts": ts("@state Y", "@state-next X"),
  "src/s.ts": ts("@state S", "@state-next S"),
  "src/lock.ts": ts("@state ロック"),
};

async function check(files: Readonly<Record<string, string>>, properties: unknown): Promise<Graph> {
  const root = await makeRepo({
    ...files,
    [PROPERTIES_FILE]: typeof properties === "string" ? properties : JSON.stringify(properties),
  });
  return scan(root, { now: T1 });
}

function result(graph: Graph, id: string): PropertyResult {
  const found = graph.properties.find((p) => p.id === id);
  if (found === undefined) {
    throw new Error(`property ${id} is missing; have ${graph.properties.map((p) => p.id)}`);
  }
  return found;
}

const paths = (property: PropertyResult): string[][] =>
  property.counterexamples.map((c) => [...c.path]);

const events = (property: PropertyResult, index = 0): (string | null)[] =>
  (property.counterexamples[index]?.steps ?? []).map((s) => s.event);

const propertyWarnings = (graph: Graph) => graph.warnings.filter((w) => w.file === PROPERTIES_FILE);

describe("properties: reading everypath.properties.json", () => {
  it("lists every kind in file order with its checker, and leaves non-BFS ones pending", async () => {
    const root = await makeRepo({
      ...LOGIN,
      [PROPERTIES_FILE]: JSON.stringify({
        properties: [
          { id: "inv-states", kind: "invariant", description: "説明", expr: "state != ロック" },
          { id: "inv-vars", kind: "invariant", expr: "state == Home => authed" },
          { id: "lt", kind: "leads-to", from: "state == ログアウト", to: "state == ログイン" },
          { id: "nr", kind: "never-reach", target: ["ログアウト"] },
          { id: "ar", kind: "always-reach", target: ["ログイン"] },
          { id: "nd", kind: "no-dead-end", except: ["ロック"] },
          { id: "dov", kind: "dep-only-via", from_group: "画面", target: ["DB"], via: ["検証"] },
        ],
      }),
    });
    const graph = await scan(root, { now: T1 });

    assert.deepEqual(
      graph.properties.map((p) => [p.id, p.kind, p.checkedBy, p.result]),
      [
        ["inv-states", "invariant", "bfs", "ok"],
        ["inv-vars", "invariant", "tlc", "pending"],
        ["lt", "leads-to", "tlc", "pending"],
        ["nr", "never-reach", "bfs", "violated"],
        ["ar", "always-reach", "bfs", "violated"],
        ["nd", "no-dead-end", "bfs", "ok"],
        ["dov", "dep-only-via", "bfs", "pending"],
      ],
    );
    assert.equal(result(graph, "inv-states").description, "説明");
    assert.equal(result(graph, "nr").description, null);
    for (const property of graph.properties) {
      assert.equal(property.checkedAt, graph.generatedAt, property.id);
      if (property.result === "pending") {
        assert.deepEqual(property.counterexamples, [], property.id);
        assert.equal(property.statesExplored, null, property.id);
      } else {
        assert.ok((property.statesExplored ?? 0) > 0, property.id);
      }
    }
    const marked = graph.nodes.flatMap((n) => n.violations);
    for (const id of ["inv-vars", "lt", "dov"]) assert.ok(!marked.includes(id as never), id);
    assert.deepEqual(propertyWarnings(graph), []);
    assert.deepEqual((await readGraph(root)).properties, graph.properties);
  });

  it("drops each malformed definition with a warning and checks the rest", async () => {
    const graph = await check(LOGIN, {
      properties: [
        { kind: "no-dead-end" },
        { id: "dup", kind: "no-dead-end", except: ["ロック"] },
        { id: "dup", kind: "no-dead-end" },
        { id: "k", kind: "eventually" },
        { id: "e", kind: "invariant", expr: "state ==" },
        { id: "t1", kind: "never-reach", target: "Home" },
        { id: "t2", kind: "always-reach", target: [] },
        { id: "a", kind: "never-reach", target: ["Home"], avoid: [42] },
      ],
    });

    const warnings = propertyWarnings(graph);
    assert.equal(warnings.length, 7, JSON.stringify(warnings, null, 2));
    assert.deepEqual(
      graph.properties.map((p) => [p.id, p.result]),
      [["dup", "ok"]],
    );
    const exprWarning = warnings.find((w) => w.detail !== null);
    assert.equal(exprWarning?.detail?.input, "state ==");
  });

  it("turns a broken file or a missing properties array into one warning", async () => {
    for (const content of ["{", "{}"]) {
      const graph = await check(LOGIN, content);
      assert.equal(propertyWarnings(graph).length, 1, content);
      assert.deepEqual(graph.properties, [], content);
    }
  });

  it("writes no properties and no warning when the file is absent", async () => {
    const graph = await scan(await makeRepo(LOGIN), { now: T1 });
    assert.deepEqual(graph.properties, []);
    assert.deepEqual(propertyWarnings(graph), []);
  });

  it("warns about names that are not states but still checks the property", async () => {
    const graph = await check(LOGIN, {
      entry: ["Nobody", "ログイン"],
      properties: [
        { id: "u1", kind: "never-reach", target: ["Nowhere"] },
        { id: "u2", kind: "invariant", expr: "state != Ghost" },
        { id: "u3", kind: "no-dead-end", except: ["Phantom"] },
      ],
    });

    const messages = propertyWarnings(graph).map((w) => w.message);
    assert.equal(messages.length, 4, messages.join("\n"));
    for (const name of ["Nobody", "Nowhere", "Ghost", "Phantom"]) {
      assert.ok(
        messages.some((m) => m.includes(name)),
        `${name} in ${messages}`,
      );
    }
    assert.deepEqual(
      graph.properties.map((p) => [p.id, p.result]),
      [
        ["u1", "ok"],
        ["u2", "ok"],
        ["u3", "violated"],
      ],
    );
  });
});

describe("properties: entry states", () => {
  it("starts from entry when given", async () => {
    const graph = await check(LOGIN, {
      entry: ["Home"],
      properties: [{ id: "nr", kind: "never-reach", target: ["パスワードリセット"] }],
    });
    const nr = result(graph, "nr");
    assert.deepEqual(paths(nr), [["Home", "ログアウト", "ログイン", "パスワードリセット"]]);
    assert.deepEqual(events(nr), [null, "logout", "again", "forgot"]);
  });

  it("falls back to states with no incoming edge other than a self-loop", async () => {
    const graph = await check(
      {
        "src/c.ts": ts("@state C", "@state-next D"),
        "src/d.ts": ts("@state D", "@state-next D"),
        "src/e.ts": ts("@state E", "@state-next E"),
      },
      {
        properties: [
          { id: "nr", kind: "never-reach", target: ["D"] },
          { id: "inv", kind: "invariant", expr: "state != E" },
        ],
      },
    );
    assert.deepEqual(paths(result(graph, "nr")), [["C", "D"]]);
    assert.deepEqual(paths(result(graph, "inv")), [["E"]]);
    assert.deepEqual(propertyWarnings(graph), []);
  });

  it("warns when a property needs an entry and there is none", async () => {
    const cyclic = {
      "src/a.ts": ts("@state A", "@state-next B"),
      "src/b.ts": ts("@state B", "@state-next A"),
    };
    const graph = await check(cyclic, {
      properties: [{ id: "nr", kind: "never-reach", target: ["B"] }],
    });
    const warnings = propertyWarnings(graph);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]?.message ?? "", /入口/);
    assert.equal(result(graph, "nr").result, "ok");

    const noEntryNeeded = await check(cyclic, {
      properties: [{ id: "nd", kind: "no-dead-end" }],
    });
    assert.deepEqual(propertyWarnings(noEntryNeeded), []);
  });
});

describe("properties: never-reach", () => {
  it("reports the shortest path with its events and marks the nodes on it", async () => {
    const graph = await check(LOGIN, {
      properties: [{ id: "nr", kind: "never-reach", target: ["ログアウト"] }],
    });
    const nr = result(graph, "nr");
    assert.equal(nr.result, "violated");
    assert.deepEqual(paths(nr), [["ログイン", "Home", "ログアウト"]]);
    assert.deepEqual(events(nr), [null, "login_ok", "logout"]);
    assert.deepEqual(
      nr.counterexamples[0]?.steps.map((s) => s.state),
      nr.counterexamples[0]?.path,
    );
    for (const id of ["ログイン", "Home", "ログアウト"]) {
      assert.deepEqual(node(graph, id).violations, ["nr"], id);
    }
    for (const id of ["パスワードリセット", "ロック"]) {
      assert.deepEqual(node(graph, id).violations, [], id);
    }
  });

  it("removes avoid states from the graph before searching", async () => {
    const graph = await check(LOGIN, {
      properties: [
        { id: "via-home", kind: "never-reach", target: ["ログアウト"], avoid: ["Home"] },
        { id: "unreachable", kind: "never-reach", target: ["ロック"] },
      ],
    });
    assert.equal(result(graph, "via-home").result, "ok");
    assert.equal(result(graph, "unreachable").result, "ok");
    assert.ok(graph.nodes.every((n) => n.violations.length === 0));
  });
});

describe("properties: always-reach", () => {
  it("gives each stuck non-planned state a path to its nearest dead end", async () => {
    const graph = await check(TRAPS, {
      properties: [
        { id: "home", kind: "always-reach", target: ["ログイン"] },
        { id: "two", kind: "always-reach", target: ["ログイン", "Q"] },
      ],
    });
    const home = result(graph, "home");
    assert.equal(home.result, "violated");
    assert.deepEqual(paths(home), [["P", "Q"], ["Q"], ["S"], ["X"], ["Y"], ["ロック"]]);
    assert.deepEqual(paths(result(graph, "two")), [["S"], ["X"], ["Y"], ["ロック"]]);
    assert.deepEqual(node(graph, "P").violations, ["home"]);
    assert.deepEqual(node(graph, "設定").violations, []);
  });
});

describe("properties: no-dead-end", () => {
  it("reports states without outgoing edges, skipping except and planned, counting self-loops", async () => {
    const graph = await check(TRAPS, {
      properties: [
        { id: "all", kind: "no-dead-end" },
        { id: "except", kind: "no-dead-end", except: ["ロック"] },
      ],
    });
    assert.deepEqual(paths(result(graph, "all")), [["Q"], ["ロック"]]);
    assert.deepEqual(paths(result(graph, "except")), [["Q"]]);
    assert.deepEqual(node(graph, "Q").violations, ["all", "except"]);
    assert.deepEqual(node(graph, "ロック").violations, ["all"]);
  });
});

describe("properties: variable-free invariant", () => {
  it("evaluates the state predicate on reachable states and reports the shortest path", async () => {
    const graph = await check(LOGIN, {
      properties: [
        { id: "or", kind: "invariant", expr: "state == Home || state == ログイン" },
        { id: "not-logout", kind: "invariant", expr: "state != ログアウト" },
        {
          id: "in",
          kind: "invariant",
          expr: "state in {ログイン, Home, パスワードリセット, ログアウト}",
        },
        { id: "implies", kind: "invariant", expr: "state == Home => !(state == ログイン)" },
        { id: "and", kind: "invariant", expr: "!(state == Home && state == ログイン)" },
      ],
    });
    const or = result(graph, "or");
    assert.deepEqual(paths(or), [["ログイン", "パスワードリセット"]]);
    assert.deepEqual(events(or), [null, "forgot"]);
    assert.deepEqual(paths(result(graph, "not-logout")), [["ログイン", "Home", "ログアウト"]]);
    for (const id of ["in", "implies", "and"]) assert.equal(result(graph, id).result, "ok", id);
  });
});

describe("properties: speed", () => {
  it("checks four BFS properties on 1,000 nodes and 5,000 edges within one second", async () => {
    const size = 1000;
    const files: Record<string, string> = {};
    for (let i = 0; i < size; i += 1) {
      const targets = [i + 1, i * 7 + 3, i * 13 + 5, i * 31 + 7, i * 97 + 11].map((t) => t % size);
      files[`src/n${i}.ts`] = ts(
        `@state N${i}`,
        ...(i === 0 ? ["@state-initial"] : []),
        ...targets.map((t, k) => `@state-next N${t} on:e${k}`),
      );
    }
    const graph = await scan(await makeRepo(files), { now: T1 });
    assert.equal(graph.nodes.length, size);
    assert.equal(graph.edges.length, size * 5);
    const { file, warnings } = parseProperties({
      properties: [
        { id: "nr", kind: "never-reach", target: ["N999"], avoid: ["N500"] },
        { id: "ar", kind: "always-reach", target: ["N0"] },
        { id: "nd", kind: "no-dead-end" },
        { id: "inv", kind: "invariant", expr: "state != N998" },
      ],
    });
    assert.deepEqual(warnings, []);

    const started = performance.now();
    const checked = checkProperties(graph, file, graph.generatedAt);
    const elapsed = performance.now() - started;

    assert.equal(checked.properties.length, 4);
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  });
});
