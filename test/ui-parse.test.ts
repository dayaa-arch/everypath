import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROMPT_KINDS } from "../src/core/prompts.js";
import { parseHistory, parseTemplates } from "../src/ui/parse.js";

const ENTRY = {
  at: "2026-10-22T01:00:00.000Z",
  reason: "watch",
  added: ["設定"],
  removed: [],
  updated: ["Home"],
  addedEdges: [{ type: "flow", from: "設定", to: "Home", event: "back" }],
  removedEdges: [{ type: "dep", from: "Home", to: "設定", event: null }],
};

describe("the bodies the viewer reads besides the graph", () => {
  it("keeps a history entry as the server wrote it", () => {
    assert.deepEqual(parseHistory([ENTRY]), [ENTRY]);
  });

  it("drops the entries that are not entries and keeps the rest in order", () => {
    const later = { ...ENTRY, at: "2026-10-22T02:00:00.000Z" };
    const broken = [
      null,
      "text",
      { ...ENTRY, at: 5 },
      { ...ENTRY, added: [1] },
      { ...ENTRY, addedEdges: [{ type: "ref", from: "a", to: "b", event: null }] },
      { ...ENTRY, removedEdges: "none" },
    ];
    assert.deepEqual(parseHistory([ENTRY, ...broken, later]), [ENTRY, later]);
  });

  it("reads an edge with no event as an edge with none", () => {
    const [entry] = parseHistory([
      { ...ENTRY, addedEdges: [{ type: "dep", from: "Home", to: "設定" }] },
    ]);
    assert.deepEqual(entry?.addedEdges, [{ type: "dep", from: "Home", to: "設定", event: null }]);
  });

  it("reads anything but a list as no history", () => {
    for (const body of [null, {}, "[]", 3]) assert.deepEqual(parseHistory(body), []);
  });

  const templates = () =>
    Object.fromEntries(PROMPT_KINDS.map((kind) => [kind, { text: `${kind}`, source: "default" }]));

  it("keeps the templates when every kind has a text and a source", () => {
    assert.deepEqual(parseTemplates(templates()), templates());
  });

  it("refuses the templates when a kind is missing or malformed", () => {
    const { "write-tests": _dropped, ...missing } = templates();
    assert.equal(parseTemplates(missing), null);
    assert.equal(
      parseTemplates({ ...templates(), "draw-model": { text: "x", source: "mine" } }),
      null,
    );
    assert.equal(
      parseTemplates({ ...templates(), "draw-model": { text: 1, source: "default" } }),
      null,
    );
    assert.equal(parseTemplates([]), null);
    assert.equal(parseTemplates(null), null);
  });
});
