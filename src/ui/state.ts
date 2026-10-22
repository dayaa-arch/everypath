import type {
  Counterexample,
  Graph,
  PropertyId,
  PropertyResult,
  StateName,
  Step,
} from "../core/types.js";
import { type Point, place, relayout, snap } from "./layout.js";
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
  return {
    graph: null,
    layout: saved,
    connection: "connecting",
    tlc: { kind: "idle" },
    selection: NONE,
    showDeps: true,
    notice: null,
  };
}

const NONE: Selection = { kind: "none" };

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
  switch (action.kind) {
    case "graph": {
      const { graph } = action.event;
      const stranded = state.connection !== "live" && state.tlc.kind === "running";
      return {
        ...state,
        graph,
        layout: place(state.layout, graph),
        connection: "live",
        tlc: stranded ? { kind: "idle" } : state.tlc,
        selection: reselect(state.selection, graph),
      };
    }
    case "offline":
      return state.connection === "offline" ? state : { ...state, connection: "offline" };
    case "tlc":
      return { ...state, tlc: tlcView(action.event) };
    case "select": {
      if (action.id === null)
        return state.selection.kind === "none" ? state : { ...state, selection: NONE };
      const node = state.graph?.nodes.find((n) => n.id === action.id);
      if (state.graph === null || node === undefined) return state;
      const first = node.violations
        .map((property) => ({ property, index: 0 }))
        .find((target) => traceOf(state.graph, target) !== undefined);
      const replay = first === undefined ? null : { ...first, step: 0 };
      return { ...state, selection: { kind: "node", id: node.id, replay } };
    }
    case "replay": {
      const selection = state.selection;
      if (selection.kind !== "node") return state;
      if (action.target === null) {
        return selection.replay === null
          ? state
          : { ...state, selection: { ...selection, replay: null } };
      }
      if (traceOf(state.graph, action.target) === undefined) return state;
      return { ...state, selection: { ...selection, replay: { ...action.target, step: 0 } } };
    }
    case "step": {
      const selection = state.selection;
      const replay = replayOf(state);
      if (selection.kind !== "node" || selection.replay === null || replay === null) return state;
      const last = replay.trace.steps.length - 1;
      const step = Math.min(last, Math.max(0, replay.step + action.delta));
      if (step === replay.step) return state;
      return { ...state, selection: { ...selection, replay: { ...selection.replay, step } } };
    }
    case "move":
      if (!state.graph?.nodes.some((n) => n.id === action.id)) return state;
      return { ...state, layout: { ...state.layout, [action.id]: snap(action.to) } };
    case "relayout":
      return state.graph === null ? state : { ...state, layout: relayout(state.graph) };
    case "toggle-deps":
      return { ...state, showDeps: !state.showDeps };
    case "notice":
      return state.notice === action.text ? state : { ...state, notice: action.text };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function tlcView(event: TlcEvent): TlcView {
  switch (event.status) {
    case "running":
      return { kind: "running" };
    case "done":
      return { kind: "done", states: event.states, message: event.message };
    case "error":
      return {
        kind: "error",
        message: event.message ?? "全探索が失敗しました（理由は届いていません）",
      };
    default: {
      const _exhaustive: never = event.status;
      return _exhaustive;
    }
  }
}

function reselect(selection: Selection, graph: Graph): Selection {
  if (selection.kind === "none") return selection;
  if (!graph.nodes.some((n) => n.id === selection.id)) return NONE;
  const { replay } = selection;
  if (replay === null) return selection;
  const found = traceOf(graph, replay);
  if (found === undefined) return { ...selection, replay: null };
  const step = Math.min(replay.step, found.trace.steps.length - 1);
  return step === replay.step ? selection : { ...selection, replay: { ...replay, step } };
}

/** SPEC §11: a TLC verdict on a model that has changed since the run marks no node. */
export function isLiveViolation(property: PropertyResult): boolean {
  return property.result === "violated" && property.staleModel !== true;
}

function traceOf(
  graph: Graph | null,
  target: { readonly property: PropertyId; readonly index: number },
): { readonly property: PropertyResult; readonly trace: Counterexample } | undefined {
  const property = graph?.properties.find((p) => p.id === target.property && isLiveViolation(p));
  const trace = property?.counterexamples[target.index];
  return property === undefined || trace === undefined ? undefined : { property, trace };
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
  const { selection } = state;
  if (selection.kind !== "node" || selection.replay === null) return null;
  const found = traceOf(state.graph, selection.replay);
  const current = found?.trace.steps[selection.replay.step];
  if (found === undefined || current === undefined) return null;
  return {
    node: selection.id,
    property: found.property,
    trace: found.trace,
    step: selection.replay.step,
    current,
    loopStart: found.trace.loopStart,
  };
}
