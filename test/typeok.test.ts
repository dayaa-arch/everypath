import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { toMermaid } from "../src/core/mermaid.js";
import { PROPERTIES_FILE, parseProperties } from "../src/core/properties.js";
import type { Graph, PropertyResult } from "../src/core/types.js";
import { buildPrompt } from "../src/ui/prompt.js";
import { type Action, initialState, reduce, replayOf, type ViewState } from "../src/ui/state.js";
import { headerCounts, toneOf } from "../src/ui/view.js";
import { makeRepo, node, readGraph, runCli, ts, writeFiles } from "./helpers/repo.js";
import {
  exampleRepo,
  type FakeJava,
  type FakeJavaScript,
  fakeJava,
  fixture,
  forExample,
} from "./helpers/tlc.js";
import { graphEvent, name, varName } from "./helpers/ui-fixtures.js";
import { defaultTemplates } from "./prompts.test.js";

// docs/specs/typeok.md. The fixture's trace runs ログイン → パスワードリセット → Home.
const ON_TRACE = ["Home", "パスワードリセット", "ログイン"];

const typeOkBroken = async (): Promise<FakeJavaScript> => ({
  rules: [
    {
      when: "INVARIANT TypeOK",
      reply: { output: forExample(await fixture("violation"), "TypeOK"), exit: 12 },
    },
  ],
  otherwise: { output: await fixture("ok") },
});

const allHold = async (): Promise<FakeJavaScript> => ({
  rules: [],
  otherwise: { output: await fixture("ok") },
});

async function checkedExample(script: FakeJavaScript) {
  const root = await exampleRepo();
  const java = await fakeJava(script);
  const result = runCli(["check", "--tlc", root], root, java.env);
  return { root, java, result };
}

const readResult = async (root: string) =>
  JSON.parse(await readFile(join(root, ".everypath", "tla", "result.json"), "utf8"));

function typeOkOf(properties: readonly PropertyResult[]): PropertyResult {
  const found = properties.find((p) => p.id === "TypeOK");
  assert.ok(found, `TypeOK in ${properties.map((p) => p.id)}`);
  return found;
}

const plainCheck = (root: string, java: FakeJava) => runCli(["check", root], root, java.env);

/** A transition Home did not have: the model TLC checked is gone. */
const changeModel = (root: string) =>
  writeFiles(root, { "src/home-back.ts": ts("@state Home", "@state-next ログイン on:back") });

describe("the reserved id (docs/specs/typeok.md condition 2)", () => {
  it("drops a definition that takes the id TypeOK and says it is reserved", () => {
    const { file, warnings } = parseProperties({
      properties: [
        { id: "TypeOK", kind: "invariant", expr: "retries <= 3" },
        { id: "no-dead-end", kind: "no-dead-end" },
      ],
    });

    assert.deepEqual(
      file.properties.map((p) => p.id),
      ["no-dead-end"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]?.message ?? "", /TypeOK.*予約/);
  });

  it("fails a plain check that defines it, as any unreadable definition does", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-initial", "@state-next A on:go"),
      [PROPERTIES_FILE]: JSON.stringify({
        properties: [{ id: "TypeOK", kind: "no-dead-end" }],
      }),
    });

    const result = runCli(["check", root], root);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /TypeOK/);
  });
});

describe("TypeOK in result.json (docs/specs/typeok.md condition 3)", () => {
  it("records a broken TypeOK as the last property, with its trace and no typeOk field", async () => {
    const { root } = await checkedExample(await typeOkBroken());

    const stored = await readResult(root);
    assert.equal("typeOk" in stored, false);
    const last = stored.properties.at(-1);
    assert.deepEqual(
      {
        id: last.id,
        kind: last.kind,
        description: last.description,
        checkedBy: last.checkedBy,
        result: last.result,
      },
      {
        id: "TypeOK",
        kind: "invariant",
        description: "変数が宣言した範囲に収まる",
        checkedBy: "tlc",
        result: "violated",
      },
    );
    assert.equal(last.counterexamples[0].steps.length, 3);
  });

  it("records a TypeOK that held as ok", async () => {
    const { root, result } = await checkedExample(await allHold());

    assert.equal(result.status, 0, result.stdout);
    const last = (await readResult(root)).properties.at(-1);
    assert.deepEqual([last.id, last.result, last.counterexamples], ["TypeOK", "ok", []]);
  });
});

describe("TypeOK in graph.json and the CLI (docs/specs/typeok.md condition 4)", () => {
  it("is the last property, marks the states on its trace and fails check --tlc", async () => {
    const { root, result } = await checkedExample(await typeOkBroken());

    assert.equal(result.status, 1);
    assert.match(result.stdout, /違反 TypeOK \[invariant\] 変数が宣言した範囲に収まる/);
    assert.ok(result.stdout.includes("  3. →(reset_done) Home（authed=FALSE, retries=0）"));
    const graph = await readGraph(root);
    assert.equal(graph.properties.at(-1)?.id, "TypeOK");
    assert.equal(typeOkOf(graph.properties).result, "violated");
    const marked = graph.nodes.filter((n) => n.violations.includes(typeOkOf(graph.properties).id));
    assert.deepEqual(marked.map((n) => n.id).sort(), ON_TRACE);
  });

  it("fails a plain check afterwards, though every other property holds", async () => {
    const { root, java } = await checkedExample(await typeOkBroken());

    const result = plainCheck(root, java);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /違反 TypeOK \[invariant\] 変数が宣言した範囲に収まる/);
    assert.ok(result.stdout.includes("  3. →(reset_done) Home（authed=FALSE, retries=0）"));
  });

  it("passes when TypeOK held", async () => {
    const { root, java } = await checkedExample(await allHold());

    const result = plainCheck(root, java);

    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /成立 TypeOK \[invariant\] 変数が宣言した範囲に収まる/);
    assert.equal(typeOkOf((await readGraph(root)).properties).result, "ok");
  });
});

describe("TypeOK on a model that changed (docs/specs/typeok.md condition 5)", () => {
  it("is stale, marks no state and does not fail a plain check", async () => {
    const { root, java } = await checkedExample(await typeOkBroken());
    await changeModel(root);

    const result = plainCheck(root, java);

    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /古いモデルに対する結果/);
    const graph = await readGraph(root);
    assert.equal(typeOkOf(graph.properties).staleModel, true);
    assert.ok(graph.nodes.every((n) => !n.violations.includes(typeOkOf(graph.properties).id)));
  });
});

async function loginSelected(graph: Graph): Promise<ViewState> {
  return [
    { kind: "graph", event: graphEvent(graph) },
    { kind: "templates", templates: await defaultTemplates() },
    { kind: "select", id: name("ログイン"), extend: false },
  ].reduce<ViewState>((state, action) => reduce(state, action as Action), initialState({}));
}

async function seen(graph: Graph) {
  const state = await loginSelected(graph);
  const replay = replayOf(state);
  return {
    tone: toneOf(node(graph, "ログイン"), graph.properties),
    violated: headerCounts(graph).violated,
    replaying: replay === null ? null : replay.property.id,
    marked: toMermaid(graph)
      .split("\n")
      .filter((line) => /^ {4}class \S+ violated$/.test(line)),
    prompt: buildPrompt("fix-counterexample", state)?.text ?? null,
  };
}

describe("TypeOK in the viewer and Mermaid (docs/specs/typeok.md condition 6)", () => {
  it("is red, counted, replayed with its variables, fixable and marked on the current model", async () => {
    const { root } = await checkedExample(await typeOkBroken());
    const graph = await readGraph(root);

    const view = await seen(graph);

    assert.equal(view.tone, "danger");
    assert.equal(view.violated, 1);
    assert.equal(view.replaying, "TypeOK");
    const state = await loginSelected(graph);
    const steps = replayOf(state)?.trace.steps.map((step) => step.vars[varName("retries")]);
    assert.deepEqual(steps, ["0", "0", "0"]);
    const ids = new Map(graph.nodes.map((n, index) => [n.id, `s${index + 1}`]));
    const onTrace = ON_TRACE.map((id) => ids.get(name(id))).sort();
    assert.deepEqual(view.marked, [`    class ${onTrace.join(",")} violated`]);
    const prompt = view.prompt ?? "";
    for (const text of [
      "TypeOK",
      "変数が宣言した範囲に収まる",
      "everypath check --tlc",
      "retries=0",
    ]) {
      assert.ok(prompt.includes(text), `${text} in\n${prompt}`);
    }
  });

  it("is none of these once the model changed", async () => {
    const { root, java } = await checkedExample(await typeOkBroken());
    await changeModel(root);
    plainCheck(root, java);

    const view = await seen(await readGraph(root));

    assert.equal(view.tone === "danger", false);
    assert.deepEqual(
      [view.violated, view.replaying, view.marked, view.prompt],
      [0, null, [], null],
    );
  });
});

describe("a repository without TLC results (docs/specs/typeok.md condition 7)", () => {
  it("has no TypeOK in graph.json or in the diagram", async () => {
    const root = await exampleRepo();

    const result = runCli(["scan", "--quiet", root], root);

    assert.equal(result.status, 0, result.stderr);
    const text = await readFile(join(root, ".everypath", "graph.json"), "utf8");
    assert.equal(text.includes("TypeOK"), false);
    assert.equal(toMermaid(await readGraph(root)).includes("violated\n"), false);
  });
});
