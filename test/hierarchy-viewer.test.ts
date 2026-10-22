import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { Edge, Graph, StateNode } from "../src/core/types.js";
import { type Box, boxAt, overlaps, place, relayout } from "../src/ui/layout.js";
import { promptTargets } from "../src/ui/prompt.js";
import { initialState, reduce, type ViewState } from "../src/ui/state.js";
import { headerCounts, reviewQueue, type SceneItem, sceneOf, toneOf } from "../src/ui/view.js";
import type { Layout } from "../src/ui/wire.js";
import { makeRepo, ts, writeFiles } from "./helpers/repo.js";
import { flow, graph, graphEvent, name, node } from "./helpers/ui-fixtures.js";

function child(id: string, parent: string, files: readonly string[] = [`src/${id}.ts`]): StateNode {
  return { ...node(id), files, parent: name(parent) };
}

/** P (with a file) holds A, B and the container Q; Q holds Q1. X is outside. The container G holds C. */
function family(edges: readonly Edge[] = []): Graph {
  return graph({
    nodes: [
      child("A", "P"),
      child("B", "P"),
      { ...node("C"), files: ["src/c.ts"], parent: name("G") },
      { ...node("G"), container: true },
      { ...node("P"), files: ["src/p.ts"] },
      { ...child("Q", "P", []), container: true },
      child("Q1", "Q"),
      { ...node("X"), files: ["src/x.ts"] },
    ],
    edges,
  });
}

/** P holds a stale point of its own, from before it had children: it is kept and never drawn. */
const LAYOUT: Layout = {
  A: { x: 0, y: 0 },
  B: { x: 300, y: 0 },
  Q1: { x: 0, y: 200 },
  X: { x: 900, y: 600 },
  C: { x: 900, y: 0 },
  P: { x: 2000, y: 2000 },
};

function shown(g: Graph, layout: Layout = LAYOUT): ViewState {
  return reduce(initialState(layout), { kind: "graph", event: graphEvent(g) });
}

const itemsOf = (state: ViewState): readonly SceneItem[] =>
  sceneOf(state, { now: 0, drag: null }).base;

type Frame = Extract<SceneItem, { kind: "parent" }>;
const frames = (items: readonly SceneItem[]): Frame[] =>
  items.flatMap((item) => (item.kind === "parent" ? [item] : []));
const frameOf = (items: readonly SceneItem[], id: string): Frame => {
  const found = frames(items).find((frame) => frame.id === id);
  assert.ok(found !== undefined, `${id} has a frame`);
  return found;
};

const encloses = (outer: Box, inner: Box): boolean =>
  outer.x < inner.x &&
  outer.y < inner.y &&
  outer.x + outer.width > inner.x + inner.width &&
  outer.y + outer.height > inner.y + inner.height;

const onBorder = (box: Box, point: { readonly x: number; readonly y: number }): boolean => {
  const inX = point.x >= box.x && point.x <= box.x + box.width;
  const inY = point.y >= box.y && point.y <= box.y + box.height;
  return (
    (inX && (point.y === box.y || point.y === box.y + box.height)) ||
    (inY && (point.x === box.x || point.x === box.x + box.width))
  );
};

const boxOf = (layout: Layout, id: string): Box => {
  const point = layout[id];
  assert.ok(point !== undefined, `${id} has a point`);
  return boxAt(point);
};

describe("hierarchy in the viewer: frames", () => {
  it("draws each parent as a frame round its children's boxes and frames, with its name inside the top", () => {
    const items = itemsOf(shown(family()));
    const p = frameOf(items, "P");
    const q = frameOf(items, "Q");

    for (const id of ["A", "B", "Q1"]) assert.ok(encloses(p.box, boxOf(LAYOUT, id)), id);
    assert.ok(encloses(q.box, boxOf(LAYOUT, "Q1")));
    assert.ok(encloses(p.box, q.box), "a frame in a frame");
    assert.ok(!overlaps(p.box, boxOf(LAYOUT, "X")), "X is not inside P");
    assert.ok(encloses(p.box, p.label), "the name sits inside the frame");
    assert.ok(p.label.y + p.label.height <= (LAYOUT.A?.y ?? 0), "the name is above the boxes");
    assert.deepEqual(items.flatMap((item) => (item.kind === "box" ? [item.id] : [])).sort(), [
      "A",
      "B",
      "C",
      "Q1",
      "X",
    ]);
  });

  it("paints parent frames under every line and box, outer first", () => {
    const items = itemsOf(shown(family([flow("A", "B", "go")])));
    const kinds = items.map((item) => item.kind);
    const lastFrame = kinds.lastIndexOf("parent");

    assert.ok(lastFrame < kinds.indexOf("line") && lastFrame < kinds.indexOf("box"));
    assert.deepEqual(
      frames(items).map((frame) => frame.id),
      ["G", "P", "Q"],
    );
  });

  it("draws a parent's own transition once, from the frame's border", () => {
    const items = itemsOf(shown(family([flow("P", "X", "logout")])));
    const lines = items.flatMap((item) => (item.kind === "line" ? [item] : []));
    const p = frameOf(items, "P");

    assert.equal(lines.length, 1);
    const [line] = lines;
    const first = line?.points[0];
    const last = line?.points.at(-1);
    assert.ok(first !== undefined && onBorder(p.box, first), "starts on P's frame");
    assert.ok(last !== undefined && onBorder(boxOf(LAYOUT, "X"), last), "ends on X's box");
    assert.equal(line?.label?.text, "logout");
  });

  it("paints a parent with a file in its own tone and a container in no tone, never as planned", () => {
    const g = family();
    const items = itemsOf(shown(g));
    const p = g.nodes.find((n) => n.id === "P");

    assert.ok(p !== undefined);
    assert.equal(frameOf(items, "P").tone, toneOf(p, g.properties));
    assert.equal(frameOf(items, "G").tone, null);
  });

  it("moves a dragged child's frames and their lines with it", () => {
    const state = shown(family([flow("P", "X", "logout")]));
    const { live } = sceneOf(state, { now: 0, drag: { id: name("Q1"), at: { x: 0, y: 400 } } });

    assert.deepEqual(
      frames(live)
        .map((frame) => frame.id)
        .sort(),
      ["P", "Q"],
    );
    assert.ok(
      live.some((item) => item.kind === "line"),
      "P's line follows its frame",
    );
  });
});

describe("hierarchy in the viewer: a container has nothing to review", () => {
  it("is left out of the review queue, the header's count and the test instruction", () => {
    const g = family();

    assert.deepEqual(
      reviewQueue(g)
        .map(({ node }) => node.id)
        .sort(),
      ["A", "B", "C", "P", "Q1", "X"],
    );
    assert.equal(headerCounts(g).unreviewed, 6);
    assert.deepEqual(promptTargets("write-tests", g, [name("G")]), []);
    assert.deepEqual(promptTargets("draw-model", g, [name("G")]), []);
  });
});

describe("hierarchy in the viewer: coordinates (R-05)", () => {
  it("keeps every stored point, gives a parent none, and puts a new child near its siblings, outside other frames", () => {
    const previous: Layout = { A: { x: 0, y: 0 }, B: { x: 300, y: 0 }, X: { x: 0, y: 200 } };
    const shape = graph({
      nodes: [
        child("A", "P"),
        child("B", "P"),
        child("N", "P"),
        { ...node("P") },
        { ...node("X") },
      ],
      edges: [flow("X", "A")],
    });
    const placed = place(previous, shape);

    for (const [id, point] of Object.entries(previous)) assert.deepEqual(placed[id], point, id);
    assert.equal(placed.P, undefined);
    const items = itemsOf(shown(shape, placed));
    const p = frameOf(items, "P");
    assert.ok(encloses(p.box, boxOf(placed, "N")), "N is drawn inside P");
    assert.ok(!overlaps(p.box, boxOf(placed, "X")), "P's frame holds no stranger");
  });

  it("keeps the point of a state that became a parent, and every other point, on a real rescan", async () => {
    const files = {
      "src/area.ts": ts("@state Area", "@state-next Out on:logout"),
      "src/out.ts": ts("@state Out"),
      "src/start.ts": ts("@state Start", "@state-initial", "@state-next Area on:login"),
    };
    const root = await makeRepo(files);
    const before = (await analyze(root)).graph;
    const layout = relayout(before);
    await writeFiles(root, {
      "src/a.ts": ts("@state A", "@state-parent Area", "@state-initial"),
      "src/b.ts": ts("@state B", "@state-parent Area"),
    });
    const after = (await analyze(root)).graph;
    const placed = place(layout, after);

    for (const [id, point] of Object.entries(layout)) assert.deepEqual(placed[id], point, id);
    const items = itemsOf(shown(after, placed));
    const area = frameOf(items, "Area");
    for (const id of ["A", "B"]) assert.ok(encloses(area.box, boxOf(placed, id)), id);
    for (const id of ["Out", "Start"]) assert.ok(!overlaps(area.box, boxOf(placed, id)), id);
  });

  it("lays parents out as clusters: each frame holds its own and no other box, unrelated frames apart", () => {
    const shape = graph({
      nodes: [
        child("A1", "P"),
        child("A2", "P"),
        child("B1", "Q"),
        child("B2", "Q"),
        { ...node("P"), files: ["src/p.ts"] },
        { ...node("Q"), files: ["src/q.ts"] },
        { ...node("S"), files: ["src/s.ts"] },
      ],
      edges: [flow("S", "P"), flow("A1", "A2"), flow("P", "Q"), flow("B1", "B2"), flow("B2", "S")],
    });
    const layout = relayout(shape);
    const items = itemsOf(shown(shape, layout));

    assert.deepEqual(Object.keys(layout).sort(), ["A1", "A2", "B1", "B2", "S"]);
    const inside = { P: ["A1", "A2"], Q: ["B1", "B2"] } as const;
    for (const [parent, members] of Object.entries(inside)) {
      const frame = frameOf(items, parent);
      for (const id of Object.keys(layout)) {
        const box = boxOf(layout, id);
        if ((members as readonly string[]).includes(id)) assert.ok(encloses(frame.box, box), id);
        else assert.ok(!overlaps(frame.box, box), `${id} outside ${parent}`);
      }
    }
    assert.ok(!overlaps(frameOf(items, "P").box, frameOf(items, "Q").box));
  });
});
