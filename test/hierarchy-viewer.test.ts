import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { Edge, Graph, StateNode } from "../src/core/types.js";
import { type Box, boxAt, overlaps, place, relayout, type Shape } from "../src/ui/layout.js";
import { promptTargets } from "../src/ui/prompt.js";
import { initialState, reduce, type ViewState } from "../src/ui/state.js";
import { headerCounts, reviewQueue, type SceneItem, sceneOf, toneOf } from "../src/ui/view.js";
import type { Layout } from "../src/ui/wire.js";
import { makeRepo, ts, writeFiles } from "./helpers/repo.js";
import { fastestOf } from "./helpers/timing.js";
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

  it("puts a new child of a parent that already has children next to them, not on the parent's old point", () => {
    const previous: Layout = { A: { x: 0, y: 0 }, B: { x: 300, y: 0 }, P: { x: 2000, y: 2000 } };
    const shape = graph({
      nodes: [child("A", "P"), child("B", "P"), child("N", "P"), { ...node("P") }],
    });

    assert.deepEqual(place(previous, shape).N, { x: 0, y: 134 }, "below A, the first sibling");
  });

  it("still gives the old point of a box that became a parent to its first placed child only", () => {
    const previous: Layout = { P: { x: 2000, y: 2000 }, X: { x: 0, y: 0 } };
    const shape = graph({
      nodes: [child("N1", "P"), child("N2", "P"), { ...node("P") }, { ...node("X") }],
    });
    const placed = place(previous, shape);

    assert.deepEqual(placed.N1, { x: 2000, y: 2000 });
    assert.notDeepEqual(placed.N2, { x: 2000, y: 2000 });
  });

  it("keeps a3 out of B's frame when an unrelated frame was already dirty", () => {
    const shape = graph({
      nodes: [
        { ...node("A"), files: ["src/a.ts"] },
        child("a1", "A"),
        child("a2", "A"),
        child("a3", "A"),
        { ...node("B"), files: ["src/b.ts"] },
        child("b1", "B"),
        child("b2", "B"),
        { ...node("C"), files: ["src/c.ts"] },
        child("c1", "C"),
        { ...node("z"), files: ["src/z.ts"] },
      ],
    });
    const previous: Layout = {
      a1: { x: 0, y: 0 },
      a2: { x: 220, y: 0 },
      b1: { x: -300, y: 134 },
      b2: { x: 300, y: 134 },
      c1: { x: 1000, y: 0 },
      z: { x: 1000, y: 70 },
    };
    const placed = place(previous, shape);
    const items = itemsOf(shown(shape, placed));

    assert.ok(overlaps(frameOf(items, "C").box, boxOf(placed, "z")), "C's frame was dirty before");
    assert.ok(!overlaps(frameOf(items, "B").box, boxOf(placed, "a3")), "a3 is not in B's frame");
    assert.ok(
      !overlaps(frameOf(items, "A").box, frameOf(items, "B").box),
      "A's frame stays off B's",
    );
    assert.ok(encloses(frameOf(items, "A").box, boxOf(placed, "a3")));
  });

  it("places 800 new siblings far faster than the old frame check, each on a box of its own", () => {
    const siblings = Array.from(
      { length: 800 },
      (_, index) => `c${String(index + 1).padStart(3, "0")}`,
    );
    const shape = graph({
      nodes: [child("c000", "P"), ...siblings.map((id) => child(id, "P")), { ...node("P") }],
    });
    const { ms, result: placed } = fastestOf(() => place({ c000: { x: 0, y: 0 } }, shape));

    const points = siblings.map((id) => placed[id]);
    assert.ok(points.every((point) => point !== undefined));
    assert.equal(new Set(points.map((point) => `${point?.x},${point?.y}`)).size, 800);
    // Checking every frame per candidate took about 2,250 ms; the local check about 25 ms.
    assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  });
});

const layoutModule = new URL("../src/ui/layout.ts", import.meta.url).href;
const tsx = import.meta.resolve("tsx");

/** `place` in a child process, so a placement that never ends fails the test instead of the run. */
function placeApart(previous: Layout, shape: Shape): Layout | null {
  const script = [
    `import { place } from ${JSON.stringify(layoutModule)};`,
    "const [previous, shape] = JSON.parse(process.argv[1]);",
    "process.stdout.write(JSON.stringify(place(previous, shape)));",
  ].join("\n");
  const run = spawnSync(
    process.execPath,
    ["--import", tsx, "--input-type=module", "-e", script, JSON.stringify([previous, shape])],
    { encoding: "utf8", timeout: 20_000 },
  );
  return run.status === 0 ? (JSON.parse(run.stdout) as Layout) : null;
}

describe("hierarchy in the viewer: names that objects already have", () => {
  const odd = ["constructor", "toString", "__proto__"];
  const shape = graph({
    nodes: [
      { ...node("A") },
      ...odd.map((id) => ({ ...node(id) })),
      { ...node("X") },
      { ...node("valueOf"), files: ["src/v.ts"] },
      child("hasOwnProperty", "valueOf"),
      child("isPrototypeOf", "valueOf"),
    ],
    edges: [
      flow("A", "constructor"),
      flow("constructor", "toString"),
      flow("toString", "__proto__"),
      flow("__proto__", "X"),
      flow("X", "valueOf"),
    ],
  });
  const leaves = ["A", ...odd, "X", "hasOwnProperty", "isPrototypeOf"];
  const ownBoxes = (placed: Layout) => {
    for (const id of leaves) {
      assert.ok(Object.hasOwn(placed, id), `${id} has a point`);
      const point = placed[id];
      assert.ok(Number.isFinite(point?.x) && Number.isFinite(point?.y), `${id} is finite`);
    }
    for (const [index, a] of leaves.entries()) {
      for (const b of leaves.slice(index + 1)) {
        assert.ok(!overlaps(boxOf(placed, a), boxOf(placed, b)), `${a} and ${b} apart`);
      }
    }
  };

  it("places each of them next to its neighbours, and ends", { timeout: 60_000 }, () => {
    const previous = JSON.parse('{"A": {"x": 0, "y": 0}, "hasOwnProperty": {"x": 0, "y": 900}}');
    const placed = placeApart(previous, shape);

    assert.ok(placed !== null, "place ended");
    ownBoxes(placed);
  });

  it("lays them all out from nothing", { timeout: 60_000 }, () => {
    const placed = placeApart({}, shape);

    assert.ok(placed !== null, "relayout ended");
    ownBoxes(placed);
  });
});

describe("hierarchy in the viewer: a layout dagre cannot finish", () => {
  /** 10 parents of 5 parents of 10 leaves, and 300 edges drawn by a fixed linear congruential sequence. */
  function nested(): Graph {
    const nodes: StateNode[] = [];
    for (let a = 0; a < 10; a++) {
      nodes.push({ ...node(`P${a}`), files: [`src/p${a}.ts`] });
      for (let b = 0; b < 5; b++) {
        nodes.push({ ...child(`P${a}_${b}`, `P${a}`, [`src/p${a}_${b}.ts`]) });
        for (let c = 0; c < 10; c++) nodes.push(child(`L${a}_${b}_${c}`, `P${a}_${b}`));
      }
    }
    let seed = 1;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const ids = nodes.map(({ id }) => id);
    const pick = (): string => ids[Math.floor(next() * ids.length)] ?? "P0";
    const edges = Array.from({ length: 300 }, () => {
      const from = pick();
      return flow(from, pick());
    });
    return graph({ nodes, edges });
  }

  it("falls back to the layout without frames for the 10x5x10 nest instead of throwing", {
    timeout: 120_000,
  }, () => {
    const shape = nested();
    const layout = relayout(shape);
    const leaves = shape.nodes.filter(({ id }) => id.startsWith("L")).map(({ id }) => id);

    assert.deepEqual(Object.keys(layout).sort(), [...leaves].sort());
    const boxes = leaves.map((id) => boxOf(layout, id));
    assert.ok(boxes.every((box) => Number.isFinite(box.x) && Number.isFinite(box.y)));
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) assert.ok(!overlaps(a, b));
    }
  });
});
