import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * What `@state-parent` means is decided in `core/hierarchy.ts` and applied once in `core/flatten.ts`.
 * The types keep a checking lane from taking an unflattened graph (`test/hierarchy.check.ts`); this
 * keeps any other module from reading the tree on its own, which no type can stop: `node.parent` is a
 * plain field of graph.json.
 */
const src = fileURLToPath(new URL("../src", import.meta.url));

type Rule = {
  readonly what: string;
  readonly pattern: RegExp;
  readonly allowed: readonly string[];
};

const RULES: readonly Rule[] = [
  {
    what: "a node's `.parent` field",
    pattern: /\.parent\b(?!\s*\()/,
    allowed: ["core/annotations.ts", "core/hierarchy.ts", "core/scan.ts"],
  },
  {
    what: "a node's `initialChild` field",
    pattern: /\binitialChild\b(?!\s*\()/,
    allowed: ["core/hierarchy.ts", "core/scan.ts", "core/types.ts"],
  },
  {
    what: "where entering a parent lands (`enter`, `ambiguousEntries`)",
    pattern: /\.(enter|ambiguousEntries)\s*\(/,
    allowed: ["core/flatten.ts", "core/hierarchy.ts"],
  },
  {
    what: "what a parent's name covers (`within`, `subtree`)",
    pattern: /\.(within|subtree)\s*\(/,
    allowed: ["core/flatten.ts", "core/hierarchy.ts", "ui/layout.ts"],
  },
];

async function sources(): Promise<ReadonlyMap<string, string>> {
  const entries = await readdir(src, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  return new Map(
    await Promise.all(
      files.map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(src, path), await readFile(path, "utf8")] as const;
      }),
    ),
  );
}

function offenders(files: ReadonlyMap<string, string>, rule: Rule): string[] {
  return [...files]
    .filter(([path, text]) => rule.pattern.test(text) && !rule.allowed.includes(path))
    .map(([path]) => path)
    .sort();
}

const PLANTED =
  "node.parent; x.initialChild; h.enter(a); h.ambiguousEntries(a); h.within(a); h.subtree(a);";

describe("hierarchy boundaries: who may read the tree", () => {
  for (const rule of RULES) {
    it(`reads ${rule.what} only in ${rule.allowed.join(", ")}`, async () => {
      assert.deepEqual(offenders(await sources(), rule), []);
    });

    it(`finds ${rule.what} in a file planted among the sources`, async () => {
      const planted = new Map(await sources());
      planted.set("core/properties.ts", `${planted.get("core/properties.ts") ?? ""}\n${PLANTED}`);
      planted.set("ui/render.ts", `${planted.get("ui/render.ts") ?? ""}\n${PLANTED}`);
      assert.deepEqual(offenders(planted, rule), ["core/properties.ts", "ui/render.ts"]);
    });
  }

  it("has the files it names", async () => {
    const files = await sources();
    for (const path of new Set(RULES.flatMap((rule) => rule.allowed))) {
      assert.ok(files.has(path), path);
    }
  });
});
