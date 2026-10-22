import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import { type Box, relayout } from "../src/ui/layout.js";
import { initialState, reduce } from "../src/ui/state.js";
import { headerCounts, sceneOf, stepEvent } from "../src/ui/view.js";
import { exampleRepo } from "./helpers/tlc.js";
import {
  counterexample,
  graph,
  graphEvent,
  node,
  property,
  propertyId,
} from "./helpers/ui-fixtures.js";

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

describe("edge labels (docs/specs/viewer-panels.md condition 9)", () => {
  const overlap = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it("keeps the labels of example/ apart from each other and from the boxes", async () => {
    const { graph: example } = await analyze(await exampleRepo());
    const state = reduce(initialState(relayout(example)), {
      kind: "graph",
      event: graphEvent(example),
    });
    const { base } = sceneOf(state, { now: 0, drag: null });
    const labels = base.flatMap((item) =>
      item.kind === "line" && item.label !== null ? [item.label] : [],
    );
    const boxes = base.flatMap((item) => (item.kind === "box" ? [item.box] : []));

    assert.ok(labels.length >= 8, `${labels.length} labels`);
    for (const [i, a] of labels.entries()) {
      for (const box of boxes) assert.ok(!overlap(a.box, box), `${a.text} over a box`);
      for (const b of labels.slice(i + 1)) {
        assert.ok(!overlap(a.box, b.box), `${a.text} over ${b.text}`);
      }
    }
    const texts = labels.map((label) => label.text);
    assert.ok(texts.includes("signup_done"));
    assert.ok(texts.includes("login_fail [retries==3]"));
  });
});
