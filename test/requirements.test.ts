import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { flows, makeRepo, readGraph, runCli, ts } from "./helpers/repo.js";

/** sha1 of every file outside `.everypath/`, keyed by root-relative path. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const rel = relative(root, path);
    if (rel.split(/[\\/]/)[0] === ".everypath") continue;
    hashes.set(
      rel,
      createHash("sha1")
        .update(await readFile(path))
        .digest("hex"),
    );
  }
  return hashes;
}

describe("R-01: scan writes only under .everypath/", () => {
  it("leaves every other file byte-identical and creates graph.json and history.jsonl", async () => {
    const root = await makeRepo({
      ".gitignore": ".everypath/*\n!.everypath/review.json\n",
      "everypath.config.json": JSON.stringify({ aliases: { "@": "src" } }),
      "semgrep.json": JSON.stringify({ results: [] }),
      "src/auth/login.ts": [
        ts("@state ログイン", "@state-initial", "@state-next Home on:login_ok"),
        'import { db } from "@/db";',
        "",
      ].join("\n"),
      "src/db.ts": ts("@state DB層"),
      "src/home.ts": ts("@state Home", "@state-next ログイン on:logout"),
      "test/home.test.ts": 'import "../src/home";\n',
      "app/views.py": "# @state Views\nfrom .models import M\n",
      "app/models.py": "class M: pass\n",
      ".everypath/review.json": JSON.stringify({ version: 1, approvals: {} }),
    });
    const before = await snapshot(root);

    const result = runCli(["scan", root]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await snapshot(root), before);
    const everypath = (await readdir(join(root, ".everypath"))).sort();
    assert.deepEqual(everypath, ["graph.json", "history.jsonl", "review.json"]);
    assert.ok((await readGraph(root)).nodes.length > 0);
  });
});

describe("R-04: out-of-grammar annotations never stop the scan", () => {
  it("records 10 warnings, keeps the edges without guard or set, and exits 0", async () => {
    const lines = [
      "@state R04",
      "@state-var ok: BOOLEAN = FALSE",
      "@state-next T1 if:isValid(x)",
      '@state-next T2 if:name == "bob"',
      "@state-next T3 if:ok ~ ok",
      "@state-next T4 if:(ok && ok",
      "@state-next T5 if:ok = TRUE",
      "@state-next T6 if:ok => ok",
      "@state-next T7 set:ok=ok && ok",
      "@state-next T8 set:ok=ok+2",
      '@state-var name: string = "x"',
      "@state-var big: 3..1 = 1",
    ];
    const root = await makeRepo({ "src/r04.ts": ts(...lines) });

    const result = runCli(["scan", root]);

    assert.equal(result.status, 0, result.stderr);
    const graph = await readGraph(root);
    assert.equal(graph.warnings.length, 10);
    for (const warning of graph.warnings) {
      assert.equal(warning.file, "src/r04.ts");
      assert.ok(warning.line !== null && warning.line >= 3, `line ${warning.line}`);
    }
    const byTarget = new Map(flows(graph).map((e) => [e.to, e]));
    for (const target of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
      const edge = byTarget.get(target);
      assert.ok(edge, `${target} edge exists`);
      assert.equal(edge.guard, null, target);
    }
    for (const target of ["T7", "T8"]) {
      const edge = byTarget.get(target);
      assert.ok(edge, `${target} edge exists`);
      assert.deepEqual(edge.set, [], target);
    }
    assert.deepEqual(
      graph.model.vars.map((v) => v.name),
      ["ok"],
    );
  });
});
