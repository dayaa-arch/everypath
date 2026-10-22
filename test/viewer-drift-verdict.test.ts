import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toMermaid } from "../src/core/mermaid.js";
import type { Graph, PropertyResult, TlcVerdict } from "../src/core/types.js";
import { initialState, reduce, replayOf } from "../src/ui/state.js";
import { headerCounts, tlcLines, toneOf } from "../src/ui/view.js";
import {
  counterexample,
  flow,
  graph,
  graphEvent,
  name,
  node,
  property,
  propertyId,
} from "./helpers/ui-fixtures.js";

const NO_LOCK = propertyId("no-lock");

function said(result: TlcVerdict["result"], stale = false): TlcVerdict {
  return {
    result,
    counterexamples: [],
    statesExplored: 47,
    checkedAt: "2026-10-22T05:00:00.000Z",
    ...(stale ? { staleModel: true } : {}),
  };
}

/** A quick-check never-reach on Login → Lock, and what TLC said about it, if anything. */
function noLock(tlc: TlcVerdict | null): PropertyResult {
  return {
    ...property("no-lock", "violated", [counterexample(["Login", "Lock"])]),
    kind: "never-reach",
    checkedBy: "bfs",
    statesExplored: 2,
    ...(tlc === null ? {} : { tlc }),
  };
}

function lockGraph(result: PropertyResult): Graph {
  return graph({
    nodes: [node("Login", { violations: [NO_LOCK] }), node("Lock", { violations: [NO_LOCK] })],
    edges: [flow("Login", "Lock", "login_fail")],
    properties: [result],
  });
}

function seen(result: PropertyResult) {
  const g = lockGraph(result);
  const state = reduce(reduce(initialState({}), { kind: "graph", event: graphEvent(g) }), {
    kind: "select",
    id: name("Login"),
    extend: false,
  });
  const login = g.nodes.find((n) => n.id === "Login");
  assert.ok(login !== undefined);
  return {
    tone: toneOf(login, g.properties),
    violated: headerCounts(g).violated,
    replaying: replayOf(state) !== null,
    marked: /^ {4}class \S+ violated$/m.test(toMermaid(g)),
  };
}

const COUNTED = { tone: "danger", violated: 1, replaying: true, marked: true };

describe("a path open only with guards ignored (docs/specs/viewer-drift.md condition 8)", () => {
  it("is not red, not counted, not replayed and not marked when TLC said ok on this model", () => {
    assert.deepEqual(seen(noLock(said("ok"))), {
      tone: "unreviewed",
      violated: 0,
      replaying: false,
      marked: false,
    });
  });

  for (const [what, tlc] of [
    ["no TLC verdict", null],
    ["TLC's ok on an older model", said("ok", true)],
    ["TLC's violation", said("violated")],
    ["TLC's error", said("error")],
  ] as const) {
    it(`stays a violation with ${what}`, () => {
      assert.deepEqual(seen(noLock(tlc)), COUNTED);
    });
  }
});

describe("the TLC lines of the detail panel (condition 8)", () => {
  it("names the path open only with guards ignored, and TLC's count", () => {
    const lines = tlcLines(noLock(said("ok"))).join("\n");

    assert.match(lines, /ガードを無視したときだけの経路/);
    assert.match(lines, /Login → Lock/);
    assert.match(lines, /47 状態/);
  });

  it("says a verdict is about an older model, and that TLC found the violation too", () => {
    assert.match(tlcLines(noLock(said("ok", true))).join("\n"), /古いモデル/);
    assert.doesNotMatch(
      tlcLines(noLock(said("ok", true))).join("\n"),
      /ガードを無視したときだけの経路/,
    );
    assert.match(tlcLines(noLock(said("violated"))).join("\n"), /違反/);
    assert.match(tlcLines(noLock(said("error"))).join("\n"), /エラー/);
  });

  it("has nothing to say without a TLC verdict", () => {
    assert.deepEqual(tlcLines(noLock(null)), []);
  });
});
