import type { PromptKind, PromptTemplates } from "../core/prompts.js";
import type {
  Counterexample,
  Graph,
  HistoryEntry,
  PropertyId,
  PropertyResult,
  StateName,
  StateNode,
  Step,
} from "../core/types.js";
import { isLiveViolation, selectedIds } from "./facts.js";
import { type Point, place, relayout, snap } from "./layout.js";
import { buildPrompt, type Prompt } from "./prompt.js";
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

/**
 * A replay always belongs to one selected node: a trace with no node to show cannot be built, and
 * several nodes have no single trace to follow.
 */
export type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "node"; readonly id: StateName; readonly replay: ReplayRef | null }
  | { readonly kind: "many"; readonly ids: readonly [StateName, StateName, ...StateName[]] };

/** What the last read of `/tla/Model.tla` found. */
export type ModelText =
  | { readonly kind: "unknown" }
  | { readonly kind: "loaded"; readonly text: string }
  | { readonly kind: "missing"; readonly message: string };

/**
 * Everything the screen shows. Pan, zoom and the drag in progress live in render.ts.
 *
 * Deviations from docs/specs/viewer.md "データの形": no `recent` (the pulse is derived from
 * `node.lastChangedAt`); no `layout` action (the saved layout is the initial state); `connection`
 * has no action of its own (it is "live" after any graph and "offline" after `offline`); `tlc`
 * splits `finished` into `done` and `error`; `notice` holds the server's answer to a refused request.
 * docs/specs/viewer-panels.md adds the two tabs, the change log, the text of `Model.tla`, the
 * templates and the instruction last generated.
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
  readonly panelTab: "detail" | "model";
  readonly dockTab: "queue" | "log";
  /** Oldest first, at most `HISTORY_LIMIT`, no entry twice. */
  readonly history: readonly HistoryEntry[];
  readonly model: ModelText;
  /** Null until `/templates.json` has been read. */
  readonly templates: PromptTemplates | null;
  /** The instruction last generated for the current selection; any change of selection drops it. */
  readonly prompt: Prompt | null;
};

export type Action =
  | { readonly kind: "graph"; readonly event: GraphEvent }
  | { readonly kind: "offline" }
  | { readonly kind: "tlc"; readonly event: TlcEvent }
  | { readonly kind: "select"; readonly id: StateName | null; readonly extend: boolean }
  | {
      readonly kind: "replay";
      readonly target: { readonly property: PropertyId; readonly index: number } | null;
    }
  | { readonly kind: "step"; readonly delta: 1 | -1 }
  | { readonly kind: "move"; readonly id: StateName; readonly to: Point }
  | { readonly kind: "relayout" }
  | { readonly kind: "toggle-deps" }
  | { readonly kind: "notice"; readonly text: string | null }
  | { readonly kind: "history"; readonly entries: readonly HistoryEntry[] }
  | { readonly kind: "model"; readonly model: ModelText }
  | { readonly kind: "templates"; readonly templates: PromptTemplates }
  | { readonly kind: "tab"; readonly panel: ViewState["panelTab"] }
  | { readonly kind: "tab"; readonly dock: ViewState["dockTab"] }
  | { readonly kind: "generate"; readonly prompt: PromptKind }
  | { readonly kind: "dismiss-prompt" };

/**
 * No graph, `saved` as the layout, "connecting", TLC idle, nothing selected, dep edges shown, no
 * notice, the detail and queue tabs, no history, no model text, no templates, no instruction.
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
    panelTab: "detail",
    dockTab: "queue",
    history: [],
    model: { kind: "unknown" },
    templates: null,
    prompt: null,
  };
}

const NONE: Selection = { kind: "none" };
/** The change log keeps this many entries, the same as `GET /history.json` sends. */
const HISTORY_LIMIT = 200;

/**
 * Condition 6. Total and pure. Returns `state` itself when an action changes nothing, so the caller
 * can skip a frame.
 *
 * - graph: `graph` is the event's; `layout = place(layout, graph)`; connection "live". A TLC
 *   "running" left from before the connection was lost becomes "idle" (the server re-sends "running"
 *   after its first graph if a run is still going). Selection: a node that is gone becomes none; a
 *   replay whose property is no longer violated, or whose counterexample is gone, becomes null;
 *   otherwise its step is clamped to the new trace; a many selection drops the nodes that are gone
 *   (one left is a node, none is none). The event's `diff` joins `history`.
 * - offline: connection "offline"; graph, layout and selection stay, so the picture stays readable.
 * - tlc: "running" is running; "done" is done with the event's states and message; "error" is error
 *   with the event's message (a fallback text when it has none).
 * - select: null is none. An id not in the graph changes nothing. Otherwise the node is selected with
 *   the first counterexample of its first live violation at step 0, or no replay. With `extend`, the
 *   node joins the selection (leaves it if it is in), and a many selection down to one is that node
 *   as plain select makes it. Whenever the selected nodes change, `prompt` is dropped.
 * - replay: needs a selected node. null drops the replay; a target that resolves starts at step 0;
 *   one that does not changes nothing.
 * - step: needs a replay. Moves by `delta` and stops at 0 and at the last step; it does not wrap.
 * - move: the node must be in the graph; its point becomes the snapped target.
 * - relayout: needs a graph; `layout = relayout(graph)`; selection kept.
 * - toggle-deps flips `showDeps`. notice sets `notice`.
 * - history merges entries into `history` (see `mergeHistory`). model, templates and tab set their
 *   field. generate keeps the instruction built from the selection and the templates, and changes
 *   nothing when it cannot be built. dismiss-prompt drops it.
 */
export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.kind) {
    case "graph": {
      const { graph } = action.event;
      const stranded = state.connection !== "live" && state.tlc.kind === "running";
      const selection = reselect(state.selection, graph);
      const { diff } = action.event;
      return {
        ...state,
        graph,
        layout: place(state.layout, graph),
        connection: "live",
        tlc: stranded ? { kind: "idle" } : state.tlc,
        selection,
        history: diff === null ? state.history : mergeHistory(state.history, [diff]),
        prompt: sameNodes(state.selection, selection) ? state.prompt : null,
      };
    }
    case "offline":
      return state.connection === "offline" ? state : { ...state, connection: "offline" };
    case "tlc":
      return { ...state, tlc: tlcView(action.event) };
    case "select": {
      if (action.id === null) return withSelection(state, NONE);
      const node = state.graph?.nodes.find((n) => n.id === action.id);
      if (state.graph === null || node === undefined) return state;
      return withSelection(
        state,
        action.extend
          ? extendSelection(state.selection, state.graph, node)
          : startAt(state.graph, node),
      );
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
    case "history": {
      const history = mergeHistory(state.history, action.entries);
      return history === state.history ? state : { ...state, history };
    }
    case "model":
      return sameModel(state.model, action.model) ? state : { ...state, model: action.model };
    case "templates":
      return state.templates !== null && sameTemplates(state.templates, action.templates)
        ? state
        : { ...state, templates: action.templates };
    case "tab":
      if ("panel" in action) {
        return state.panelTab === action.panel ? state : { ...state, panelTab: action.panel };
      }
      return state.dockTab === action.dock ? state : { ...state, dockTab: action.dock };
    case "generate": {
      const prompt = buildPrompt(action.prompt, state);
      return prompt === null ? state : { ...state, prompt };
    }
    case "dismiss-prompt":
      return state.prompt === null ? state : { ...state, prompt: null };
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
  switch (selection.kind) {
    case "none":
      return selection;
    case "many": {
      const ids = selection.ids.filter((id) => graph.nodes.some((n) => n.id === id));
      return ids.length === selection.ids.length ? selection : fromIds(graph, ids);
    }
    case "node": {
      if (!graph.nodes.some((n) => n.id === selection.id)) return NONE;
      const { replay } = selection;
      if (replay === null) return selection;
      const found = traceOf(graph, replay);
      if (found === undefined) return { ...selection, replay: null };
      const step = Math.min(replay.step, found.trace.steps.length - 1);
      return step === replay.step ? selection : { ...selection, replay: { ...replay, step } };
    }
    default: {
      const _exhaustive: never = selection;
      return _exhaustive;
    }
  }
}

/** One node selected the way a plain click does: the first counterexample of its first live violation. */
function startAt(graph: Graph, node: StateNode): Selection {
  const first = node.violations
    .map((property) => ({ property, index: 0 }))
    .find((target) => traceOf(graph, target) !== undefined);
  return { kind: "node", id: node.id, replay: first === undefined ? null : { ...first, step: 0 } };
}

/** None, one node, or many, from the ids (all in the graph) in the order given. */
function fromIds(graph: Graph, ids: readonly StateName[]): Selection {
  const [first, second, ...rest] = ids;
  if (first === undefined) return NONE;
  if (second !== undefined) return { kind: "many", ids: [first, second, ...rest] };
  const node = graph.nodes.find((n) => n.id === first);
  return node === undefined ? NONE : startAt(graph, node);
}

/** A Shift-click: the node joins the selection, or leaves it when it is already in. */
function extendSelection(selection: Selection, graph: Graph, node: StateNode): Selection {
  const ids = selectedIds(selection);
  return fromIds(
    graph,
    ids.includes(node.id) ? ids.filter((id) => id !== node.id) : [...ids, node.id],
  );
}

function sameNodes(a: Selection, b: Selection): boolean {
  const left = selectedIds(a);
  const right = selectedIds(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Sets the selection; the instruction made for other nodes goes. Nothing to do for none over none. */
function withSelection(state: ViewState, selection: Selection): ViewState {
  if (selection.kind === "none" && state.selection.kind === "none") return state;
  const prompt = sameNodes(state.selection, selection) ? state.prompt : null;
  return { ...state, selection, prompt };
}

/**
 * `incoming` joined to `history`: an entry whose JSON is already there is left out, the rest are
 * ordered by `at` (stable, so entries of one instant keep the order they came in) and only the
 * latest `HISTORY_LIMIT` stay. The same array comes back when `incoming` adds nothing.
 */
function mergeHistory(
  history: readonly HistoryEntry[],
  incoming: readonly HistoryEntry[],
): readonly HistoryEntry[] {
  const seen = new Set(history.map((entry) => JSON.stringify(entry)));
  const added = incoming.filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (added.length === 0) return history;
  return [...history, ...added]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-HISTORY_LIMIT);
}

function sameModel(a: ModelText, b: ModelText): boolean {
  if (a.kind === "loaded") return b.kind === "loaded" && a.text === b.text;
  if (a.kind === "missing") return b.kind === "missing" && a.message === b.message;
  return b.kind === "unknown";
}

function sameTemplates(a: PromptTemplates, b: PromptTemplates): boolean {
  return (Object.keys(a) as PromptKind[]).every(
    (kind) => a[kind].text === b[kind].text && a[kind].source === b[kind].source,
  );
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
