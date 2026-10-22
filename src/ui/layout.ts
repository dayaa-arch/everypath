import { Graph, layout } from "@dagrejs/dagre";
import { type Hierarchy, hierarchyOf, type TreeNode } from "../core/hierarchy.js";
import type { Edge, Leaf, StateName } from "../core/types.js";
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
/** `place` keeps this much air between boxes, so `route` always has a gap to run in. */
const CLEARANCE = GRID;
/** How far apart the lanes of one pair of boxes run. */
const LANE = 8;

/** What `place` and `relayout` read. `Graph` satisfies it. */
export type Shape = {
  readonly nodes: readonly TreeNode[];
  readonly edges: readonly Pick<Edge, "type" | "from" | "to">[];
  readonly model?: { readonly initial: StateName | null };
};

export function boxAt(point: Point): Box {
  return { x: point.x, y: point.y, ...BOX };
}

/**
 * The point stored for `id`, as an own key only: `layout.constructor` would otherwise be Object's,
 * and a state may be named `constructor`, `toString` or `__proto__`.
 */
export function pointIn(layout: Layout, id: string): Point | undefined {
  return Object.hasOwn(layout, id) ? layout[id] : undefined;
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * A frame's air round what it holds, and the height of the strip its name takes above it. One size
 * for `@state-group` frames and `@state-parent` frames, so a frame in a frame is `pad` inside it.
 */
export const FRAME = { pad: 16, name: 24 } as const;

/** The rectangle round `boxes` with `FRAME.pad` of air and `FRAME.name` more on top, or null for none. */
export function enclose(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return {
    x: left - FRAME.pad,
    y: top - FRAME.pad - FRAME.name,
    width: right - left + 2 * FRAME.pad,
    height: bottom - top + 2 * FRAME.pad + FRAME.name,
  };
}

/** A parent (`@state-parent`), drawn round what is inside it. Never stored: its leaves' points are. */
export type ParentFrame = {
  readonly id: StateName;
  readonly box: Box;
  /** 0 at the top level. Outer frames are painted first. */
  readonly depth: number;
  /** The leaves inside that have a box: what moves the frame. */
  readonly members: readonly Leaf[];
};

/**
 * Every parent with a box inside it, outer first, then by id. A frame encloses its children's boxes
 * and frames, so frames nest with `FRAME.pad` between them and no frame is stored.
 */
export function parentFrames(
  hierarchy: Hierarchy,
  leafBox: (leaf: Leaf) => Box | undefined,
): readonly ParentFrame[] {
  const made: ParentFrame[] = [];
  const build = (id: StateName): Box | null => {
    if (hierarchy.isLeaf(id)) return leafBox(id) ?? null;
    const box = enclose(hierarchy.childrenOf(id).flatMap((child) => build(child) ?? []));
    if (box !== null) {
      const members = hierarchy.within(id).filter((leaf) => leafBox(leaf) !== undefined);
      made.push({ id, box, depth: hierarchy.ancestorsOf(id).length, members });
    }
    return box;
  };
  for (const root of hierarchy.roots) build(root);
  return made.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The body of `GET /layout.json`, which a person or another tool may have edited. Keeps every entry
 * that is exactly `{x, y}` of finite numbers and drops the rest, so geometry never sees NaN.
 */
export function parseLayout(value: unknown): Layout {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const points: [string, Point][] = [];
  for (const [id, point] of Object.entries(value)) {
    if (typeof point !== "object" || point === null || Object.keys(point).length !== 2) continue;
    if (!("x" in point) || !("y" in point)) continue;
    const { x, y } = point;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      Number.isFinite(x) &&
      Number.isFinite(y)
    ) {
      points.push([id, { x, y }]);
    }
  }
  return Object.fromEntries(points);
}

/**
 * Condition 3. Returns `previous` plus a point for each leaf of `shape` that has none. Every entry
 * of `previous` comes back unchanged, including ids that are not in `shape` and states that now have
 * children: a node that went away keeps its spot reserved, so it gets the same spot when it returns
 * and no new node takes it. A parent gets no point: it is drawn as a frame round its leaves. An id is
 * looked up as an own key only, so a state named `constructor` or `__proto__` is placed like any.
 *
 * An empty `previous` places everything with `relayout`. Otherwise a new leaf goes next to the first
 * of these that has a point: a node it shares a flow edge with inside its own parent, a sibling, any
 * node it shares a flow edge with, a node its parent shares one with (a dep edge never anchors; a
 * parent anchors by its first leaf with a point). It takes the first free spot in this order, nearest
 * first, 20 px per step: below the anchor, to its right, to its left; the first child placed in a
 * parent that was once a box tries that box's spot before all of them. A node with no anchor goes
 * below everything. A spot is free when it overlaps no drawn box in `previous` or placed so far, and,
 * near the anchor, when it dirties no frame: its box enters no frame but its ancestors', and their
 * frames, grown round it, meet no box or frame from outside that they did not meet before. Dirt that
 * was there already is left alone and blocks nothing. Past `FRAME_SEARCH` any free spot will do, so
 * the search always ends.
 */
export function place(previous: Layout, shape: Shape): Layout {
  if (Object.keys(previous).length === 0) return relayout(shape);
  const hierarchy = hierarchyOf(shape.nodes);
  const placed = new Map<string, Point>(Object.entries(previous));
  const missing = shape.nodes.flatMap(({ id }) =>
    hierarchy.isLeaf(id) && !placed.has(id) ? [id] : [],
  );
  if (missing.length === 0) return previous;

  const parents = new Set<string>(
    shape.nodes.flatMap(({ id }) => (hierarchy.isLeaf(id) ? [] : [id])),
  );
  const occupied = occupancy();
  for (const [id, point] of placed) if (!parents.has(id)) occupied.add(point);
  const frames = parents.size === 0 ? null : frameIndex(hierarchy, placed);
  const pointOf = (id: StateName): Point | undefined => {
    if (!parents.has(id)) return placed.get(id);
    for (const leaf of hierarchy.within(id)) {
      const point = placed.get(leaf);
      if (point !== undefined) return point;
    }
    return undefined;
  };
  const near = new Map<StateName, StateName[]>();
  for (const edge of shape.edges) {
    if (edge.type !== "flow" || edge.from === edge.to) continue;
    append(near, edge.from, edge.to);
    append(near, edge.to, edge.from);
  }
  const neighbours = (id: StateName): readonly StateName[] => near.get(id) ?? [];
  /** In the order the doc comment gives, without copying a crowd of siblings for every leaf. */
  const anchorOf = (id: Leaf): Point | undefined => {
    const parent = hierarchy.parentOf(id);
    const groups =
      parent === null
        ? [neighbours(id)]
        : [
            neighbours(id).filter((other) => hierarchy.parentOf(other) === parent),
            hierarchy.childrenOf(parent),
            neighbours(id),
            ...hierarchy.ancestorsOf(id).map(neighbours),
          ];
    for (const group of groups) {
      for (const other of group) {
        const point = other === id ? undefined : pointOf(other);
        if (point !== undefined) return point;
      }
    }
    return undefined;
  };
  /** A parent's old point, from when it was a box, for the first leaf placed inside it. */
  const ownOf = (id: Leaf): Point | undefined => {
    const parent = hierarchy.parentOf(id);
    if (parent === null || pointOf(parent) !== undefined) return undefined;
    return placed.get(parent);
  };
  const searched = new Map<string, number>();

  while (missing.length > 0) {
    const anchored = missing.findIndex((id) => anchorOf(id) !== undefined);
    const [id] = missing.splice(Math.max(anchored, 0), 1);
    if (id === undefined) break;
    const anchor = anchorOf(id) ?? occupied.corner();
    const clean = (candidate: Point): boolean => frames?.clean(id, candidate) ?? true;
    const point = freeSpot(anchor, occupied.free, clean, ownOf(id), searched);
    placed.set(id, point);
    occupied.add(point);
    frames?.add(id, point);
  }
  return Object.fromEntries(placed);
}

/**
 * The points `place` keeps its boxes clear of, bucketed by the clearance so a spot is compared with
 * its neighbours only. `corner` is the bottom-left of them, where a node with no anchor goes.
 */
function occupancy() {
  const width = BOX.width + CLEARANCE;
  const height = BOX.height + CLEARANCE;
  const cells = new Map<string, Point[]>();
  const cellOf = (column: number, row: number): string => `${column},${row}`;
  let left = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  return {
    add(point: Point): void {
      const key = cellOf(Math.floor(point.x / width), Math.floor(point.y / height));
      append(cells, key, point);
      left = Math.min(left, point.x);
      bottom = Math.max(bottom, point.y);
    },
    free(candidate: Point): boolean {
      const column = Math.floor(candidate.x / width);
      const row = Math.floor(candidate.y / height);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const near = cells.get(cellOf(column + dx, row + dy)) ?? [];
          if (!near.every((box) => clear(candidate, box))) return false;
        }
      }
      return true;
    },
    corner: (): Point => ({ x: left, y: bottom }),
  };
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** What `enclose` puts round a box, and back: a frame's content is its box less pad and name strip. */
const frameRound = (content: Box): Box => enclose([content]) ?? content;
const contentOf = (frame: Box): Box => ({
  x: frame.x + FRAME.pad,
  y: frame.y + FRAME.pad + FRAME.name,
  width: frame.width - 2 * FRAME.pad,
  height: frame.height - 2 * FRAME.pad - FRAME.name,
});

/**
 * The frames of `place`, kept up to date as leaves land, so a spot is judged on the frames it can
 * change: its ancestors', grown round it, and the frames its box falls in.
 */
function frameIndex(hierarchy: Hierarchy, placed: ReadonlyMap<string, Point>) {
  const boxOf = (leaf: Leaf): Box | undefined => {
    const point = placed.get(leaf);
    return point === undefined ? undefined : boxAt(point);
  };
  const frames = new Map(parentFrames(hierarchy, boxOf).map(({ id, box }) => [id, box]));
  const boxes = hierarchy.leaves.flatMap((leaf) => {
    const box = boxOf(leaf);
    return box === undefined ? [] : [{ leaf, box }];
  });
  /** The frames of `leaf`'s ancestors, nearest first, as they would be with `box` inside. */
  const grown = (leaf: Leaf, box: Box): (readonly [StateName, Box])[] => {
    const chain: (readonly [StateName, Box])[] = [];
    let inner = box;
    for (const parent of hierarchy.ancestorsOf(leaf)) {
      const old = frames.get(parent);
      inner = frameRound(old === undefined ? inner : union(contentOf(old), inner));
      chain.push([parent, inner]);
    }
    return chain;
  };
  return {
    clean(leaf: Leaf, candidate: Point): boolean {
      const box = boxAt(candidate);
      const chain = grown(leaf, box);
      const holders = new Set(chain.map(([parent]) => parent));
      for (const [parent, frame] of frames) {
        if (!holders.has(parent) && overlaps(frame, box)) return false;
      }
      for (const [parent, frame] of chain) {
        const old = frames.get(parent);
        const meets = (other: Box): boolean =>
          overlaps(frame, other) && (old === undefined || !overlaps(old, other));
        for (const [other, otherFrame] of frames) {
          const related = hierarchy.contains(parent, other) || hierarchy.contains(other, parent);
          if (!related && meets(otherFrame)) return false;
        }
        for (const { leaf: stranger, box: theirs } of boxes) {
          if (!hierarchy.contains(parent, stranger) && meets(theirs)) return false;
        }
      }
      return true;
    },
    add(leaf: Leaf, point: Point): void {
      const box = boxAt(point);
      for (const [parent, frame] of grown(leaf, box)) frames.set(parent, frame);
      boxes.push({ leaf, box });
    },
  };
}

/** How far a leaf looks for a spot that keeps every frame clean before it takes any free one. */
const FRAME_SEARCH = 25 * GRID;

/**
 * `first` if it is free and clean, else below, right, left of `anchor`, then each again one grid step
 * further out: a free spot that keeps the frames clean within `FRAME_SEARCH`, else the first free one.
 * `searched` remembers, by anchor, the step the last free spot was found at: no box ever leaves, so
 * no step before it can be free again, and a crowd of siblings does not search the same ring anew.
 */
function freeSpot(
  anchor: Point,
  free: (candidate: Point) => boolean,
  clean: (candidate: Point) => boolean,
  first: Point | undefined,
  searched: Map<string, number>,
): Point {
  if (first !== undefined && free(first) && clean(first)) return first;
  const ring = (step: number): readonly Point[] => [
    { x: anchor.x, y: anchor.y + BOX.height + RANKSEP + step },
    { x: anchor.x + BOX.width + NODESEP + step, y: anchor.y },
    { x: anchor.x - BOX.width - NODESEP - step, y: anchor.y },
  ];
  for (let step = 0; step <= FRAME_SEARCH; step += GRID) {
    const found = ring(step).find((candidate) => free(candidate) && clean(candidate));
    if (found !== undefined) return found;
  }
  const key = `${anchor.x},${anchor.y}`;
  for (let step = searched.get(key) ?? 0; ; step += GRID) {
    const found = ring(step).find(free);
    if (found !== undefined) {
      searched.set(key, step);
      return found;
    }
  }
}

function clear(a: Point, b: Point): boolean {
  return (
    Math.abs(a.x - b.x) >= BOX.width + CLEARANCE || Math.abs(a.y - b.y) >= BOX.height + CLEARANCE
  );
}

/**
 * The whole graph through dagre (TB, 180×64, ranksep 70, nodesep 40), as top-left points of the
 * leaves. A parent is a dagre cluster, so what is inside it stays together and its frame holds no
 * stranger; the gaps grow by the room a frame takes, once per level. dagre throws on some clustered
 * graphs (an edge's end inside a cluster's rectangle), and then the leaves are laid out without
 * clusters, as a graph without `@state-parent` always is: the same call as before it existed. Only
 * ids of `shape`: an explicit relayout drops the reserved spots of absent nodes.
 */
export function relayout(shape: Shape): Layout {
  const hierarchy = hierarchyOf(shape.nodes);
  const leaves = shape.nodes.flatMap(({ id }) => (hierarchy.isLeaf(id) ? [id] : []));
  const levels = Math.max(0, ...leaves.map((leaf) => hierarchy.ancestorsOf(leaf).length));
  if (levels === 0) return layered(shape, hierarchy, leaves, 0);
  try {
    return layered(shape, hierarchy, leaves, levels);
  } catch {
    return layered(shape, hierarchy, leaves, 0);
  }
}

/** One dagre run: with `levels` above 0 each parent is a cluster, with 0 the leaves stand alone. */
function layered(
  shape: Shape,
  hierarchy: Hierarchy,
  leaves: readonly Leaf[],
  levels: number,
): Layout {
  const graph = levels === 0 ? new Graph() : new Graph({ compound: true });
  graph.setGraph({
    rankdir: "TB",
    ranksep: RANKSEP + levels * (FRAME.name + FRAME.pad),
    nodesep: NODESEP + levels * 2 * FRAME.pad,
    marginx: 40,
    marginy: 40,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  /** dagre keys nodes in plain objects, where `constructor` or `__proto__` would meet Object's own. */
  const key = (id: StateName): string => `#${id}`;
  /** dagre joins no edge to a cluster: a parent's edge stands for one from its first leaf. */
  const endOf = (id: StateName): StateName | undefined =>
    hierarchy.has(id) && !hierarchy.isLeaf(id) ? hierarchy.within(id)[0] : id;
  // dagre breaks cycles from the first node it meets, so the initial state goes first and lands on top.
  const initial = shape.model?.initial ?? null;
  const first = initial === null ? [] : leaves.filter((id) => id === endOf(initial));
  for (const id of [...first, ...leaves]) graph.setNode(key(id), { ...BOX });
  if (levels > 0) {
    for (const { id } of shape.nodes) {
      const parent = hierarchy.parentOf(id);
      if (!hierarchy.isLeaf(id)) graph.setNode(key(id), {});
      if (parent !== null) graph.setParent(key(id), key(parent));
    }
  }
  for (const { from, to } of shape.edges) {
    const a = endOf(from);
    const b = endOf(to);
    if (a !== undefined && b !== undefined && a !== b) graph.setEdge(key(a), key(b));
  }
  layout(graph);
  return Object.fromEntries(
    leaves.map((id) => {
      const { x = 0, y = 0 } = graph.node(key(id));
      return [id, { x: Math.round(x - BOX.width / 2), y: Math.round(y - BOX.height / 2) }];
    }),
  );
}

/**
 * Condition 5. An orthogonal polyline from a side of `from` to a side of `to`: every segment is
 * horizontal or vertical and has length, the first point lies on `from`'s border and the last on
 * `to`'s. The arrow marker sits on the last point.
 *
 * `from === to` is a self-loop and leaves the box. `route(a, b)` and `route(b, a)` share no segment.
 * `lane` is the 0-based index of an edge among the edges from `from` to `to`: two lanes of one ordered
 * pair share no segment. A pair of boxes with no gap on either axis has no such guarantee for lanes.
 *
 * Boxes with a gap between them are joined across the wider gap: out of one facing side, along the
 * gap, into the other. Each lane of each direction runs on its own track, offset from the sides'
 * centres, and turns at its own line in the gap. Tracks turn in nested order (the track further along
 * the turn turns first), so no two tracks run along each other. Overlapping boxes get a "C" round the
 * right sides one way and round the left sides the other way.
 */
export function route(from: Box, to: Box, lane = 0): readonly Point[] {
  const track = lane + 1;
  const gapY = Math.max(to.y - (from.y + from.height), from.y - (to.y + to.height));
  const gapX = Math.max(to.x - (from.x + from.width), from.x - (to.x + to.width));
  if (gapY > 0 && gapY >= gapX) {
    const down = to.y > from.y;
    const side = down ? -1 : 1;
    const offset = side * track * LANE;
    const x1 = from.x + from.width / 2 + offset;
    const x2 = to.x + to.width / 2 + offset;
    const y1 = down ? from.y + from.height : from.y;
    const y2 = down ? to.y : to.y + to.height;
    const ym = (y1 + y2) / 2 - Math.sign(x2 - x1) * Math.sign(y2 - y1) * side * turn(track, gapY);
    return tidy([
      { x: x1, y: y1 },
      { x: x1, y: ym },
      { x: x2, y: ym },
      { x: x2, y: y2 },
    ]);
  }
  if (gapX > 0) {
    const right = to.x > from.x;
    const side = right ? -1 : 1;
    const offset = side * track * LANE;
    const y1 = from.y + from.height / 2 + offset;
    const y2 = to.y + to.height / 2 + offset;
    const x1 = right ? from.x + from.width : from.x;
    const x2 = right ? to.x : to.x + to.width;
    const xm = (x1 + x2) / 2 - Math.sign(y2 - y1) * Math.sign(x2 - x1) * side * turn(track, gapX);
    return tidy([
      { x: x1, y: y1 },
      { x: xm, y: y1 },
      { x: xm, y: y2 },
      { x: x2, y: y2 },
    ]);
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const outward = dx > 0 || (dx === 0 && dy >= 0) ? 1 : -1;
  const spread = (dy >= 0 ? 1 : -1) * track * LANE;
  const x1 = outward > 0 ? from.x + from.width : from.x;
  const x2 = outward > 0 ? to.x + to.width : to.x;
  const xc = (outward > 0 ? Math.max(x1, x2) : Math.min(x1, x2)) + outward * track * GRID;
  const y1 = from.y + from.height / 2 - spread;
  const y2 = to.y + to.height / 2 + spread;
  return [
    { x: x1, y: y1 },
    { x: xc, y: y1 },
    { x: xc, y: y2 },
    { x: x2, y: y2 },
  ];
}

/** How far a track's turn sits from the middle of the gap: grows with the track, stays inside the gap. */
function turn(track: number, gap: number): number {
  return Math.min(track * LANE, (gap * track) / (2 * (track + 1)));
}

/** Drops repeated points and points in the middle of a straight run. */
function tidy(points: readonly Point[]): readonly Point[] {
  const kept: Point[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last !== undefined && last.x === point.x && last.y === point.y) continue;
    const before = kept.at(-2);
    if (
      last !== undefined &&
      before !== undefined &&
      ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))
    ) {
      kept.pop();
    }
    kept.push(point);
  }
  return kept;
}

/** A label's height, the air round its text, and how far from a line it stands when beside it. */
const LABEL_HEIGHT = 18;
const LABEL_PADDING = 8;
const LABEL_GAP = 2;

/**
 * The width 13 px text takes: 13 px for a character wider than Latin-1, 7.5 px for the rest, plus
 * 8 px of air.
 */
export function labelWidth(text: string): number {
  return (
    [...text].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) > 0xff ? 13 : 7.5), 0) +
    LABEL_PADDING
  );
}

/** True when the interiors meet; boxes that only touch do not overlap. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Where an edge's label may go, best first, as the box the 13 px text takes (`labelWidth` wide).
 * First on the line: the segments of the polyline from the middle one outwards (the one after it,
 * the one before it, and so on), and on each the midpoint, then the point a quarter of the way
 * along, then three quarters. Then beside the
 * line at the same points (above or below a horizontal segment, right or left of a vertical one),
 * for a line too short to carry its text clear of the boxes it joins, as a self-loop is.
 */
export function labelBoxes(text: string, points: readonly Point[]): readonly Box[] {
  const width = labelWidth(text);
  const centred = (at: Point): Box => ({
    x: at.x - width / 2,
    y: at.y - LABEL_HEIGHT / 2,
    width,
    height: LABEL_HEIGHT,
  });
  const segments = points.flatMap((a, index) => {
    const b = points[index + 1];
    return b === undefined ? [] : [{ a, b }];
  });
  const middle = Math.floor(segments.length / 2);
  const order = [middle];
  for (let reach = 1; order.length < segments.length; reach++) {
    if (middle + reach < segments.length) order.push(middle + reach);
    if (middle - reach >= 0) order.push(middle - reach);
  }
  const spots = order.flatMap((index) => {
    const segment = segments[index];
    if (segment === undefined) return [];
    const { a, b } = segment;
    return [0.5, 0.25, 0.75].map((t) => ({
      at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
      upright: a.x === b.x,
    }));
  });
  const beside = spots.flatMap(({ at, upright }) => {
    const reach = upright ? width / 2 + LABEL_GAP : LABEL_HEIGHT / 2 + LABEL_GAP;
    return upright
      ? [centred({ x: at.x + reach, y: at.y }), centred({ x: at.x - reach, y: at.y })]
      : [centred({ x: at.x, y: at.y - reach }), centred({ x: at.x, y: at.y + reach })];
  });
  return [...spots.map(({ at }) => centred(at)), ...beside];
}

/** A dropped box lands on the 20 px grid, like draw.io. */
export function snap(point: Point): Point {
  return { x: Math.round(point.x / GRID) * GRID, y: Math.round(point.y / GRID) * GRID };
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
  const body: [string, Point][] = [];
  let due = false;
  for (const { id } of o.graph.nodes) {
    const point = pointIn(o.layout, id);
    if (point === undefined) continue;
    body.push([id, point]);
    const saved = pointIn(o.saved, id);
    due ||= saved === undefined || saved.x !== point.x || saved.y !== point.y;
  }
  return due ? Object.fromEntries(body) : null;
}
