import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { Graph } from "../src/core/types.js";
import { buildPrompt, promptBlocker, promptTargets } from "../src/ui/prompt.js";
import { type Action, initialState, reduce, type ViewState } from "../src/ui/state.js";
import { exampleRepo } from "./helpers/tlc.js";
import { graphEvent, name } from "./helpers/ui-fixtures.js";
import { defaultTemplates } from "./prompts.test.js";

/** example/ with one call Home makes and no `@state-next` declares: Home to パスワードリセット. */
async function driftedExample(): Promise<Graph> {
  const root = await exampleRepo();
  await appendFile(
    join(root, "src", "home.ts"),
    '\nexport const toReset = (router: { push(path: string): void }) => router.push("/reset");\n',
  );
  const { graph } = await analyze(root);
  assert.deepEqual(
    graph.drift.map(({ from, to }) => [from, to]),
    [["Home", "パスワードリセット"]],
  );
  return graph;
}

async function homeSelected(graph: Graph): Promise<ViewState> {
  return [
    { kind: "graph", event: graphEvent(graph) },
    { kind: "templates", templates: await defaultTemplates() },
    { kind: "select", id: name("Home"), extend: false },
  ].reduce<ViewState>((state, action) => reduce(state, action as Action), initialState({}));
}

const decide = (fix: "remove-call" | "add-next", to = "パスワードリセット"): Action => ({
  kind: "decide-drift",
  from: name("Home"),
  to: name(to),
  fix,
});

function textOf(state: ViewState): string {
  const prompt = buildPrompt("fix-drift", state);
  assert.ok(prompt !== null, "the instruction can be made");
  return prompt.text;
}

describe("乖離を直す (docs/specs/viewer-drift.md condition 3)", () => {
  it("applies to the node that makes the call, and to no other", async () => {
    const graph = await driftedExample();

    assert.deepEqual(
      promptTargets(
        "fix-drift",
        graph,
        graph.nodes.map((node) => node.id),
      ),
      ["Home"],
    );
  });

  it("cannot be made until the person says which side is right", async () => {
    const state = await homeSelected(await driftedExample());

    assert.equal(buildPrompt("fix-drift", state), null);
    const reason = promptBlocker("fix-drift", state, [name("Home")]);
    assert.ok(typeof reason === "string" && reason !== "", "the panel can say why");

    const decided = reduce(state, decide("remove-call"));
    assert.equal(promptBlocker("fix-drift", decided, [name("Home")]), null);
    assert.ok(buildPrompt("fix-drift", decided) !== null);
  });

  it("holds the declaration, the call, the target and the chosen fix, and ends with the drift gone", async () => {
    const state = await homeSelected(await driftedExample());

    const removing = textOf(reduce(state, decide("remove-call")));
    const adding = textOf(reduce(state, decide("add-next")));

    for (const text of [removing, adding]) {
      assert.ok(text.includes("@state-next マイページ on:open_mypage"), "the declared transition");
      assert.ok(text.includes("src/home.ts"), "the file that makes the call");
      assert.ok(text.includes("パスワードリセット"), "the target");
      assert.ok(text.includes("src/auth/reset.ts"), "where the target's @state-route is");
      assert.match(text, /drift/, "the completion condition");
      assert.doesNotMatch(text, /\{\{|\}\}/);
    }
    const lines = (text: string) => new Set(text.split("\n"));
    const onlyRemoving = [...lines(removing)].filter((line) => !lines(adding).has(line));
    const onlyAdding = [...lines(adding)].filter((line) => !lines(removing).has(line));
    assert.equal(onlyRemoving.length, 1, onlyRemoving.join("\n"));
    assert.match(onlyRemoving[0] ?? "", /宣言が正しい.*呼び出し/);
    assert.equal(onlyAdding.length, 1, onlyAdding.join("\n"));
    assert.match(onlyAdding[0] ?? "", /コードが正しい.*@state-next パスワードリセット/);
  });

  it("drops the instruction made before the person changes their choice", async () => {
    const generated = reduce(
      reduce(await homeSelected(await driftedExample()), decide("add-next")),
      {
        kind: "generate",
        prompt: "fix-drift",
      },
    );
    assert.equal(generated.prompt?.kind, "fix-drift");

    assert.equal(reduce(generated, decide("remove-call")).prompt, null);
  });

  it("ignores a choice about a drift the graph does not have", async () => {
    const state = await homeSelected(await driftedExample());

    assert.equal(reduce(state, decide("remove-call", "ログイン")), state);
  });

  it("forgets a choice once its drift has gone, so a drift that comes back asks again", async () => {
    const drifted = await driftedExample();
    const { graph: clean } = await analyze(await exampleRepo());
    const decided = reduce(await homeSelected(drifted), decide("add-next"));

    const back = [clean, drifted].reduce(
      (state, graph) => reduce(state, { kind: "graph", event: graphEvent(graph) }),
      decided,
    );

    assert.equal(buildPrompt("fix-drift", back), null);
  });

  it("makes one instruction for several boxes once every drift among them has a side", async () => {
    const state = reduce(await homeSelected(await driftedExample()), {
      kind: "select",
      id: name("ログイン"),
      extend: true,
    });
    assert.equal(state.selection.kind, "many");

    assert.equal(buildPrompt("fix-drift", state), null);
    const prompt = buildPrompt("fix-drift", reduce(state, decide("remove-call")));
    assert.deepEqual(prompt?.targets, ["Home"]);
  });
});
