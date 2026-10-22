import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The page is served from the origin that takes approvals and shows strings from the repository, so
 * nothing under src/ui may build DOM from a string, and nothing may reach Node or the server.
 */
const uiDir = fileURLToPath(new URL("../src/ui", import.meta.url));
const temporary: string[] = [];

after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

const MARKUP_FROM_STRINGS: readonly (readonly [string, RegExp])[] = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\s*\.\s*write(?:ln)?\b/],
  ["createContextualFragment", /\bcreateContextualFragment\b/],
  ["DOMParser", /\bDOMParser\b/],
  ["setHTMLUnsafe", /\b(?:setHTMLUnsafe|parseHTMLUnsafe)\b/],
  ["srcdoc", /\bsrcdoc\b/],
  ["eval", /\beval\b/],
  ["Function constructor", /(?<![\w.$])(?:new\s+)?Function\s*\(/],
];

type Finding = { readonly file: string; readonly rule: string };

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function markupFromStrings(dir: string): Promise<Finding[]> {
  const found: Finding[] = [];
  for (const file of await filesUnder(dir)) {
    const text = await readFile(file, "utf8");
    for (const [rule, pattern] of MARKUP_FROM_STRINGS) {
      if (pattern.test(text)) found.push({ file: relative(dir, file), rule });
    }
  }
  return found;
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/** An import of Node, of the server, or of core code that is not the types file. */
async function strayImports(dir: string): Promise<Finding[]> {
  const typesFile = resolve(dir, "..", "core", "types");
  const found: Finding[] = [];
  for (const file of (await filesUnder(dir)).filter((name) => name.endsWith(".ts"))) {
    const text = await readFile(file, "utf8");
    for (const [, specifier = ""] of text.matchAll(SPECIFIER)) {
      if (specifier.startsWith("node:")) {
        found.push({ file: relative(dir, file), rule: specifier });
      } else if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/, ""));
        const inside = !relative(dir, target).startsWith("..");
        if (!inside && target !== typesFile)
          found.push({ file: relative(dir, file), rule: specifier });
      }
    }
  }
  return found;
}

/** A copy of src/ui under `<copy>/ui`, so `../core/types.js` resolves beside it, plus `extra`. */
async function copyOfUi(extra: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everypath-ui-boundary-"));
  temporary.push(root);
  const copy = join(root, "ui");
  await cp(uiDir, copy, { recursive: true });
  for (const [path, content] of Object.entries(extra)) {
    await mkdir(dirname(join(copy, path)), { recursive: true });
    await writeFile(join(copy, path), content);
  }
  return copy;
}

describe("src/ui builds no markup from strings", () => {
  it("has none today", async () => {
    assert.deepEqual(await markupFromStrings(uiDir), []);
  });

  const PLANTED: readonly (readonly [string, string])[] = [
    ["innerHTML", "panel.innerHTML = node.desc;"],
    ["outerHTML", "box.outerHTML = text;"],
    ["insertAdjacentHTML", 'panel.insertAdjacentHTML("beforeend", text);'],
    ["document.write", "document.write(text);"],
    ["createContextualFragment", "range.createContextualFragment(text);"],
    ["DOMParser", 'new DOMParser().parseFromString(text, "text/html");'],
    ["setHTMLUnsafe", "panel.setHTMLUnsafe(text);"],
    ["srcdoc", "frame.srcdoc = text;"],
    ["eval", "eval(text);"],
    ["eval", "globalThis.eval(text);"],
    ["Function constructor", 'new Function("return " + text);'],
    ["Function constructor", 'Function("return " + text)();'],
  ];

  for (const [rule, line] of PLANTED) {
    it(`finds ${rule} in a file planted in a copy: ${line}`, async () => {
      const copy = await copyOfUi({ "planted.ts": `export const x = 1;\n${line}\n` });
      assert.deepEqual(await markupFromStrings(copy), [{ file: "planted.ts", rule }]);
    });
  }

  it("finds it in a nested directory and in index.html", async () => {
    const copy = await copyOfUi({
      "deep/er/planted.ts": "el.innerHTML = text;",
      "index.html": "<script>el.outerHTML = text</script>",
    });
    assert.deepEqual(await markupFromStrings(copy), [
      { file: "deep/er/planted.ts", rule: "innerHTML" },
      { file: "index.html", rule: "outerHTML" },
    ]);
  });

  it("does not flag words that only contain a forbidden one", async () => {
    const copy = await copyOfUi({
      "words.ts":
        "evaluate(); const retrieval = 1; const medieval = 2; textContent = 'x'; setFunction(1);",
    });
    assert.deepEqual(await markupFromStrings(copy), []);
  });
});

describe("src/ui imports only itself, core/types and packages", () => {
  it("does so today", async () => {
    assert.deepEqual(await strayImports(uiDir), []);
  });

  const STRAY: readonly (readonly [string, string])[] = [
    ["node:http", 'import { createServer } from "node:http";'],
    ["node:fs/promises", 'import("node:fs/promises");'],
    ["../server/server.js", 'import type { ServerEvent } from "../server/server.js";'],
    ["../core/scan.js", 'import { scan } from "../core/scan.js";'],
    ["../cli.js", 'export { run } from "../cli.js";'],
  ];

  for (const [specifier, line] of STRAY) {
    it(`finds ${specifier} in a file planted in a copy`, async () => {
      const copy = await copyOfUi({ "planted.ts": `${line}\n` });
      assert.deepEqual(await strayImports(copy), [{ file: "planted.ts", rule: specifier }]);
    });
  }

  it("allows its own modules, the types file and a package", async () => {
    const copy = await copyOfUi({
      "ok.ts": [
        'import type { Graph } from "../core/types.js";',
        'import { place } from "./layout.js";',
        'import { graphlib } from "@dagrejs/dagre";',
      ].join("\n"),
    });
    assert.deepEqual(await strayImports(copy), []);
  });
});
