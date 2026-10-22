import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { PropertyResult, StateNode } from "../src/core/types.js";
import { buildPrompt, promptTargets } from "../src/ui/prompt.js";
import { initialState, reduce, type ViewState } from "../src/ui/state.js";
import { exampleRepo } from "./helpers/tlc.js";
import {
  eventName,
  graph,
  graphEvent,
  name,
  node,
  propertyId,
  varName,
} from "./helpers/ui-fixtures.js";
import { defaultTemplates } from "./prompts.test.js";

const NO_UNAUTH_HOME = propertyId("no-unauth-home");
const ON_TRACE = ["ログイン", "パスワードリセット", "Home"];

/** What TLC reports on example/: `no-unauth-home` is violated by Login, Reset, Home after 48 states. */
function tlcViolation(base: PropertyResult): PropertyResult {
  const vars = { [varName("authed")]: "FALSE", [varName("retries")]: "0" };
  const steps = [
    { state: name("ログイン"), event: null, vars },
    { state: name("パスワードリセット"), event: null, vars },
    { state: name("Home"), event: eventName("reset_done"), vars },
  ] as const;
  return {
    ...base,
    checkedBy: "tlc",
    result: "violated",
    counterexamples: [
      {
        path: [steps[0].state, steps[1].state, steps[2].state],
        steps: [...steps],
        loopStart: null,
      },
    ],
    statesExplored: 48,
  };
}

/**
 * example/ after a TLC run, with ログイン and Home approved, and the scanner finding and the
 * `@state-spec` of SPEC §13's example on パスワードリセット.
 */
async function checkedExample(): Promise<ViewState> {
  const { graph: scanned } = await analyze(await exampleRepo());
  const reset = (n: StateNode): StateNode =>
    n.id !== "パスワードリセット"
      ? n
      : {
          ...n,
          spec: ["requires token.valid && !token.expired", "ensures session == none"],
          findings: [
            {
              file: "src/auth/reset.ts",
              line: 42,
              severity: "high",
              rule: "semgrep.reset-token",
              message: "リセットトークンの検証がない",
            },
          ],
        };
  const g = {
    ...scanned,
    nodes: scanned.nodes.map((n) =>
      reset({
        ...n,
        violations: ON_TRACE.includes(n.id) ? [NO_UNAUTH_HOME] : n.violations,
        status: { ...n.status, reviewed: n.id === "ログイン" || n.id === "Home" },
      }),
    ),
    properties: scanned.properties.map((p) => (p.id === NO_UNAUTH_HOME ? tlcViolation(p) : p)),
  };
  let state = reduce(initialState({}), { kind: "graph", event: graphEvent(g) });
  state = reduce(state, { kind: "templates", templates: await defaultTemplates() });
  return state;
}

describe("反例を直す (docs/specs/viewer-panels.md condition 4)", () => {
  it("holds what SPEC §13's example holds", async () => {
    let state = await checkedExample();
    state = reduce(state, { kind: "select", id: name("パスワードリセット"), extend: false });

    const prompt = buildPrompt("fix-counterexample", state);

    assert.ok(prompt !== null);
    assert.deepEqual(prompt.targets, ["パスワードリセット"]);
    const { text } = prompt;
    assert.ok(text.includes("src/auth/reset.ts（機能: パスワードリセット）"), text);
    assert.ok(text.includes("TLA+ / TLC"), "names the checker");
    assert.ok(text.includes("48 状態"), "states explored");
    assert.ok(text.includes("未認証で Home・マイページにいない"), "the property's description");
    assert.ok(text.includes("no-unauth-home"), "the property's id");
    assert.match(text, /1\.\s+ログイン\s+authed=FALSE retries=0/);
    assert.match(text, /2\.\s+パスワードリセット\s+（イベントなし）\s+authed=FALSE retries=0/);
    assert.match(text, /3\.\s+Home\s+on:reset_done\s+authed=FALSE retries=0\s+← ここで違反/);
    assert.ok(text.includes("リセットトークンの検証がない"), "the finding");
    assert.ok(text.includes("src/auth/reset.ts:42"), "the finding's place");
    assert.ok(text.includes("リセット完了後にセッションを発行しているか未確認"), "the @state-risk");
    assert.ok(
      text.includes("requires token.valid && !token.expired / ensures session == none"),
      "the @state-spec",
    );
    assert.ok(text.includes("`everypath check --tlc`"), "the check to run");
    assert.ok(text.includes("no-unauth-home が ok"), "the completion condition");
    assert.ok(text.includes("ログイン・Home は承認済み"), "the approved neighbors, trace order");
    assert.doesNotMatch(text, /\{\{|\}\}/);
  });

  it("is not offered for a node with no live violation", async () => {
    let state = await checkedExample();
    state = reduce(state, { kind: "select", id: name("マイページ"), extend: false });

    assert.ok(state.graph !== null);
    assert.deepEqual(promptTargets("fix-counterexample", state.graph, [name("マイページ")]), []);
    assert.equal(buildPrompt("fix-counterexample", state), null);
  });
});

describe("まとめて生成 (condition 5)", () => {
  const withFile = (id: string, tested: boolean): StateNode => ({
    ...node(id, { status: { tested } }),
    files: [`src/${id.toLowerCase()}.ts`],
  });
  const batch = graph({
    nodes: [withFile("A", false), withFile("B", false), withFile("C", false), withFile("D", true)],
  });
  const all = ["A", "B", "C", "D"].map(name);

  it("writes tests for the untested nodes of the selection only", async () => {
    let state = reduce(initialState({}), { kind: "graph", event: graphEvent(batch) });
    state = reduce(state, { kind: "templates", templates: await defaultTemplates() });
    for (const id of all) state = reduce(state, { kind: "select", id, extend: true });
    assert.equal(state.selection.kind, "many");

    assert.deepEqual(promptTargets("write-tests", batch, all), ["A", "B", "C"]);
    const prompt = buildPrompt("write-tests", state);
    assert.ok(prompt !== null);
    assert.deepEqual(prompt.targets, ["A", "B", "C"]);
    for (const file of ["src/a.ts", "src/b.ts", "src/c.ts"])
      assert.ok(prompt.text.includes(file), file);
    assert.ok(!prompt.text.includes("src/d.ts"), "a tested node is left out");
    assert.equal(
      buildPrompt("fix-counterexample", state),
      null,
      "no node of the selection has one",
    );
  });

  it("draws a model only for nodes with no outgoing flow or none with if: or set:", async () => {
    const { graph: example } = await analyze(await exampleRepo());
    const targets = promptTargets(
      "draw-model",
      example,
      example.nodes.map((n) => n.id),
    );

    assert.ok(targets.includes(name("DB層")), "no outgoing flow");
    assert.ok(targets.includes(name("Home")), "on: only");
    assert.ok(!targets.includes(name("ログイン")), "has if: and set:");
    assert.ok(!targets.includes(name("マイページ")), "has set:");
  });
});

describe("モデルを説明させる", () => {
  it("names Model.tla and the property being replayed", async () => {
    let state = await checkedExample();
    state = reduce(state, { kind: "select", id: name("Home"), extend: false });

    const prompt = buildPrompt("explain-model", state);

    assert.ok(prompt !== null);
    assert.ok(prompt.text.includes(".everypath/tla/Model.tla"), "the model's path");
    assert.ok(prompt.text.includes("no-unauth-home"), "the property in focus");
    assert.match(prompt.text, /3\.\s+Home\s+on:reset_done/, "its counterexample");
  });
});
