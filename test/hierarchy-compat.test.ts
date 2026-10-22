import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { flatExampleOutputs } from "./helpers/flat-example.js";

const golden = fileURLToPath(new URL("./fixtures/flat-example/", import.meta.url));

describe("hierarchy: a repository with no @state-parent is read exactly as before", () => {
  it("writes the graph.json, Model.tla, Model.cfg, Mermaid and coordinates of the code before it", async () => {
    const now = await flatExampleOutputs();

    for (const [name, text] of Object.entries(now)) {
      assert.equal(text, await readFile(`${golden}${name}.golden`, "utf8"), name);
    }
    assert.deepEqual(Object.keys(now).sort(), [
      "Model.cfg",
      "Model.tla",
      "graph.json",
      "layout.json",
      "mermaid.mmd",
    ]);
  });
});
