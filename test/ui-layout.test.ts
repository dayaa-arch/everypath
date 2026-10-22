import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { place, relayout, type Shape } from "../src/ui/layout.js";
import type { Layout } from "../src/ui/wire.js";
import { name } from "./helpers/ui-fixtures.js";

/** docs/specs/viewer.md condition 3: boxes are 180×64, dagre uses ranksep 70 and nodesep 40. */
const WIDTH = 180;
const HEIGHT = 64;
const RANK_STEP = HEIGHT + 70;
const COLUMN_STEP = WIDTH + 40;
const STEP = 20;

type Point = { readonly x: number; readonly y: number };

function shapeOf(
  ids: readonly string[],
  flows: readonly (readonly [string, string])[] = [],
  deps: readonly (readonly [string, string])[] = [],
): Shape {
  return {
    nodes: ids.map((id) => ({ id: name(id) })),
    edges: [
      ...flows.map(([from, to]) => ({ type: "flow" as const, from: name(from), to: name(to) })),
      ...deps.map(([from, to]) => ({ type: "dep" as const, from: name(from), to: name(to) })),
    ],
  };
}

function at(layout: Layout, id: string): Point {
  const point = layout[id];
  assert.ok(point !== undefined, `${id} has a point`);
  return point;
}

function overlap(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < WIDTH && Math.abs(a.y - b.y) < HEIGHT;
}

function overlappingPairs(layout: Layout, ids: readonly string[] = Object.keys(layout)): string[] {
  const found: string[] = [];
  for (const [index, a] of ids.entries()) {
    for (const b of ids.slice(index + 1)) {
      if (overlap(at(layout, a), at(layout, b))) found.push(`${a} and ${b}`);
    }
  }
  return found;
}

function assertKept(before: Layout, after: Layout): void {
  for (const [id, point] of Object.entries(before)) assert.deepEqual(after[id], point, id);
}

describe("place: a layout that already has points", () => {
  const PARENT: Point = { x: 400, y: 300 };
  const BELOW: Point = { x: PARENT.x, y: PARENT.y + RANK_STEP };
  const RIGHT: Point = { x: PARENT.x + COLUMN_STEP, y: PARENT.y };
  const LEFT: Point = { x: PARENT.x - COLUMN_STEP, y: PARENT.y };
  const FAR: Point = { x: 40, y: 900 };

  it("never changes a stored point across added and removed nodes", () => {
    const stored: Layout = {
      A: { x: 503, y: 497 },
      B: { x: 0, y: 0 },
      C: { x: 241, y: 700 },
    };
    const first = place(
      stored,
      shapeOf(
        ["A", "B", "C", "D", "E"],
        [
          ["A", "B"],
          ["B", "C"],
          ["C", "D"],
          ["D", "E"],
        ],
      ),
    );
    assertKept(stored, first);
    assert.deepEqual(Object.keys(first).sort(), ["A", "B", "C", "D", "E"]);

    const withoutB = place(first, shapeOf(["A", "C", "D", "E"], [["C", "D"]]));
    assertKept(first, withoutB);

    const withF = place(withoutB, shapeOf(["A", "C", "D", "E", "F"], [["E", "F"]]));
    assertKept(first, withF);
    assert.deepEqual(overlappingPairs(withF, ["A", "C", "D", "E", "F"]), []);
  });

  it("puts a new node below the node its flow edge comes from", () => {
    const placed = place({ P: PARENT, Far: FAR }, shapeOf(["P", "Far", "N"], [["P", "N"]]));
    assert.deepEqual(at(placed, "N"), BELOW);
    assert.deepEqual(at(placed, "P"), PARENT);
  });

  it("puts a new node below the node its flow edge points to", () => {
    const placed = place({ P: PARENT, Far: FAR }, shapeOf(["P", "Far", "N"], [["N", "P"]]));
    assert.deepEqual(at(placed, "N"), BELOW);
  });

  it("takes the right of the parent when below is taken", () => {
    const stored: Layout = { P: PARENT, Below: BELOW };
    const placed = place(stored, shapeOf(["P", "Below", "N"], [["P", "N"]]));
    assert.deepEqual(at(placed, "N"), RIGHT);
    assertKept(stored, placed);
  });

  it("takes the left of the parent when below and right are taken", () => {
    const stored: Layout = { P: PARENT, Below: BELOW, Right: RIGHT };
    const placed = place(stored, shapeOf(["P", "Below", "Right", "N"], [["P", "N"]]));
    assert.deepEqual(at(placed, "N"), LEFT);
    assertKept(stored, placed);
  });

  it("moves on in 20 px steps, below first, when below, right and left are all taken", () => {
    const stored: Layout = { P: PARENT, Below: BELOW, Right: RIGHT, Left: LEFT };
    const placed = place(stored, shapeOf(["P", "Below", "Right", "Left", "N"], [["P", "N"]]));
    const n = at(placed, "N");
    const drop = n.y - BELOW.y;
    assert.equal(n.x, BELOW.x);
    assert.equal(drop % STEP, 0, `${drop} px below the first spot is not a multiple of 20`);
    assert.ok(drop >= HEIGHT && drop <= HEIGHT + 3 * STEP, `${drop} px below the first spot`);
    assert.deepEqual(overlappingPairs(placed), []);
    assertKept(stored, placed);
  });

  it("puts one of two new children below the parent and the other clear of it", () => {
    const placed = place(
      { P: PARENT },
      shapeOf(
        ["P", "K1", "K2"],
        [
          ["P", "K1"],
          ["P", "K2"],
        ],
      ),
    );
    const below = [at(placed, "K1"), at(placed, "K2")].filter(
      (point) => point.x === BELOW.x && point.y === BELOW.y,
    );
    assert.equal(below.length, 1);
    assert.deepEqual(overlappingPairs(placed), []);
  });

  it("stacks a chain of new nodes added together", () => {
    const placed = place(
      { P: PARENT, Far: FAR },
      shapeOf(
        ["P", "Far", "B", "C"],
        [
          ["P", "B"],
          ["B", "C"],
        ],
      ),
    );
    assert.deepEqual(at(placed, "B"), BELOW);
    assert.deepEqual(at(placed, "C"), { x: BELOW.x, y: BELOW.y + RANK_STEP });
  });

  it("never overlaps any box when many nodes land around crowded neighbours", () => {
    const stored: Layout = {
      P: PARENT,
      X1: { x: 380, y: 420 },
      X2: { x: 610, y: 310 },
      X3: { x: 170, y: 290 },
      X4: { x: 400, y: 570 },
    };
    const kids = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8"];
    const placed = place(
      stored,
      shapeOf(
        ["P", "X1", "X2", "X3", "X4", ...kids],
        kids.map((kid) => ["P", kid] as const),
      ),
    );
    assertKept(stored, placed);
    assert.deepEqual(Object.keys(placed).sort(), ["P", "X1", "X2", "X3", "X4", ...kids].sort());
    assert.deepEqual(overlappingPairs(placed), []);
  });

  it("gives a node that goes away and comes back the point it had", () => {
    const base = place({ P: PARENT }, shapeOf(["P", "X"], [["P", "X"]]));
    const home = at(base, "X");

    const gone = place(base, shapeOf(["P"]));
    const back = place(gone, shapeOf(["P", "X"], [["P", "X"]]));
    assert.deepEqual(at(back, "X"), home);
    assert.deepEqual(at(back, "P"), PARENT);
  });

  it("keeps the spot of a node that is away free, so nothing overlaps it on its return", () => {
    const base = place({ P: PARENT }, shapeOf(["P", "X"], [["P", "X"]]));
    const home = at(base, "X");

    const whileGone = place(base, shapeOf(["P", "N"], [["P", "N"]]));
    assert.equal(overlap(at(whileGone, "N"), home), false);

    const back = place(
      whileGone,
      shapeOf(
        ["P", "N", "X"],
        [
          ["P", "N"],
          ["P", "X"],
        ],
      ),
    );
    assert.deepEqual(at(back, "X"), home);
    assert.deepEqual(overlappingPairs(back, ["P", "N", "X"]), []);
  });

  it("does not rearrange stored points to follow the edges: only relayout does", () => {
    const stored: Layout = { A: { x: 500, y: 500 }, B: { x: 0, y: 0 } };
    const graph = shapeOf(
      ["A", "B", "C"],
      [
        ["A", "B"],
        ["A", "C"],
      ],
    );

    const placed = place(stored, graph);
    assertKept(stored, placed);
    assert.ok(at(placed, "A").y > at(placed, "B").y, "A stays below B although A leads to B");

    const aligned = relayout(graph);
    assert.ok(at(aligned, "A").y < at(aligned, "B").y, "relayout puts A above B");
  });
});

describe("place: an empty layout", () => {
  it("places every node with relayout", () => {
    const graph = shapeOf(
      ["A", "B", "C", "D"],
      [
        ["A", "B"],
        ["A", "C"],
        ["B", "D"],
        ["C", "D"],
      ],
    );
    const placed = place({}, graph);
    assert.deepEqual(placed, relayout(graph));
    assert.deepEqual(Object.keys(placed).sort(), ["A", "B", "C", "D"]);
    assert.deepEqual(overlappingPairs(placed), []);
  });

  it("has nothing to place for an empty graph", () => {
    assert.deepEqual(place({}, shapeOf([])), {});
  });
});

describe("relayout", () => {
  it("lays a chain out top to bottom, one rank apart", () => {
    const placed = relayout(
      shapeOf(
        ["A", "B", "C"],
        [
          ["A", "B"],
          ["B", "C"],
        ],
      ),
    );
    assert.equal(at(placed, "A").x, at(placed, "B").x);
    assert.equal(at(placed, "B").x, at(placed, "C").x);
    assert.equal(at(placed, "B").y - at(placed, "A").y, RANK_STEP);
    assert.equal(at(placed, "C").y - at(placed, "B").y, RANK_STEP);
  });

  it("puts siblings on one rank, a column apart at least", () => {
    const placed = relayout(
      shapeOf(
        ["A", "B", "C"],
        [
          ["A", "B"],
          ["A", "C"],
        ],
      ),
    );
    assert.equal(at(placed, "B").y, at(placed, "C").y);
    assert.equal(at(placed, "B").y - at(placed, "A").y, RANK_STEP);
    assert.ok(Math.abs(at(placed, "B").x - at(placed, "C").x) >= COLUMN_STEP);
  });

  it("places every node of the graph and only those, with no overlap", () => {
    const ids = ["Login", "Reset", "Home", "Settings", "Db", "Orphan", "Help"];
    const placed = relayout(
      shapeOf(
        ids,
        [
          ["Login", "Home"],
          ["Login", "Reset"],
          ["Reset", "Login"],
          ["Reset", "Home"],
          ["Home", "Settings"],
          ["Home", "Home"],
          ["Settings", "Home"],
        ],
        [["Home", "Db"]],
      ),
    );
    assert.deepEqual(Object.keys(placed).sort(), [...ids].sort());
    assert.deepEqual(overlappingPairs(placed), []);
  });

  it("drops the points of nodes that are not in the graph", () => {
    assert.deepEqual(Object.keys(relayout(shapeOf(["A"]))), ["A"]);
  });
});
