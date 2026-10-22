import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROMPT_KINDS, type PromptTemplates } from "../src/core/prompts.js";
import type { Graph, HistoryEntry } from "../src/core/types.js";
import { relayout } from "../src/ui/layout.js";
import { type Action, initialState, reduce, replayOf, type ViewState } from "../src/ui/state.js";
import type { Layout } from "../src/ui/wire.js";
import {
  counterexample,
  flow,
  graph,
  graphEvent,
  name,
  node,
  property,
  propertyId,
  tlcEvent,
} from "./helpers/ui-fixtures.js";

function auth(retries: string): readonly (readonly [string, string])[] {
  return [
    ["authed", "FALSE"],
    ["retries", retries],
  ];
}

/** `no-unauth-home` is violated by Login, Reset, Home: a finite trace of three steps. */
const TRACE = counterexample(["Login", "Reset", "Home"], {
  vars: [auth("0"), auth("1"), auth("1")],
});
const SHORT_TRACE = counterexample(["Reset", "Home"]);
const FINITE = property("no-unauth-home", "violated", [TRACE]);
const FINITE_ID = propertyId("no-unauth-home");

function authGraph(properties = [FINITE], violations = [FINITE_ID]): Graph {
  return graph({
    nodes: [
      node("Login", { violations }),
      node("Reset", { violations }),
      node("Home", { violations }),
      node("Settings"),
    ],
    edges: [
      flow("Login", "Reset", "forgot"),
      flow("Reset", "Home", "reset_done"),
      flow("Home", "Settings"),
    ],
    properties,
  });
}

/** A leads-to counterexample: Login, Reset, Home, then back to Reset forever. */
const LOOPING = property("reset-ends", "violated", [
  counterexample(["Login", "Reset", "Home"], { loopStart: 1 }),
]);
const LOOPING_ID = propertyId("reset-ends");

function loopGraph(): Graph {
  return graph({
    nodes: [
      node("Login", { violations: [LOOPING_ID] }),
      node("Reset", { violations: [LOOPING_ID] }),
      node("Home", { violations: [LOOPING_ID] }),
    ],
    edges: [flow("Login", "Reset"), flow("Reset", "Home"), flow("Home", "Reset")],
    properties: [LOOPING],
  });
}

function run(initial: ViewState, ...actions: readonly Action[]): ViewState {
  return actions.reduce(reduce, initial);
}

function fresh(...actions: readonly Action[]): ViewState {
  return run(initialState({}), ...actions);
}

const graphAction = (g: Graph, reason = "watch"): Action => ({
  kind: "graph",
  event: graphEvent(g, reason),
});
const select = (id: string | null): Action => ({
  kind: "select",
  id: id === null ? null : name(id),
  extend: false,
});
const shift = (id: string): Action => ({ kind: "select", id: name(id), extend: true });
const forward: Action = { kind: "step", delta: 1 };
const back: Action = { kind: "step", delta: -1 };

function times(action: Action, count: number): Action[] {
  return Array.from({ length: count }, () => action);
}

function stepOf(state: ViewState): number | undefined {
  return replayOf(state)?.step;
}

function selectedReplay(state: ViewState) {
  return state.selection.kind === "node" ? state.selection.replay : null;
}

describe("the first state", () => {
  it("has no graph, the saved layout, a connection being made and dependency edges shown", () => {
    const saved: Layout = { Home: { x: 40, y: 40 } };
    assert.deepEqual(initialState(saved), {
      graph: null,
      layout: saved,
      connection: "connecting",
      tlc: { kind: "idle" },
      selection: { kind: "none" },
      showDeps: true,
      notice: null,
      panelTab: "detail",
      dockTab: "queue",
      history: [],
      model: { kind: "unknown" },
      templates: null,
      prompt: null,
    });
  });
});

describe("a graph event", () => {
  it("shows the graph, goes live and places every node, keeping the saved points", () => {
    const g = authGraph();
    const saved: Layout = { Home: { x: 503, y: 497 }, Gone: { x: 9, y: 9 } };
    const state = run(initialState(saved), graphAction(g));
    assert.equal(state.graph, g);
    assert.equal(state.connection, "live");
    assert.deepEqual(state.layout.Home, { x: 503, y: 497 });
    assert.deepEqual(state.layout.Gone, { x: 9, y: 9 });
    for (const { id } of g.nodes) assert.ok(state.layout[id] !== undefined, `${id} has a point`);
  });

  it("places a whole graph with no saved layout", () => {
    const state = fresh(graphAction(authGraph()));
    assert.deepEqual(Object.keys(state.layout).sort(), ["Home", "Login", "Reset", "Settings"]);
  });

  it("moves no existing node when a later graph adds or removes one", () => {
    const small = graph({ nodes: [node("Login"), node("Home")], edges: [flow("Login", "Home")] });
    const bigger = graph({
      nodes: [node("Login"), node("Home"), node("Settings")],
      edges: [flow("Login", "Home"), flow("Home", "Settings")],
    });
    const smaller = graph({ nodes: [node("Login")] });

    const first = fresh(graphAction(small));
    const grown = run(first, graphAction(bigger));
    assert.deepEqual(grown.layout.Login, first.layout.Login);
    assert.deepEqual(grown.layout.Home, first.layout.Home);
    assert.ok(grown.layout.Settings !== undefined);

    const shrunk = run(grown, graphAction(smaller));
    assert.deepEqual(shrunk.layout.Login, first.layout.Login);

    const regrown = run(shrunk, graphAction(bigger));
    assert.deepEqual(regrown.layout.Home, first.layout.Home);
    assert.deepEqual(regrown.layout.Settings, grown.layout.Settings);
  });
});

describe("selection and the counterexample replay", () => {
  it("opens the first counterexample of a violated node at step 0", () => {
    const state = fresh(graphAction(authGraph()), select("Login"));
    assert.deepEqual(state.selection, {
      kind: "node",
      id: name("Login"),
      replay: { property: FINITE_ID, index: 0, step: 0 },
    });
    const replay = replayOf(state);
    assert.equal(replay?.step, 0);
    assert.equal(replay?.current.state, name("Login"));
    assert.equal(replay?.loopStart, null);
  });

  it("replays the first violation a node lists", () => {
    const g = graph({
      nodes: [node("Login", { violations: [LOOPING_ID, FINITE_ID] }), node("Reset"), node("Home")],
      properties: [LOOPING, FINITE],
    });
    const state = fresh(graphAction(g), select("Login"));
    assert.equal(replayOf(state)?.property.id, LOOPING_ID);
  });

  it("selects a node without a violation and replays nothing", () => {
    const state = fresh(graphAction(authGraph()), select("Settings"));
    assert.deepEqual(state.selection, { kind: "node", id: name("Settings"), replay: null });
    assert.equal(replayOf(state), null);
  });

  it("clears the selection and its replay when null is selected", () => {
    const state = fresh(graphAction(authGraph()), select("Login"), select(null));
    assert.deepEqual(state.selection, { kind: "none" });
    assert.equal(replayOf(state), null);
  });

  it("starts a replay of the counterexample chosen from the panel at step 0", () => {
    const two = property("no-unauth-home", "violated", [TRACE, SHORT_TRACE]);
    const state = fresh(graphAction(authGraph([two])), select("Reset"), forward, {
      kind: "replay",
      target: { property: FINITE_ID, index: 1 },
    });
    assert.deepEqual(selectedReplay(state), { property: FINITE_ID, index: 1, step: 0 });
    assert.equal(replayOf(state)?.current.state, name("Reset"));
    assert.equal(selectedReplay(reduce(state, { kind: "replay", target: null })), null);
  });

  it("shows the state and variable values of the step it is on", () => {
    const state = fresh(graphAction(authGraph()), select("Login"), forward, forward);
    const replay = replayOf(state);
    assert.equal(replay?.step, 2);
    assert.equal(replay?.current.state, name("Home"));
    assert.deepEqual(replay?.current.vars, { authed: "FALSE", retries: "1" });
    assert.equal(replay?.trace.steps.length, 3);
  });

  it("stops at the last step and at the first, without wrapping", () => {
    const atEnd = fresh(graphAction(authGraph()), select("Login"), ...times(forward, 5));
    assert.equal(stepOf(atEnd), 2);
    assert.equal(replayOf(atEnd)?.current.state, name("Home"));

    const atStart = run(atEnd, ...times(back, 5));
    assert.equal(stepOf(atStart), 0);
    assert.equal(replayOf(atStart)?.current.state, name("Login"));

    assert.equal(stepOf(run(atEnd, back)), 1);
  });

  it("keeps where a looping counterexample repeats from, and does not walk the loop", () => {
    const start = fresh(graphAction(loopGraph()), select("Login"));
    assert.equal(replayOf(start)?.loopStart, 1);
    const end = run(start, ...times(forward, 6));
    assert.equal(stepOf(end), 2);
    assert.equal(replayOf(end)?.loopStart, 1);
    assert.equal(replayOf(run(end, ...times(back, 6)))?.loopStart, 1);
  });
});

describe("a graph event while a node is selected", () => {
  const replaying = () => fresh(graphAction(authGraph()), select("Home"), forward);

  it("keeps the selection and the step while the violation stands", () => {
    const state = run(replaying(), graphAction(authGraph()));
    assert.deepEqual(state.selection, {
      kind: "node",
      id: name("Home"),
      replay: { property: FINITE_ID, index: 0, step: 1 },
    });
  });

  it("drops the replay, not the selection, when the violation disappears", () => {
    const fixed = authGraph([property("no-unauth-home", "ok")], []);
    const state = run(replaying(), graphAction(fixed));
    assert.deepEqual(state.selection, { kind: "node", id: name("Home"), replay: null });
    assert.equal(replayOf(state), null);
  });

  it("clears the selection when its node disappears", () => {
    const without = graph({ nodes: [node("Login")] });
    assert.deepEqual(run(replaying(), graphAction(without)).selection, { kind: "none" });
  });

  it("stops the step at the end of a shorter counterexample", () => {
    const shorter = property("no-unauth-home", "violated", [counterexample(["Login", "Home"])]);
    const state = run(replaying(), forward, graphAction(authGraph([shorter])));
    assert.equal(stepOf(state), 1);
    assert.equal(replayOf(state)?.trace.steps.length, 2);
  });

  it("drops the replay when its counterexample is gone", () => {
    const two = property("no-unauth-home", "violated", [TRACE, SHORT_TRACE]);
    const chosen = fresh(graphAction(authGraph([two])), select("Reset"), {
      kind: "replay",
      target: { property: FINITE_ID, index: 1 },
    });
    assert.deepEqual(selectedReplay(chosen), { property: FINITE_ID, index: 1, step: 0 });
    assert.equal(selectedReplay(run(chosen, graphAction(authGraph()))), null);
  });
});

describe("the connection", () => {
  it("is live after a graph and offline after the stream drops, keeping the picture", () => {
    const g = authGraph();
    const live = fresh(graphAction(g), select("Login"));
    assert.equal(live.connection, "live");

    const offline = reduce(live, { kind: "offline" });
    assert.equal(offline.connection, "offline");
    assert.equal(offline.graph, g);
    assert.equal(offline.layout, live.layout);
    assert.equal(offline.selection, live.selection);

    const reconnected = reduce(offline, graphAction(g, "connect"));
    assert.equal(reconnected.connection, "live");
    assert.equal(reconnected.graph, g);
  });

  it("is offline before the first graph when the server never answers", () => {
    const state = fresh({ kind: "offline" });
    assert.equal(state.connection, "offline");
    assert.equal(state.graph, null);
  });

  it("takes the new graph on reconnect and places only the nodes it adds", () => {
    const before = fresh(graphAction(authGraph()), { kind: "offline" });
    const grown = graph({
      nodes: [node("Login"), node("Reset"), node("Home"), node("Settings"), node("Help")],
      edges: [flow("Home", "Help")],
    });
    const after = run(before, graphAction(grown, "connect"));
    assert.equal(after.graph, grown);
    assert.deepEqual(after.layout.Login, before.layout.Login);
    assert.ok(after.layout.Help !== undefined);
  });
});

describe("the TLC run", () => {
  it("is running from the start event and finished with the state count at the end", () => {
    const running = fresh({ kind: "tlc", event: tlcEvent("running") });
    assert.deepEqual(running.tlc, { kind: "running" });

    const done = run(running, { kind: "tlc", event: tlcEvent("done", { states: 48 }) });
    assert.deepEqual(done.tlc, { kind: "done", states: 48, message: null });
  });

  it("keeps the message of a finished run", () => {
    const message = "違反 TypeOK 変数が宣言した範囲を外れました";
    const done = fresh({ kind: "tlc", event: tlcEvent("done", { states: 12, message }) });
    assert.deepEqual(done.tlc, { kind: "done", states: 12, message });
  });

  it("fails with the message of an error", () => {
    const failed = fresh({
      kind: "tlc",
      event: tlcEvent("error", { message: "java が見つかりません" }),
    });
    assert.deepEqual(failed.tlc, { kind: "error", message: "java が見つかりません" });
  });

  it("fails with some message even when the server sent none", () => {
    const failed = fresh({ kind: "tlc", event: tlcEvent("error") });
    assert.equal(failed.tlc.kind, "error");
    assert.ok(failed.tlc.kind === "error" && failed.tlc.message.trim() !== "");
  });

  it("starts again after it finished", () => {
    const again = fresh(
      { kind: "tlc", event: tlcEvent("done", { states: 3 }) },
      { kind: "tlc", event: tlcEvent("running") },
    );
    assert.deepEqual(again.tlc, { kind: "running" });
  });

  it("is still running after an ordinary graph event", () => {
    const state = fresh(
      graphAction(authGraph()),
      { kind: "tlc", event: tlcEvent("running") },
      graphAction(authGraph()),
    );
    assert.deepEqual(state.tlc, { kind: "running" });
  });

  it("is idle after a reconnect, until the server says a run is still going", () => {
    const dropped = fresh(
      graphAction(authGraph()),
      { kind: "tlc", event: tlcEvent("running") },
      { kind: "offline" },
    );
    const reconnected = run(dropped, graphAction(authGraph(), "connect"));
    assert.deepEqual(reconnected.tlc, { kind: "idle" });
    const resumed = run(reconnected, { kind: "tlc", event: tlcEvent("running") });
    assert.deepEqual(resumed.tlc, { kind: "running" });
  });

  it("keeps a finished result across a reconnect", () => {
    const done = { kind: "tlc", event: tlcEvent("done", { states: 48 }) } as const;
    const state = fresh(
      graphAction(authGraph()),
      done,
      { kind: "offline" },
      graphAction(authGraph(), "connect"),
    );
    assert.deepEqual(state.tlc, { kind: "done", states: 48, message: null });
  });
});

describe("moving boxes", () => {
  const placed = () => fresh(graphAction(authGraph()));

  it("puts a dropped box on the 20 px grid and moves no other box", () => {
    const before = placed();
    const after = reduce(before, { kind: "move", id: name("Home"), to: { x: 107, y: 93 } });
    assert.deepEqual(after.layout.Home, { x: 100, y: 100 });
    for (const id of ["Login", "Reset", "Settings"])
      assert.deepEqual(after.layout[id], before.layout[id]);
  });

  it("keeps a point that is already on the grid", () => {
    const after = reduce(placed(), { kind: "move", id: name("Home"), to: { x: 120, y: 240 } });
    assert.deepEqual(after.layout.Home, { x: 120, y: 240 });
  });

  it("keeps the moved point through the next graph event", () => {
    const moved = reduce(placed(), { kind: "move", id: name("Home"), to: { x: 120, y: 240 } });
    assert.deepEqual(run(moved, graphAction(authGraph())).layout.Home, { x: 120, y: 240 });
  });

  it("aligns everything again only on relayout, and keeps the selection", () => {
    const moved = run(placed(), select("Login"), {
      kind: "move",
      id: name("Home"),
      to: { x: 1200, y: 1200 },
    });
    const aligned = reduce(moved, { kind: "relayout" });
    assert.deepEqual(aligned.layout, relayout(authGraph()));
    assert.notDeepEqual(aligned.layout.Home, moved.layout.Home);
    assert.equal(aligned.selection, moved.selection);
  });
});

describe("actions that change nothing", () => {
  it("return the same state", () => {
    const state = fresh(graphAction(authGraph()), select("Settings"));
    const noOps: readonly Action[] = [
      select("Nowhere"),
      forward,
      back,
      { kind: "replay", target: { property: FINITE_ID, index: 7 } },
      { kind: "move", id: name("Nowhere"), to: { x: 1, y: 1 } },
    ];
    for (const action of noOps) assert.equal(reduce(state, action), state, action.kind);

    const empty = initialState({});
    assert.equal(reduce(empty, { kind: "relayout" }), empty);
    assert.equal(reduce(empty, forward), empty);
  });
});

describe("the dependency toggle and the notice", () => {
  it("flips whether dependency edges are shown", () => {
    const hidden = fresh({ kind: "toggle-deps" });
    assert.equal(hidden.showDeps, false);
    assert.equal(reduce(hidden, { kind: "toggle-deps" }).showDeps, true);
  });

  it("holds the server's refusal until it is cleared", () => {
    const refused = fresh({ kind: "notice", text: "画面に出ていない版は承認できません" });
    assert.equal(refused.notice, "画面に出ていない版は承認できません");
    assert.equal(reduce(refused, { kind: "notice", text: null }).notice, null);
  });
});

const TEMPLATES = Object.fromEntries(
  PROMPT_KINDS.map((kind) => [kind, { text: `${kind}: {{TARGETS}}`, source: "default" }]),
) as PromptTemplates;

function entry(at: string, added: readonly string[] = []): HistoryEntry {
  return {
    at,
    reason: "watch",
    added: added.map(name),
    removed: [],
    updated: [],
    addedEdges: [],
    removedEdges: [],
  };
}

describe("selecting more than one node (docs/specs/viewer-panels.md condition 7)", () => {
  it("adds with Shift, removes with Shift again and falls back to one node", () => {
    const g = authGraph();
    const many = fresh(graphAction(g), select("Login"), shift("Settings"));
    assert.deepEqual(many.selection, { kind: "many", ids: ["Login", "Settings"] });

    const three = run(many, shift("Home"));
    assert.deepEqual(three.selection, { kind: "many", ids: ["Login", "Settings", "Home"] });

    const one = run(three, shift("Settings"), shift("Home"));
    assert.equal(one.selection.kind, "node");
    assert.equal(one.selection.kind === "node" ? one.selection.id : null, "Login");
  });

  it("starts a selection with Shift when nothing is selected", () => {
    const state = fresh(graphAction(authGraph()), shift("Home"));
    assert.equal(state.selection.kind, "node");
  });

  it("selects one node again without Shift", () => {
    const state = fresh(graphAction(authGraph()), select("Login"), shift("Home"), select("Reset"));
    assert.equal(state.selection.kind === "node" ? state.selection.id : null, "Reset");
  });

  it("drops a node that disappears and falls back to one node", () => {
    const g = authGraph();
    const state = fresh(graphAction(g), select("Login"), shift("Settings"));
    const without = graph({ ...g, nodes: g.nodes.filter((n) => n.id !== "Settings") });
    const after = run(state, graphAction(without));
    assert.equal(after.selection.kind === "node" ? after.selection.id : null, "Login");
  });
});

describe("the change log", () => {
  it("keeps one copy of each entry, oldest first, and the latest 200", () => {
    const entries = Array.from({ length: 210 }, (_, i) =>
      entry(
        `2026-10-22T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      ),
    );
    const state = fresh(
      { kind: "history", entries: entries.slice(0, 150) },
      { kind: "history", entries: entries.slice(100) },
    );
    assert.equal(state.history.length, 200);
    assert.deepEqual(state.history, entries.slice(10));
  });

  it("adds the diff of a graph event and no copy when history brings it again", () => {
    const g = authGraph();
    const diff = entry("2026-10-22T01:00:00.000Z", ["Settings"]);
    const state = fresh(
      { kind: "history", entries: [entry("2026-10-22T00:00:00.000Z")] },
      { kind: "graph", event: { ...graphEvent(g), diff } },
      { kind: "history", entries: [entry("2026-10-22T00:00:00.000Z"), diff] },
    );
    assert.deepEqual(
      state.history.map((e) => e.at),
      ["2026-10-22T00:00:00.000Z", "2026-10-22T01:00:00.000Z"],
    );
  });
});

describe("generating an instruction", () => {
  it("does nothing before the templates arrive", () => {
    const before = fresh(graphAction(authGraph()), select("Login"));
    assert.equal(reduce(before, { kind: "generate", prompt: "write-tests" }), before);
  });

  it("keeps the text made from the selection and the templates, until the selection changes", () => {
    const state = fresh(
      graphAction(authGraph()),
      { kind: "templates", templates: TEMPLATES },
      select("Login"),
      shift("Home"),
      { kind: "generate", prompt: "propose-properties" },
    );
    assert.equal(state.prompt?.kind, "propose-properties");
    assert.ok(state.prompt?.text.includes("Login"), state.prompt?.text);
    assert.ok(state.prompt?.text.includes("Home"), state.prompt?.text);

    assert.equal(run(state, { kind: "dismiss-prompt" }).prompt, null);
    assert.equal(run(state, select("Reset")).prompt, null);
  });

  it("does nothing for a kind no selected node takes", () => {
    const before = fresh(
      graphAction(authGraph()),
      { kind: "templates", templates: TEMPLATES },
      select("Settings"),
    );
    assert.equal(reduce(before, { kind: "generate", prompt: "fix-counterexample" }), before);
  });
});

describe("tabs and the model text", () => {
  it("switches the panel tab and the dock tab apart", () => {
    const state = fresh({ kind: "tab", panel: "model" }, { kind: "tab", dock: "log" });
    assert.equal(state.panelTab, "model");
    assert.equal(state.dockTab, "log");
  });

  it("holds the latest Model.tla answer", () => {
    const loaded = fresh({
      kind: "model",
      model: { kind: "loaded", text: "---- MODULE Model ----" },
    });
    assert.deepEqual(loaded.model, { kind: "loaded", text: "---- MODULE Model ----" });
    const missing = run(loaded, {
      kind: "model",
      model: { kind: "missing", message: "まだありません" },
    });
    assert.equal(missing.model.kind, "missing");
  });
});
