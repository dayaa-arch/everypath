import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { describe, it } from "node:test";
import type { FlowEdge } from "../src/core/types.js";
import { flows, makeRepo, readGraph, runCli, ts } from "./helpers/repo.js";
import { exampleRepo, fakeJava, fixture } from "./helpers/tlc.js";

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
    const byTarget = new Map<string, FlowEdge>(flows(graph).map((e) => [e.to, e]));
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

describe("R-03 and R-01: check runs without Java and writes only under .everypath/", () => {
  it("exits 0 or 1 with an empty PATH and leaves every other file byte-identical", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-initial", "@state-next B on:go"),
      "src/b.ts": ts("@state B"),
      "everypath.properties.json": JSON.stringify({
        properties: [
          { id: "nr", kind: "never-reach", target: ["B"] },
          { id: "vars", kind: "invariant", expr: "x" },
        ],
      }),
    });
    const before = await snapshot(root);
    const emptyPath = await mkdtemp(join(tmpdir(), "everypath-nojava-"));

    const result = runCli(["check", root], root, { ...process.env, PATH: emptyPath });

    assert.ok(result.status === 0 || result.status === 1, `${result.status}: ${result.stderr}`);
    assert.deepEqual(await snapshot(root), before);
    await rm(emptyPath, { recursive: true, force: true });
  });
});

describe("R-03: check --tlc without Java or the jar decides by the quick check", () => {
  const withProperties = {
    "src/a.ts": ts("@state A", "@state-initial", "@state-next B on:go"),
    "src/b.ts": ts("@state B"),
    "everypath.properties.json": JSON.stringify({
      properties: [
        { id: "nr", kind: "never-reach", target: ["B"] },
        { id: "vars", kind: "invariant", expr: "x" },
      ],
    }),
  };
  const withoutEntry = {
    "src/a.ts": ts("@state A", "@state-next B"),
    "src/b.ts": ts("@state B", "@state-next A"),
    "everypath.properties.json": JSON.stringify({
      properties: [{ id: "lt", kind: "leads-to", from: "state == A", to: "state == B" }],
    }),
  };

  async function expectInstallGuidance(
    files: Record<string, string>,
    environment: (jarDirectory: string) => NodeJS.ProcessEnv,
  ): Promise<void> {
    const root = await makeRepo(files);
    const jarDirectory = await makeRepo({ "tla2tools.jar": "not a jar" });
    const plain = runCli(["check", root]);
    const before = await snapshot(root);

    const result = runCli(["check", "--tlc", root], root, environment(jarDirectory));

    assert.ok(result.status === 0 || result.status === 1, `${result.status}: ${result.stderr}`);
    assert.equal(result.status, plain.status);
    assert.equal(result.stdout, plain.stdout);
    assert.match(result.stderr, /everypath tla install/);
    assert.deepEqual(await snapshot(root), before);
  }

  it("says how to install when java is not on the PATH, though a property cannot become TLA+", async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), "everypath-nojava-"));
    await expectInstallGuidance(withProperties, (jarDirectory) => ({
      ...process.env,
      PATH: emptyPath,
      EVERYPATH_TLA_JAR: join(jarDirectory, "tla2tools.jar"),
    }));
    await rm(emptyPath, { recursive: true, force: true });
  });

  it("says so first when java is missing and no state can start the model", async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), "everypath-nojava-"));
    await expectInstallGuidance(withoutEntry, (jarDirectory) => ({
      ...process.env,
      PATH: emptyPath,
      EVERYPATH_TLA_JAR: join(jarDirectory, "tla2tools.jar"),
    }));
    await rm(emptyPath, { recursive: true, force: true });
  });

  it("treats a java that cannot run, like the macOS stub with no JDK, as missing", async () => {
    const stub = await makeRepo({ "bin/java": "#!/bin/sh\nexit 1\n" });
    await chmod(join(stub, "bin", "java"), 0o755);
    await expectInstallGuidance(withProperties, (jarDirectory) => ({
      ...process.env,
      PATH: `${join(stub, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      EVERYPATH_TLA_JAR: join(jarDirectory, "tla2tools.jar"),
    }));
  });

  it("says how to install when the jar is missing", async () => {
    await expectInstallGuidance(withProperties, (jarDirectory) => ({
      ...process.env,
      EVERYPATH_TLA_JAR: join(jarDirectory, "missing", "tla2tools.jar"),
    }));
  });

  it("says so first even when no state can start the model", async () => {
    await expectInstallGuidance(withoutEntry, (jarDirectory) => ({
      ...process.env,
      EVERYPATH_TLA_JAR: join(jarDirectory, "missing", "tla2tools.jar"),
    }));
  });
});

describe("R-01: check --tlc writes only under .everypath/", () => {
  it("leaves every other file byte-identical while TLC runs", async () => {
    const root = await exampleRepo();
    const java = await fakeJava({ rules: [], otherwise: { output: await fixture("ok") } });
    const before = await snapshot(root);

    const result = runCli(["check", "--tlc", root], root, java.env);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal((await java.cfgs()).length, 2);
    assert.deepEqual(await snapshot(root), before);
    const tla = (await readdir(join(root, ".everypath", "tla"))).sort();
    assert.deepEqual(tla, ["Model.cfg", "Model.tla", "result.json"]);
  });
});
