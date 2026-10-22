import type { Edge, StateName } from "../core/types.js";
import type { Layout } from "./wire.js";

export type Point = { readonly x: number; readonly y: number };

/** A node's rectangle on the canvas. `x`, `y` is the top-left corner, which is what layout.json stores. */
export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** SPEC §12.1. One size for every node, so a stored point is a whole box. */
export const BOX = { width: 180, height: 64 } as const;
/** The search step of `place` and the drop snap. */
export const GRID = 20;
/** dagre's gaps (SPEC §12.1). `place` starts one gap away, so a placed node looks dagre-placed. */
export const RANKSEP = 70;
export const NODESEP = 40;

/** What `place` and `relayout` read. `Graph` satisfies it. */
export type Shape = {
  readonly nodes: readonly { readonly id: StateName }[];
  readonly edges: readonly Pick<Edge, "type" | "from" | "to">[];
};

export function boxAt(point: Point): Box {
  void point;
  throw new Error("not implemented");
}

/**
 * The body of `GET /layout.json`, which a person or another tool may have edited. Keeps every entry
 * that is exactly `{x, y}` of finite numbers and drops the rest, so geometry never sees NaN.
 */
export function parseLayout(value: unknown): Layout {
  void value;
  throw new Error("not implemented");
}

/**
 * Condition 3. Returns `previous` plus a point for each node of `shape` that has none. Every entry
 * of `previous` comes back unchanged, including ids that are not in `shape`: a node that went away
 * keeps its spot reserved, so it gets the same spot when it returns and no new node takes it.
 *
 * An empty `previous` places everything with `relayout`. Otherwise a new node goes next to a node it
 * shares a flow edge with (a dep edge never anchors), at the first free spot in this order, nearest
 * first, 20 px per step: below the anchor, to its right, to its left. A node with no anchor goes
 * below everything. A spot is free when it overlaps no box in `previous` or placed so far.
 */
export function place(previous: Layout, shape: Shape): Layout {
  void previous;
  void shape;
  throw new Error("not implemented");
}

/**
 * The whole graph through dagre (TB, 180×64, ranksep 70, nodesep 40), as top-left points. Only ids
 * of `shape`: an explicit relayout drops the reserved spots of absent nodes.
 */
export function relayout(shape: Shape): Layout {
  void shape;
  throw new Error("not implemented");
}

/**
 * Condition 5. An orthogonal polyline from a side of `from` to a side of `to`: every segment is
 * horizontal or vertical and has length, the first point lies on `from`'s border and the last on
 * `to`'s. The arrow marker sits on the last point.
 *
 * `from === to` is a self-loop and leaves the box. `route(a, b)` and `route(b, a)` share no segment.
 * `lane` is the 0-based index of an edge among the edges from `from` to `to`: two lanes of one ordered
 * pair share no segment. A pair of boxes with no gap on either axis has no such guarantee for lanes.
 */
export function route(from: Box, to: Box, lane = 0): readonly Point[] {
  void from;
  void to;
  void lane;
  throw new Error("not implemented");
}

/** Where an edge's label goes: the midpoint of the polyline's middle segment. */
export function labelAt(points: readonly Point[]): Point {
  void points;
  throw new Error("not implemented");
}

/** A dropped box lands on the 20 px grid, like draw.io. */
export function snap(point: Point): Point {
  void point;
  throw new Error("not implemented");
}

/**
 * The body for `PUT /layout.json`, or `null` when nothing needs writing. The body holds only ids of
 * `graph` (the server answers 400 to any other id). It is due when a node of `graph` has no entry in
 * `saved` or a different one. A node that only went away is never a reason to write: its point stays
 * on disk until some other change forces a write.
 */
export function toPersist(o: {
  readonly saved: Layout;
  readonly layout: Layout;
  readonly graph: Shape;
}): Layout | null {
  void o;
  throw new Error("not implemented");
}
