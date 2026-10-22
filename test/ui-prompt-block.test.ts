import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROMPT_KINDS, type PromptTemplates } from "../src/core/prompts.js";
import type { Graph, PropertyResult } from "../src/core/types.js";
import { buildPrompt } from "../src/ui/prompt.js";
import { initialState, reduce, type ViewState } from "../src/ui/state.js";
import {
  counterexample,
  flow,
  graph,
  graphEvent,
  name,
  node,
  property,
  propertyId,
} from "./helpers/ui-fixtures.js";

/** Only the violation block, so each case reads the block and nothing around it. */
const BLOCK = Object.fromEntries(
  PROMPT_KINDS.map((kind) => [
    kind,
    { text: kind === "explain-model" ? "{{FOCUS}}" : `${kind}`, source: "default" },
  ]),
) as PromptTemplates;

function stateOf(g: Graph, ...ids: string[]): ViewState {
  let state = reduce(initialState({}), { kind: "graph", event: graphEvent(g) });
  state = reduce(state, { kind: "templates", templates: BLOCK });
  for (const id of ids) state = reduce(state, { kind: "select", id: name(id), extend: true });
  return state;
}

function focusOf(g: Graph, ...ids: string[]): string {
  return buildPrompt("explain-model", stateOf(g, ...ids))?.text ?? "";
}

const ID = propertyId("reset-ends");
const withViolation = (found: PropertyResult, ...ids: string[]): Graph =>
  graph({
    nodes: ids.map((id) => node(id, { violations: [found.id] })),
    edges: [flow("A", "B", "go"), flow("B", "A", "back")],
    properties: [found],
  });

describe("the violation block of an instruction", () => {
  it("closes a looping trace with where it repeats from, and no arrow", () => {
    const looping = {
      ...property("reset-ends", "violated", [
        counterexample(["A", "B"], { loopStart: 0, vars: [[["n", "0"]], [["n", "1"]]] }),
      ]),
      description: "いつか終わる",
    };

    const text = focusOf(withViolation(looping, "A", "B"), "A");

    assert.ok(
      text.startsWith(
        "モデル検査（TLA+ / TLC、10 状態を全探索）で違反: いつか終わる (reset-ends)\n反例:\n",
      ),
    );
    assert.ok(text.endsWith("  ↺ step 1 に戻って繰り返す"), text);
    assert.ok(!text.includes("ここで違反"), text);
  });

  it("names the quick check and leaves the variable column empty for a trace without variables", () => {
    const quick = {
      ...property("reset-ends", "violated", [counterexample(["A", "B"])]),
      checkedBy: "bfs",
    } satisfies PropertyResult;

    const text = focusOf(withViolation(quick, "A", "B"), "A");

    assert.ok(text.startsWith("簡易検査（10 状態を探索）で違反: reset-ends\n"), text);
    assert.match(text, /\n {2}2\. B {2,}on:e1 {3}← ここで違反$/);
  });

  it("drops the count when the search did not report one, and names both checkers", () => {
    const both = {
      ...property("reset-ends", "violated", [counterexample(["A", "B"])]),
      checkedBy: "both",
      statesExplored: null,
    } satisfies PropertyResult;

    const text = focusOf(withViolation(both, "A", "B"), "A");

    assert.ok(text.startsWith("簡易検査とモデル検査（TLA+ / TLC）で違反: reset-ends\n"), text);
  });

  it("writes the counterexample being replayed, not the first", () => {
    const two = property("reset-ends", "violated", [
      counterexample(["A", "B"]),
      counterexample(["B", "A", "B"]),
    ]);
    const g = withViolation(two, "A", "B");
    let state = stateOf(g, "A");
    state = reduce(state, { kind: "replay", target: { property: ID, index: 1 } });

    const text = buildPrompt("explain-model", state)?.text ?? "";

    assert.match(text, /3\. B/);
  });

  it("shows no block for a stale violation", () => {
    const stale = property("reset-ends", "violated", [counterexample(["A", "B"])], { stale: true });

    assert.equal(focusOf(withViolation(stale, "A", "B"), "A"), "");
  });
});
