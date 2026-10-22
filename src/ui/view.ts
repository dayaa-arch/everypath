import type { FlowEdge, Graph, PropertyResult, StateName, StateNode } from "../core/types.js";
import type { Box, Point } from "./layout.js";
import type { ViewState } from "./state.js";

export type Tone =
  | "danger"
  | "planned"
  | "wip"
  | "untested"
  | "changed"
  | "unreviewed"
  | "proven"
  | "approved";

/** How one tone looks. Colors are CSS colors; `dash` is an SVG `stroke-dasharray`, null for solid. */
export type ToneRow = {
  readonly tone: Tone;
  readonly label: string;
  readonly fill: string;
  readonly stroke: string;
  readonly width: number;
  readonly dash: string | null;
  /** True for the two tones a reviewer is done with (blue and green). */
  readonly settled: boolean;
};

/**
 * SPEC §7.2 as ONE table: priority is row order, the first matching row wins, the last row is the
 * fallback. `toneOf`, the legend, the canvas colors, the header counts and the review queue all read
 * it, so a color never disagrees with a count. Tone, priority, label, fill, stroke, width, dash and
 * `settled` of every row live here and nowhere else.
 */
export const TONES: readonly ToneRow[] = [];

/**
 * Condition 4. A violation counts only while its property is `violated` and not `staleModel`.
 * `proof == "failed"` is `danger` too.
 */
export function toneOf(node: StateNode, properties: readonly PropertyResult[]): Tone {
  void node;
  void properties;
  throw new Error("not implemented");
}

/** The properties a person must look at: violated on the current model. Header and TLC summary count these. */
export function violated(graph: Graph): readonly PropertyResult[] {
  void graph;
  throw new Error("not implemented");
}

/**
 * Nodes whose tone is not settled, in `TONES` order, then id. The header's "未レビュー N" is its
 * length and its "脆弱性 N" its danger rows, so the counts can never disagree with the colors.
 */
export function reviewQueue(
  graph: Graph,
): readonly { readonly node: StateNode; readonly tone: Tone }[] {
  void graph;
  throw new Error("not implemented");
}

/** `on:` event, then `[guard]` (SPEC §12.1). Printed from the AST with SPEC §5.1's operators. */
export function edgeLabel(edge: FlowEdge): string {
  void edge;
  throw new Error("not implemented");
}

/** A box being dragged and where it is now (world coordinates, unsnapped). */
export type Drag = { readonly id: StateName; readonly at: Point };

export type SceneItem =
  | {
      readonly kind: "box";
      readonly id: StateName;
      readonly box: Box;
      readonly tone: Tone;
      readonly title: string;
      /** The tone's label, shown under the name. */
      readonly caption: string;
      readonly selected: boolean;
      /** The state of the replay's current step. */
      readonly current: boolean;
      /** ms since `lastChangedAt` while under 30 s, else null. */
      readonly age: number | null;
    }
  | {
      readonly kind: "line";
      readonly look: "flow" | "dep" | "trail";
      readonly points: readonly Point[];
      /** Parallel flow edges between one pair are one line; their labels join with " / ". */
      readonly label: string | null;
    }
  | {
      readonly kind: "callout";
      /** The box it sits beside. */
      readonly box: Box;
      /** "step 2/3", "event: forgot", "authed = FALSE", "retries = 0", "↺ 繰り返し" */
      readonly lines: readonly string[];
    };

/**
 * The canvas as data. `live` is everything that moves with the dragged box (the box, its edges, trail
 * segments and callout touching it); `base` is the rest. With no drag, `live` is empty. Each list is
 * in paint order: dep lines, flow lines, trail, boxes, callout.
 */
export type Scene = {
  readonly base: readonly SceneItem[];
  readonly live: readonly SceneItem[];
  /** Bounding box of the drawn boxes, for the first fit-to-view. null for an empty graph. */
  readonly bounds: Box | null;
};

/** Pure: the same state, `now` and drag give the same scene. A node without a point is not drawn. */
export function sceneOf(
  state: ViewState,
  frame: { readonly now: number; readonly drag: Drag | null },
): Scene {
  void state;
  void frame;
  throw new Error("not implemented");
}
