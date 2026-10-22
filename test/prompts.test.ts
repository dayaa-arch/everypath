import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fillTemplate, PROMPT_KINDS, type PromptTemplates } from "../src/core/prompts.js";
import { analyze } from "../src/core/scan.js";
import { buildPrompt } from "../src/ui/prompt.js";
import { initialState, reduce } from "../src/ui/state.js";
import { exampleRepo } from "./helpers/tlc.js";
import { graphEvent } from "./helpers/ui-fixtures.js";

const templatesDir = fileURLToPath(new URL("../templates/prompts", import.meta.url));

export async function defaultTemplates(): Promise<PromptTemplates> {
  const entries = await Promise.all(
    PROMPT_KINDS.map(async (kind) => {
      const text = await readFile(join(templatesDir, `${kind}.md`), "utf8");
      return [kind, { text, source: "default" as const }] as const;
    }),
  );
  return Object.fromEntries(entries) as PromptTemplates;
}

describe("fillTemplate (docs/specs/viewer-panels.md condition 2)", () => {
  it("replaces a variable with its value", () => {
    assert.equal(fillTemplate("{{NODE}} を直す", { NODE: "Home" }), "Home を直す");
  });

  it("repeats a list section once per item, with the item's variables and the outer ones", () => {
    const text = fillTemplate("{{#NODES}}- {{NODE}} ({{CMD}})\n{{/NODES}}", {
      CMD: "check",
      NODES: [{ NODE: "A" }, { NODE: "B" }],
    });
    assert.equal(text, "- A (check)\n- B (check)");
  });

  it("shows a text section once when the text is not empty and drops it when it is", () => {
    const template = "前{{#NEIGHBORS}}\n{{NEIGHBORS}} は承認済み{{/NEIGHBORS}}\n後";
    assert.equal(
      fillTemplate(template, { NEIGHBORS: "ログイン・Home" }),
      "前\nログイン・Home は承認済み\n後",
    );
    assert.equal(fillTemplate(template, { NEIGHBORS: "" }), "前\n後");
  });

  it("shows an inverted section only when the value is empty", () => {
    const template = "{{^SPEC}}なし{{/SPEC}}{{#SPEC}}{{SPEC}}{{/SPEC}}";
    assert.equal(fillTemplate(template, { SPEC: "" }), "なし");
    assert.equal(fillTemplate(template, { SPEC: "requires x" }), "requires x");
    assert.equal(fillTemplate("{{^NODES}}誰も{{/NODES}}", { NODES: [] }), "誰も");
  });

  it("drops the line break after a section tag that stands alone on its line", () => {
    const template = "a\n{{#X}}\nx\n{{/X}}\nb";
    assert.equal(fillTemplate(template, { X: "" }), "a\nb");
    assert.equal(fillTemplate(template, { X: "1" }), "a\nx\nb");
  });

  it("leaves a section with an unknown name as written", () => {
    assert.equal(fillTemplate("{{#NOPE}}x{{/NOPE}}", {}), "{{#NOPE}}x{{/NOPE}}");
  });

  it("drops an empty list section", () => {
    assert.equal(fillTemplate("a{{#NODES}}x{{/NODES}}b", { NODES: [] }), "ab");
  });

  it("removes HTML comments, including ones that name variables", () => {
    assert.equal(fillTemplate("<!-- {{NODE}}: 状態名 -->\n{{NODE}}", { NODE: "Home" }), "Home");
  });

  it("leaves an unknown variable as written, so a typo shows in the output", () => {
    assert.equal(fillTemplate("{{NODEE}} {{NODE}}", { NODE: "Home" }), "{{NODEE}} Home");
  });

  it("collapses three or more line breaks into one blank line and trims the ends", () => {
    assert.equal(fillTemplate("\n\na\n\n\n\nb\n\n", {}), "a\n\nb");
  });

  it("does not read a value as a template", () => {
    assert.equal(fillTemplate("{{A}}", { A: "{{B}}", B: "x" }), "{{B}}");
  });
});

describe("templates/prompts (condition 3)", () => {
  it("has one file per prompt kind", async () => {
    const templates = await defaultTemplates();
    assert.deepEqual(Object.keys(templates).sort(), [...PROMPT_KINDS].sort());
    for (const kind of PROMPT_KINDS) assert.ok(templates[kind].text.trim() !== "", kind);
  });

  it("leaves no variable unfilled for any kind on the example", async () => {
    const { graph } = await analyze(await exampleRepo());
    const templates = await defaultTemplates();
    let state = reduce(initialState({}), { kind: "graph", event: graphEvent(graph) });
    state = reduce(state, { kind: "templates", templates });
    const ids = graph.nodes.map((node) => node.id);
    const [first, second, ...rest] = ids;
    assert.ok(first !== undefined && second !== undefined);
    state = { ...state, selection: { kind: "many", ids: [first, second, ...rest] } };

    // example/ has no violation before TLC runs, no drift and no node that requires a proof;
    // test/ui-prompt.test.ts, test/viewer-drift-prompt.test.ts and test/proofs-viewer.test.ts fill those.
    const elsewhere: readonly string[] = ["fix-counterexample", "fix-drift", "write-proof"];
    for (const kind of PROMPT_KINDS) {
      if (elsewhere.includes(kind)) continue;
      const prompt = buildPrompt(kind, state);
      assert.ok(prompt !== null, `${kind} applies to some example node`);
      assert.doesNotMatch(prompt.text, /\{\{|\}\}/, kind);
    }
  });
});
