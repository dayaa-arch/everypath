import type {
  Counterexample,
  Graph,
  PropertyId,
  PropertyResult,
  StateName,
  Step,
} from "../core/types.js";
import type { Point } from "./layout.js";
import type { GraphEvent, Layout, TlcEvent } from "./wire.js";

/** What the header says about TLC. `done` with M violations is read from the graph, not stored. */
export type TlcView =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly states: number | null; readonly message: string | null }
  | { readonly kind: "error"; readonly message: string };

/** A counterexample being replayed, by reference into `graph.properties`. Resolved by `replayOf`. */
export type ReplayRef = {
  readonly property: PropertyId;
  /** Index into the property's `counterexamples`. */
  readonly index: number;
  /** 0 <= step < steps.length, kept so by `reduce`. */
  readonly step: number;
};

/** A replay always belongs to a selected node: a trace with no node to show cannot be built. */
export type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "node"; readonly id: StateName; readonly replay: ReplayRef | null };

/**
 * Everything the screen shows. Pan, zoom and the drag in progress live in render.ts.
 *
 * Deviations from docs/specs/viewer.md "データの形": no `recent` (the pulse is derived from
 * `node.lastChangedAt`); no `layout` action (the saved layout is the initial state); `connection`
 * has no action of its own (it is "live" after any graph and "offline" after `offline`); `tlc`
 * splits `finished` into `done` and `error`; `notice` holds the server's answer to a refused request.
 */
export type ViewState = {
  readonly graph: Graph | null;
  /** Every node placed this session, present or not. Only `graph`, `move` and `relayout` change it. */
  readonly layout: Layout;
  readonly connection: "connecting" | "live" | "offline";
  readonly tlc: TlcView;
  readonly selection: Selection;
  readonly showDeps: boolean;
  readonly notice: string | null;
};

export type Action =
  | { readonly kind: "graph"; readonly event: GraphEvent }
  | { readonly kind: "offline" }
  | { readonly kind: "tlc"; readonly event: TlcEvent }
  | { readonly kind: "select"; readonly id: StateName | null }
  | {
      readonly kind: "replay";
      readonly target: { readonly property: PropertyId; readonly index: number } | null;
    }
  | { readonly kind: "step"; readonly delta: 1 | -1 }
  | { readonly kind: "move"; readonly id: StateName; readonly to: Point }
  | { readonly kind: "relayout" }
  | { readonly kind: "toggle-deps" }
  | { readonly kind: "notice"; readonly text: string | null };

/**
 * No graph, `saved` as the layout, "connecting", TLC idle, nothing selected, dep edges shown, no
 * notice.
 */
export function initialState(saved: Layout): ViewState {
  void saved;
  throw new Error("not implemented");
}

/**
 * Condition 6. Total and pure. Returns `state` itself when an action changes nothing, so the caller
 * can skip a frame.
 *
 * - graph: `graph` is the event's; `layout = place(layout, graph)`; connection "live". A TLC
 *   "running" left from before the connection was lost becomes "idle" (the server re-sends "running"
 *   after its first graph if a run is still going). Selection: a node that is gone becomes none; a
 *   replay whose property is no longer violated, or whose counterexample is gone, becomes null;
 *   otherwise its step is clamped to the new trace.
 * - offline: connection "offline"; graph, layout and selection stay, so the picture stays readable.
 * - tlc: "running" is running; "done" is done with the event's states and message; "error" is error
 *   with the event's message (a fallback text when it has none).
 * - select: null is none. An id not in the graph changes nothing. Otherwise the node is selected with
 *   the first counterexample of its first live violation at step 0, or no replay.
 * - replay: needs a selected node. null drops the replay; a target that resolves starts at step 0;
 *   one that does not changes nothing.
 * - step: needs a replay. Moves by `delta` and stops at 0 and at the last step; it does not wrap.
 * - move: the node must be in the graph; its point becomes the snapped target.
 * - relayout: needs a graph; `layout = relayout(graph)`; selection kept.
 * - toggle-deps flips `showDeps`. notice sets `notice`.
 */
export function reduce(state: ViewState, action: Action): ViewState {
  void state;
  void action;
  throw new Error("not implemented");
}

/** A replay resolved against the current graph. `loopStart` is where an infinite trace repeats from. */
export type Replay = {
  readonly node: StateName;
  readonly property: PropertyResult;
  readonly trace: Counterexample;
  readonly step: number;
  readonly current: Step;
  readonly loopStart: number | null;
};

/** The selected replay, or null. Panel, canvas and tests all read the trace through this function. */
export function replayOf(state: ViewState): Replay | null {
  void state;
  throw new Error("not implemented");
}
