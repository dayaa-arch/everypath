import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import { generateTla } from "../src/core/tla/generate.js";
import { modelSlice } from "../src/ui/model.js";
import { exampleRepo } from "./helpers/tlc.js";
import { name } from "./helpers/ui-fixtures.js";

async function exampleTla(): Promise<string> {
  const { graph, properties } = await analyze(await exampleRepo());
  const generated = generateTla(graph, properties);
  assert.ok(generated.ok);
  return generated.model.tla;
}

const kinds = (slice: ReturnType<typeof modelSlice>, kind: string): string[] =>
  (slice?.blocks ?? []).filter((block) => block.kind === kind).map((block) => block.text);

describe("modelSlice (docs/specs/viewer-panels.md condition 8)", () => {
  it("gives ログイン its identifier, Init, five actions out and three in", async () => {
    const slice = modelSlice(await exampleTla(), name("ログイン"));

    assert.ok(slice !== null);
    assert.equal(slice.ident, "S6");
    assert.equal(kinds(slice, "init").length, 1);
    const out = kinds(slice, "out");
    assert.equal(out.length, 5);
    assert.ok(
      out.every((text) => text.includes('state = "S6"')),
      "each leaves ログイン",
    );
    assert.ok(
      out.some((text) => text.includes("@state-next ロック on:login_fail if:retries==3")),
      "keeps the generated comment",
    );
    const into = kinds(slice, "in");
    assert.equal(into.length, 3);
    assert.ok(into.every((text) => text.includes(`state' = "S6"`)));
    const properties = kinds(slice, "property");
    assert.equal(properties.length, 1, "logout-eventually-login ends at ログイン");
    assert.ok(properties[0]?.includes("logout-eventually-login"));
  });

  it("gives Home the property that names it", async () => {
    const slice = modelSlice(await exampleTla(), name("Home"));

    assert.ok(slice !== null);
    assert.equal(slice.ident, "S2_Home");
    const properties = kinds(slice, "property");
    assert.equal(properties.length, 1);
    assert.ok(properties[0]?.includes("no-unauth-home"));
    assert.equal(kinds(slice, "init").length, 0);
  });

  it("returns null for a state the model does not have", async () => {
    assert.equal(modelSlice(await exampleTla(), name("設定")), null);
  });
});
