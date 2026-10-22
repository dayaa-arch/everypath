import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { Edge, Graph, ObservedEdge, StateNode } from "../src/core/types.js";
import { type Box, boxAt, relayout } from "../src/ui/layout.js";
import { type Action, initialState, reduce, type ViewState } from "../src/ui/state.js";
import { type SceneItem, sceneOf } from "../src/ui/view.js";
import type { Layout } from "../src/ui/wire.js";
import { exampleRepo } from "./helpers/tlc.js";
import { flow, graph, graphEvent, name, node } from "./helpers/ui-fixtures.js";

function observed(from: string, to: string, via: readonly string[]): ObservedEdge {
  return { type: "observed", from: name(from), to: name(to), declared: false, observed: true, via };
}

function member(id: string, group: string | null, files: readonly string[] = []): StateNode {
  return { ...node(id), group, files };
}

/** A, B and E are 画面, C is データ層 alone, D has no group. */
const LAYOUT: Layout = {
  A: { x: 0, y: 0 },
  B: { x: 300, y: 0 },
  C: { x: 0, y: 200 },
  D: { x: 300, y: 200 },
  E: { x: 600, y: 400 },
};

function sample(edges: readonly Edge[] = []): Graph {
  return graph({
    nodes: [
      member("A", "画面", ["src/a.ts"]),
      member("B", "画面"),
      member("C", "データ層"),
      member("D", null),
      member("E", "画面"),
    ],
    edges,
  });
}

function shown(g: Graph, layout: Layout = LAYOUT, ...actions: readonly Action[]): ViewState {
  const start = reduce(initialState(layout), { kind: "graph", event: graphEvent(g) });
  return actions.reduce(reduce, start);
}

function itemsOf(state: ViewState): readonly SceneItem[] {
  return sceneOf(state, { now: 0, drag: null }).base;
}

type Line = Extract<SceneItem, { kind: "line" }>;
const lines = (items: readonly SceneItem[]): Line[] =>
  items.flatMap((item) => (item.kind === "line" ? [item] : []));

const touches = (box: Box, point: { x: number; y: number }): boolean =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

const contains = (outer: Box, inner: Box): boolean =>
  outer.x < inner.x &&
  outer.y < inner.y &&
  outer.x + outer.width > inner.x + inner.width &&
  outer.y + outer.height > inner.y + inner.height;

describe("drift on the canvas (docs/specs/viewer-drift.md condition 2)", () => {
  const edges = [flow("A", "B", "go"), flow("B", "D"), observed("C", "A", ["src/c.ts"])];

  it("draws an observed-only transition as its own line, labelled 宣言なし, from the caller to the target", () => {
    const drift = lines(itemsOf(shown(sample(edges)))).filter((line) => line.look === "observed");

    assert.equal(drift.length, 1);
    const [line] = drift;
    assert.equal(line?.label?.text, "宣言なし");
    const first = line?.points[0];
    const last = line?.points.at(-1);
    assert.ok(first !== undefined && touches(boxAt(LAYOUT.C ?? { x: 0, y: 0 }), first));
    assert.ok(last !== undefined && touches(boxAt(LAYOUT.A ?? { x: 0, y: 0 }), last));
  });

  it("draws declared flows the same whether a call was observed or not", () => {
    const seen = (value: boolean): Edge[] =>
      edges.map((edge): Edge => (edge.type === "flow" ? { ...edge, observed: value } : edge));

    const withCalls = itemsOf(shown(sample(seen(true))));
    const without = itemsOf(shown(sample(seen(false))));

    assert.deepEqual(withCalls, without);
    const flowLines = lines(withCalls).filter((line) => line.look === "flow");
    assert.equal(flowLines.length, 2);
  });

  it("draws no drift line where there is no observed edge", () => {
    const plain = lines(itemsOf(shown(sample([flow("A", "B")]))));

    assert.deepEqual(
      plain.map((line) => line.look),
      ["flow"],
    );
  });
});

type Group = Extract<SceneItem, { kind: "group" }>;
const groups = (items: readonly SceneItem[]): Group[] =>
  items.flatMap((item) => (item.kind === "group" ? [item] : []));

describe("group frames (condition 4)", () => {
  it("frames each group of two or more boxes round all of them, and no group of one", () => {
    const state = shown(sample());

    const frames = groups(itemsOf(state));

    assert.deepEqual(
      frames.map((frame) => frame.name),
      ["画面"],
    );
    const [frame] = frames;
    for (const id of ["A", "B", "E"]) {
      const point = LAYOUT[id];
      assert.ok(
        point !== undefined && frame !== undefined && contains(frame.box, boxAt(point)),
        id,
      );
    }
    assert.ok(frame !== undefined && contains(frame.box, frame.label), "the name sits inside");
    assert.ok(
      frame !== undefined && frame.label.y < (LAYOUT.A?.y ?? 0),
      "the name is above the top box",
    );
  });

  it("frames only the boxes that are drawn", () => {
    const layout: Layout = { A: { x: 0, y: 0 }, C: { x: 0, y: 200 }, D: { x: 300, y: 200 } };
    const unplaced: ViewState = { ...initialState(layout), graph: sample() };

    assert.deepEqual(groups(itemsOf(unplaced)), []);
  });

  it("leaves the layout as it was", () => {
    const state = shown(sample());

    itemsOf(state);

    assert.deepEqual(state.layout, LAYOUT);
  });

  it("keeps the edge labels of example/ off the group names", async () => {
    const { graph: example } = await analyze(await exampleRepo());
    const state = shown(example, relayout(example));

    const items = itemsOf(state);

    const names = groups(items).map((frame) => frame.label);
    assert.ok(names.length > 0, "example/ has a group of several screens");
    for (const line of lines(items)) {
      for (const label of names) {
        const box = line.label?.box;
        const apart =
          box === undefined ||
          box.x + box.width <= label.x ||
          label.x + label.width <= box.x ||
          box.y + box.height <= label.y ||
          label.y + label.height <= box.y;
        assert.ok(apart, `${line.label?.text} over a group name`);
      }
    }
  });
});

type Files = Extract<SceneItem, { kind: "files" }>;
const fileCards = (items: readonly SceneItem[]): Files[] =>
  items.flatMap((item) => (item.kind === "files" ? [item] : []));

function zoomGraph(): Graph {
  return graph({
    nodes: [
      { ...node("Tested", { status: { tested: true } }), files: ["src/t.ts", "src/t2.ts"] },
      { ...node("One", { status: { tested: false } }), files: ["src/one.ts"] },
      { ...node("Two", { status: { tested: false } }), files: ["src/a.ts", "src/b.ts"] },
    ],
    edges: [flow("Tested", "One"), flow("One", "Two")],
  });
}

const ZOOM_LAYOUT: Layout = {
  Tested: { x: 0, y: 0 },
  One: { x: 0, y: 200 },
  Two: { x: 300, y: 200 },
};

const zoom = (id: string): Action => ({ kind: "zoom", id: name(id) });

describe("file-granularity zoom (condition 5)", () => {
  it("opens the node's files where its box is, and moves nothing else", () => {
    const before = shown(zoomGraph(), ZOOM_LAYOUT);
    const after = reduce(before, zoom("One"));

    assert.equal(after.zoom, "One");
    assert.deepEqual(after.layout, ZOOM_LAYOUT);
    const items = itemsOf(after);
    const cards = fileCards(items);
    assert.equal(cards.length, 1);
    const [card] = cards;
    assert.equal(card?.id, "One");
    assert.deepEqual([card?.box.x, card?.box.y], [0, 200]);
    assert.deepEqual(
      items.filter((item) => item.kind !== "files"),
      itemsOf(before),
    );
  });

  it("says a file is tested when the node is, untested for a lone file of an untested node, and nothing otherwise", () => {
    const state = shown(zoomGraph(), ZOOM_LAYOUT);
    const rows = (id: string) => fileCards(itemsOf(reduce(state, zoom(id))))[0]?.rows;

    assert.deepEqual(rows("Tested"), [
      { file: "src/t.ts", tested: true },
      { file: "src/t2.ts", tested: true },
    ]);
    assert.deepEqual(rows("One"), [{ file: "src/one.ts", tested: false }]);
    assert.deepEqual(rows("Two"), [
      { file: "src/a.ts", tested: null },
      { file: "src/b.ts", tested: null },
    ]);
  });

  it("closes on a second zoom of the same node, and moves to another node's files", () => {
    const state = shown(zoomGraph(), ZOOM_LAYOUT);

    assert.equal(reduce(reduce(state, zoom("One")), zoom("One")).zoom, null);
    assert.equal(reduce(reduce(state, zoom("One")), zoom("Two")).zoom, "Two");
  });

  it("closes on Escape first, and only then lets Escape clear the selection", () => {
    const selected = shown(zoomGraph(), ZOOM_LAYOUT, {
      kind: "select",
      id: name("One"),
      extend: false,
    });
    const zoomed = reduce(selected, zoom("One"));

    const once = reduce(zoomed, { kind: "escape" });
    const twice = reduce(once, { kind: "escape" });

    assert.deepEqual([once.zoom, once.selection.kind], [null, "node"]);
    assert.deepEqual([twice.zoom, twice.selection.kind], [null, "none"]);
  });

  it("ignores a node the graph does not have, and closes when the zoomed node goes away", () => {
    const state = shown(zoomGraph(), ZOOM_LAYOUT);
    assert.equal(reduce(state, zoom("Ghost")), state);

    const zoomed = reduce(state, zoom("Two"));
    const without: Graph = {
      ...zoomGraph(),
      nodes: zoomGraph().nodes.filter((n) => n.id !== "Two"),
      edges: [flow("Tested", "One")],
    };
    const after = reduce(zoomed, { kind: "graph", event: graphEvent(without) });

    assert.equal(after.zoom, null);
  });

  it("keeps the zoom across a graph event that keeps the node", () => {
    const zoomed = reduce(shown(zoomGraph(), ZOOM_LAYOUT), zoom("Two"));

    const after = reduce(zoomed, { kind: "graph", event: graphEvent(zoomGraph()) });

    assert.equal(after.zoom, "Two");
  });
});
