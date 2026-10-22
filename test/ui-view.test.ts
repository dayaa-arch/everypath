import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { headerCounts, stepEvent } from "../src/ui/view.js";
import { counterexample, graph, node, property, propertyId } from "./helpers/ui-fixtures.js";

describe("header counts (SPEC §12)", () => {
  it("counts 脆弱性 from scanner findings, not from every red box", () => {
    const g = graph({
      nodes: [
        node("A", { status: { vuln: true } }),
        node("B", { violations: [propertyId("p")] }),
        node("C", { status: { reviewed: true } }),
      ],
      properties: [property("p", "violated", [counterexample(["B", "C"])])],
    });

    assert.deepEqual(headerCounts(g), { nodes: 3, unreviewed: 2, vulnerable: 1, violated: 1 });
  });

  it("does not count a stale violation", () => {
    const g = graph({
      nodes: [node("A")],
      properties: [property("p", "violated", [counterexample(["A"])], { stale: true })],
    });

    assert.deepEqual(headerCounts(g), { nodes: 1, unreviewed: 1, vulnerable: 0, violated: 0 });
  });
});

describe("the event shown for a counterexample step", () => {
  it("names the initial state, an event-less transition and a named event apart", () => {
    assert.equal(stepEvent(0, null), "（初期状態）");
    assert.equal(stepEvent(1, null), "（イベントなし）");
    assert.equal(stepEvent(2, "reset_done"), "reset_done");
  });
});
