import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { Graph, StateName } from "../src/core/types.js";
import { proofSummary } from "../src/ui/facts.js";
import { buildPrompt, promptLabel, promptTargets } from "../src/ui/prompt.js";
import { initialState, reduce, type ViewState } from "../src/ui/state.js";
import { toneOf } from "../src/ui/view.js";
import { makeRepo, node, ts } from "./helpers/repo.js";
import { graphEvent } from "./helpers/ui-fixtures.js";
import { defaultTemplates } from "./prompts.test.js";

// docs/specs/proofs.md condition 9: what the viewer makes of the proofs a scan read.

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const AT = "2026-10-22T03:00:00.000Z";

const PAY = ts("@state 決済", "@state-require proof", "@state-spec ensures paid => receipt");
const ADMIN = ts(
  "@state 権限",
  "@state-require proof",
  "@state-spec requires role == admin",
  "@state-spec ensures granted => audited",
);
const ACCOUNT = ts("@state 口座", "@state-require proof");
const HOME = ts("@state Home");

const MESSAGE =
  "src/admin.dfy(3,2): Error: a postcondition could not be proved on this return path";

function proof(result: string, hash: string, message = "") {
  return { result, tool: "dafny", message, at: AT, hash };
}

async function proofGraph(config: unknown = { proof: { tool: "dafny" } }): Promise<Graph> {
  const root = await makeRepo({
    "everypath.config.json": JSON.stringify(config),
    "src/pay.ts": PAY,
    "src/admin.ts": ADMIN,
    "src/account.ts": ACCOUNT,
    "src/home.ts": HOME,
    ".everypath/proofs.json": JSON.stringify({
      決済: proof("passed", sha1(PAY)),
      権限: proof("failed", sha1(ADMIN), MESSAGE),
      口座: proof("passed", sha1("before the edit")),
    }),
    ".everypath/review.json": JSON.stringify({
      version: 1,
      approvals: {
        決済: { hash: sha1(PAY), at: AT, by: "reviewer", note: "" },
        口座: { hash: sha1(ACCOUNT), at: AT, by: "reviewer", note: "" },
      },
    }),
  });
  return (await analyze(root)).graph;
}

async function viewOf(graph: Graph, ids: readonly string[]): Promise<ViewState> {
  let state = reduce(initialState({}), { kind: "graph", event: graphEvent(graph) });
  state = reduce(state, { kind: "templates", templates: await defaultTemplates() });
  const picked = ids.map((id) => node(graph, id).id);
  const [first, second, ...rest] = picked;
  assert.ok(first !== undefined);
  return {
    ...state,
    selection:
      second === undefined
        ? { kind: "node", id: first, replay: null }
        : { kind: "many", ids: [first, second, ...rest] },
  };
}

describe("viewer: the colors of a proof", () => {
  it("paints an approved node with a passed proof blue, and a failed proof red", async () => {
    const graph = await proofGraph();

    assert.equal(toneOf(node(graph, "決済"), graph.properties), "proven");
    assert.equal(toneOf(node(graph, "権限"), graph.properties), "danger");
  });

  it("leaves a stale proof's node the color it has without a proof", async () => {
    const graph = await proofGraph();
    const account = node(graph, "口座");
    const unproved = { ...account, status: { ...account.status, proof: "none" as const } };

    assert.equal(toneOf(account, graph.properties), toneOf(unproved, graph.properties));
    assert.notEqual(toneOf(account, graph.properties), "proven");
  });
});

describe("viewer: the 証明 row of the panel", () => {
  const time = new Date(AT).toLocaleString("ja-JP");

  it("gives the result, the tool, the time and the tool's message", async () => {
    const graph = await proofGraph();

    const failed = proofSummary(node(graph, "権限"));
    assert.match(failed.summary, /失敗/);
    assert.match(failed.summary, /dafny/);
    assert.ok(failed.summary.includes(time), failed.summary);
    assert.equal(failed.message, MESSAGE);

    const passed = proofSummary(node(graph, "決済"));
    assert.match(passed.summary, /成功/);
    assert.equal(passed.message, null);
  });

  it("says a stale result is old and what it was", async () => {
    const graph = await proofGraph();

    const stale = proofSummary(node(graph, "口座"));

    assert.match(stale.summary, /古い/);
    assert.match(stale.summary, /成功/);
    assert.match(stale.summary, /証明必須/);
  });

  it("says when there is no proof, and whether one is required", async () => {
    const graph = await proofGraph();

    assert.deepEqual(proofSummary(node(graph, "Home")), { summary: "なし", message: null });
  });
});

describe("viewer: 仕様と証明を書く", () => {
  it("applies to the nodes that require a proof that has not passed", async () => {
    const graph = await proofGraph();
    const all = graph.nodes.map((n) => n.id);

    assert.equal(promptLabel("write-proof"), "仕様と証明を書く");
    assert.deepEqual(promptTargets("write-proof", graph, all), ["口座", "権限"] as StateName[]);
  });

  it("names the files, the @state-spec lines, the tool, its command and the completion condition", async () => {
    const graph = await proofGraph();
    const state = await viewOf(graph, ["権限", "決済", "口座", "Home"]);

    const prompt = buildPrompt("write-proof", state);

    assert.ok(prompt !== null);
    assert.deepEqual(prompt.targets, ["権限", "口座"]);
    const { text } = prompt;
    for (const part of [
      "src/admin.ts",
      "src/account.ts",
      "requires role == admin",
      "ensures granted => audited",
      "dafny",
      "dafny verify {files}",
      "everypath prove",
      ".everypath/proofs.json",
      "passed",
      MESSAGE,
    ]) {
      assert.ok(text.includes(part), `${part} in:\n${text}`);
    }
    assert.ok(!text.includes("src/pay.ts"), "a passed proof is not asked for");
    assert.doesNotMatch(text, /\{\{|\}\}/);
  });

  it("asks a person to choose a tool when the config names none", async () => {
    const graph = await proofGraph({});
    const state = await viewOf(graph, ["権限"]);

    const prompt = buildPrompt("write-proof", state);

    assert.ok(prompt !== null);
    assert.ok(prompt.text.includes("everypath.config.json"), prompt.text);
    assert.ok(!prompt.text.includes("dafny verify"), prompt.text);
    assert.doesNotMatch(prompt.text, /\{\{|\}\}/);
  });
});
