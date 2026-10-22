import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseConfig } from "../src/core/config.js";
import { parseStateName } from "../src/core/expr.js";
import { scan } from "../src/core/scan.js";
import type { FlowEdge, HistoryEntry, ModelVar } from "../src/core/types.js";
import { depPairs, flows, ids, makeRepo, node, readGraph, ts, writeFiles } from "./helpers/repo.js";
import { fastestOf } from "./helpers/timing.js";

const T1 = new Date("2026-10-21T00:00:00.000Z");
const T2 = new Date("2026-10-21T01:00:00.000Z");
const T3 = new Date("2026-10-21T02:00:00.000Z");

const sha1 = (...contents: string[]) =>
  createHash("sha1")
    .update(Buffer.concat(contents.map((c) => Buffer.from(c))))
    .digest("hex");

const bool = (value: boolean) => ({ kind: "bool", value });
const int = (value: number) => ({ kind: "int", value });
const member = (name: string) => ({ kind: "member", name });
const cmp = (op: string, name: string, value: unknown) => ({ kind: "cmp", op, name, value });

describe("scan: walk", () => {
  it("skips ignored directories, config.ignore, other extensions and symlinks", async () => {
    const ignoredDirs = [
      "node_modules",
      ".git",
      "dist",
      "build",
      "out",
      ".next",
      "__pycache__",
      "venv",
      ".venv",
      "coverage",
      "target",
      "vendor",
      ".everypath",
    ];
    const files: Record<string, string> = {
      "src/a.ts": "export const a = 1;\n",
      "src/h.go": "package main\n",
      "src/i.py": "x = 1\n",
      "src/j.rb": "x = 1\n",
      "src/k.kt": "val x = 1\n",
      "generated/g.ts": "export const g = 1;\n",
      "notes.md": "# notes\n",
      "data.json": "{}\n",
      "everypath.config.json": JSON.stringify({ ignore: ["generated/**"] }),
    };
    for (const dir of ignoredDirs) files[`${dir}/hidden${dir.length}.ts`] = "export {};\n";
    const root = await makeRepo(files);
    await symlink(join(root, "src"), join(root, "linked"));
    await symlink(join(root, "src", "a.ts"), join(root, "src", "link.ts"));

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(ids(graph), ["a", "h", "i", "j", "k"]);
  });
});

describe("config: ignore globs", () => {
  const glob = (pattern: string) => {
    const [compiled] = parseConfig({ ignore: [pattern] }).config.ignore;
    assert.ok(compiled, pattern);
    return compiled;
  };

  it("keeps the meaning of **, *, ? and literal characters", () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["**/x", "x", true],
      ["**/x", "a/b/x", true],
      ["**/x", "ax", false],
      ["**/**/x", "a/x", true],
      ["generated/**", "generated/", true],
      ["generated/**", "generated/a/b.ts", true],
      ["generated/**", "generated", false],
      ["src/*.ts", "src/a.ts", true],
      ["src/*.ts", "src/a/b.ts", false],
      ["src/?.ts", "src/a.ts", true],
      ["src/?.ts", "src/ab.ts", false],
      ["a.ts", "abts", false],
      ["./lib/**", "lib/x.ts", true],
      ["lib\\*.ts", "lib/x.ts", true],
      ["**", "any/thing", true],
    ];
    for (const [pattern, path, expected] of cases) {
      assert.equal(glob(pattern).test(path), expected, `${pattern} against ${path}`);
    }
  });

  it("matches in time linear in the path, however many wildcards the pattern repeats", () => {
    const deep = Array.from({ length: 30 }, (_, i) => `d${i}`).join("/");
    const stacked = glob(`${"**/".repeat(10)}x`);
    const stars = glob(`${"*a".repeat(12)}b`);
    const { ms } = fastestOf(() => {
      assert.equal(stacked.test(deep), false);
      assert.equal(stacked.test(`${deep}/x`), true);
      assert.equal(stars.test("a".repeat(200)), false);
    });

    // The backtracking regex took about 183 s on the stacked pattern.
    assert.ok(ms < 1000, `${ms.toFixed(1)} ms`);
  });
});

describe("scan: node ids", () => {
  it("derives ids from @state, file names and directory names", async () => {
    const root = await makeRepo({
      "src/auth/login.ts": ts("@state ログイン"),
      "src/home.ts": "export {};\n",
      "src/mypage/index.ts": "export {};\n",
      "py/reset/__init__.py": "x = 1\n",
      "cmd/server/main.go": "package main\n",
      "src/login-form.ts": "export {};\n",
      "src/2fa.ts": "export {};\n",
      "src/state.ts": "export {};\n",
      "lib/a/utils.ts": "export {};\n",
      "lib/b/utils.ts": "export {};\n",
      "src/bad.ts": ts("@state login form"),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(
      ids(graph),
      [
        "_2fa",
        "bad",
        "home",
        "lib_a_utils",
        "lib_b_utils",
        "login_form",
        "mypage",
        "reset",
        "server",
        "state_",
        "ログイン",
      ].sort(),
    );
    for (const n of graph.nodes) assert.ok(parseStateName(n.id).ok, `${n.id} is a state name`);
    assert.deepEqual(node(graph, "ログイン").files, ["src/auth/login.ts"]);
    assert.deepEqual(node(graph, "lib_a_utils").files, ["lib/a/utils.ts"]);
    const bad = graph.warnings.filter((w) => w.file === "src/bad.ts");
    assert.equal(bad.length, 1);
    assert.equal(bad[0]?.line, 1);
  });

  it("aggregates every file with the same @state into one node", async () => {
    const root = await makeRepo({
      "src/x/b.ts": ts("@state X"),
      "src/x/a.ts": ts("@state X"),
    });
    const graph = await scan(root, { now: T1 });
    assert.deepEqual(ids(graph), ["X"]);
    assert.deepEqual(node(graph, "X").files, ["src/x/a.ts", "src/x/b.ts"]);
  });
});

describe("scan: annotation extraction", () => {
  it("reads tags from the first 60 lines only", async () => {
    const filler = Array.from({ length: 58 }, (_, i) => `const v${i} = ${i};`);
    const root = await makeRepo({
      "src/far.ts": [
        "// @state Far",
        ...filler,
        "// @state-next Near",
        "// @state-next Beyond",
        "",
      ].join("\n"),
    });
    const graph = await scan(root, { now: T1 });
    assert.deepEqual(
      flows(graph).map((e) => e.to),
      ["Near"],
    );
  });

  it("finds tags in //, #, /* */ and triple-quote comments, and after : or ：", async () => {
    const root = await makeRepo({
      "src/a.ts": "/* @state A */\n/* @state-desc 説明 */\n",
      "src/b.py": "# @state B\n",
      "src/c.py": '"""@state C"""\n',
      "src/d.ts": "// @state: D\n",
      "src/e.ts": "// @state：E\n",
    });
    const graph = await scan(root, { now: T1 });
    assert.deepEqual(ids(graph), ["A", "B", "C", "D", "E"]);
    assert.equal(node(graph, "A").desc, "説明");
    assert.deepEqual(graph.warnings, []);
  });

  it("warns on an unknown @state-xxx tag", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A", "@state-foo bar") });
    const graph = await scan(root, { now: T1 });
    assert.equal(graph.warnings.length, 1);
    assert.equal(graph.warnings[0]?.file, "src/a.ts");
    assert.equal(graph.warnings[0]?.line, 2);
  });

  it("turns the SPEC §5.2 login example into five flows with AST", async () => {
    const root = await makeRepo({
      "src/auth/login.ts": ts(
        "@state ログイン",
        "@state-group 画面",
        "@state-initial",
        "@state-var authed: BOOLEAN = FALSE",
        "@state-var retries: 0..3 = 0",
        "@state-next Home on:login_ok set:authed=TRUE, retries=0",
        "@state-next ログイン on:login_fail if:retries<3 set:retries=retries+1",
        "@state-next ロック on:login_fail if:retries==3",
        "@state-next 新規登録",
        "@state-next パスワードリセット",
        "@state-spec ensures authed => session != none",
      ),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(graph.warnings, []);
    const byTarget = new Map<string, FlowEdge>(flows(graph).map((e) => [e.to, e]));
    assert.equal(flows(graph).length, 5);
    for (const e of flows(graph)) assert.equal(e.from, "ログイン");
    const home = byTarget.get("Home");
    assert.equal(home?.event, "login_ok");
    assert.equal(home?.guard, null);
    assert.deepEqual(home?.set, [
      { target: "authed", value: bool(true) },
      { target: "retries", value: int(0) },
    ]);
    assert.equal(home?.text, "Home on:login_ok set:authed=TRUE, retries=0");
    assert.deepEqual(home?.via, ["src/auth/login.ts"]);
    const retry = byTarget.get("ログイン");
    assert.equal(retry?.event, "login_fail");
    assert.deepEqual(retry?.guard, cmp("<", "retries", int(3)));
    assert.deepEqual(retry?.set, [
      { target: "retries", value: { kind: "offset", of: "retries", delta: 1 } },
    ]);
    assert.deepEqual(byTarget.get("ロック")?.guard, cmp("==", "retries", int(3)));
    const signup = byTarget.get("新規登録");
    assert.equal(signup?.event, null);
    assert.equal(signup?.guard, null);
    assert.deepEqual(signup?.set, []);

    const login = node(graph, "ログイン");
    assert.equal(login.group, "画面");
    assert.deepEqual(login.spec, ["ensures authed => session != none"]);
    assert.equal(login.status.planned, false);
    for (const id of ["Home", "ロック", "新規登録", "パスワードリセット"]) {
      const planned = node(graph, id);
      assert.equal(planned.status.planned, true, `${id} is planned`);
      assert.deepEqual(planned.files, []);
    }
    assert.equal(graph.model.initial, "ログイン");
    assert.deepEqual([...graph.model.events].sort(), ["login_fail", "login_ok"]);
    assert.deepEqual(graph.model.vars, [
      { kind: "boolean", name: "authed", init: false },
      { kind: "range", name: "retries", min: 0, max: 3, init: 0 },
    ]);
    assert.equal(graph.stats.planned, 4);
    assert.equal(graph.stats.nodes, 5);
    assert.equal(graph.stats.edges, 5);
  });
});

describe("scan: test detection", () => {
  const files = {
    "src/a.ts": ts("@state A"),
    "src/b.ts": ts("@state A"),
    "src/c.ts": ts("@state C"),
    "src/d.ts": ts("@state D", "@state-tested"),
    "src/e.ts": ts("@state E"),
    "test/a.test.ts": 'import "../src/a";\n',
    "src/c.spec.ts": 'import { c } from "./c.js";\n',
    "src/__tests__/e.ts": "export {};\n",
  };

  it("marks imports of test files as tested and keeps test files out of the graph", async () => {
    const root = await makeRepo(files);
    const graph = await scan(root, { now: T1 });
    assert.deepEqual(ids(graph), ["A", "C", "D", "E"]);
    assert.equal(node(graph, "A").status.tested, false, "b.ts is not tested");
    assert.equal(node(graph, "C").status.tested, true);
    assert.equal(node(graph, "D").status.tested, true);
    assert.equal(node(graph, "E").status.tested, false);
    assert.equal(graph.stats.tested, 2);
    assert.equal(graph.stats.untested, 2);
  });

  it("turns test files into nodes under includeTests", async () => {
    const root = await makeRepo({
      ...files,
      "everypath.config.json": JSON.stringify({ includeTests: true }),
    });
    const graph = await scan(root, { now: T1 });
    assert.ok(ids(graph).includes("a_test"));
    assert.ok(ids(graph).includes("c_spec"));
    assert.equal(node(graph, "C").status.tested, true);
  });
});

describe("scan: import resolution", () => {
  it("resolves JS/TS relative imports, aliases and every import form", async () => {
    const root = await makeRepo({
      "everypath.config.json": JSON.stringify({ aliases: { "@": "src/lib" } }),
      "src/app.ts": [
        "// @state App",
        'import { a } from "./a";',
        'import b from "./b.js";',
        'import "./c";',
        'const d = require("./d");',
        'const e = await import("./e.mjs");',
        'export { f } from "./f";',
        'import g from "@/g";',
        'import h from "react";',
        "import {",
        "  i,",
        '} from "./i";',
        "",
      ].join("\n"),
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export default 1;\n",
      "src/c/index.ts": "export {};\n",
      "src/d.js": "module.exports = 1;\n",
      "src/e.mjs": "export default 1;\n",
      "src/f.tsx": "export const f = 1;\n",
      "src/lib/g.ts": "export default 1;\n",
      "src/i.ts": "export const i = 1;\n",
    });
    const graph = await scan(root, { now: T1 });
    assert.deepEqual(
      depPairs(graph),
      ["App->a", "App->b", "App->c", "App->d", "App->e", "App->f", "App->g", "App->i"].sort(),
    );
  });

  it("resolves Python absolute and relative imports from the documented bases", async () => {
    const root = await makeRepo({
      "app/views.py": [
        "# @state Views",
        "from models.user import User",
        "import util.helpers",
        "from .forms import Form",
        "from . import widgets",
        "from ..shared import base",
        "import os, sys",
        "",
      ].join("\n"),
      "src/models/user.py": "class User: pass\n",
      "util/helpers/__init__.py": "x = 1\n",
      "app/forms.py": "class Form: pass\n",
      "app/widgets.py": "x = 1\n",
      "shared.py": "base = 1\n",
    });
    const graph = await scan(root, { now: T1 });
    assert.deepEqual(
      depPairs(graph),
      ["Views->forms", "Views->helpers", "Views->shared", "Views->user", "Views->widgets"].sort(),
    );
  });
});

describe("scan: edges", () => {
  it("aggregates deps, drops dep self-loops, merges duplicate flows and plans unknown targets", async () => {
    const root = await makeRepo({
      "src/x1.ts": [
        ts("@state X", "@state-next X", "@state-next Y on:go", "@state-next Ghost"),
        'import "./x2";',
        'import "./y";',
        "",
      ].join("\n"),
      "src/x2.ts": [ts("@state X", "@state-next Y on:go"), 'import "./y";', ""].join("\n"),
      "src/y.ts": ts("@state Y"),
    });
    const graph = await scan(root, { now: T1 });

    assert.deepEqual(depPairs(graph), ["X->Y"]);
    const dep = graph.edges.find((e) => e.type === "dep");
    assert.deepEqual(dep?.via, ["src/x1.ts", "src/x2.ts"]);
    const flowPairs = flows(graph)
      .map((e) => `${e.from}->${e.to}`)
      .sort();
    assert.deepEqual(flowPairs, ["X->Ghost", "X->X", "X->Y"]);
    const toY = flows(graph).find((e) => e.to === "Y");
    assert.deepEqual(toY?.via, ["src/x1.ts", "src/x2.ts"]);
    const ghost = node(graph, "Ghost");
    assert.equal(ghost.status.planned, true);
    assert.equal(ghost.status.tested, false);
    assert.equal(node(graph, "Y").status.planned, false);
  });
});

describe("scan: model", () => {
  it("collects vars, events and the initial state, and checks names and types", async () => {
    const bLines = [
      "@state B",
      "@state-var flag: BOOLEAN = FALSE",
      "@state-var n: 0..5 = 0",
      "@state-initial",
      "@state-next A on:go if:ghost",
      "@state-next A if:flag==3",
      "@state-next A if:mode==sleeping",
      "@state-next A if:flag<2",
      "@state-next A set:n=4",
      "@state-next A set:flag=flag+1",
      "@state-next A if:n<3 && flag set:n=n+1, mode=busy",
    ];
    const root = await makeRepo({
      "src/a.ts": ts(
        "@state A",
        "@state-var flag: BOOLEAN = FALSE",
        "@state-var n: 0..3 = 0",
        "@state-var mode: {idle, busy} = idle",
        "@state-initial",
        "@state-event tick, tock",
      ),
      "src/b.ts": ts(...bLines),
    });

    const graph = await scan(root, { now: T1 });

    assert.equal(graph.model.initial, "A");
    assert.deepEqual([...graph.model.events].sort(), ["go", "tick", "tock"]);
    const vars = new Map<string, ModelVar>(graph.model.vars.map((v) => [v.name, v]));
    assert.equal(vars.size, 3);
    assert.deepEqual(vars.get("n"), { kind: "range", name: "n", min: 0, max: 3, init: 0 });
    assert.deepEqual(vars.get("mode"), {
      kind: "enum",
      name: "mode",
      members: ["idle", "busy"],
      init: "idle",
    });

    const warnedLines = graph.warnings
      .filter((w) => w.file === "src/b.ts")
      .map((w) => w.line)
      .sort((x, y) => (x ?? 0) - (y ?? 0));
    assert.deepEqual(warnedLines, [3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(graph.warnings.length, 8);

    const fromB = flows(graph).filter((e) => e.from === "B");
    assert.equal(fromB.length, 7);
    const ghost = fromB.find((e) => e.text === "A on:go if:ghost");
    assert.equal(ghost?.guard, null);
    assert.equal(ghost?.event, "go");
    for (const text of ["A if:flag==3", "A if:mode==sleeping", "A if:flag<2"]) {
      assert.equal(fromB.find((e) => e.text === text)?.guard, null, text);
    }
    for (const text of ["A set:n=4", "A set:flag=flag+1"]) {
      assert.deepEqual(fromB.find((e) => e.text === text)?.set, [], text);
    }
    const valid = fromB.find((e) => e.text === "A if:n<3 && flag set:n=n+1, mode=busy");
    assert.deepEqual(valid?.guard, {
      kind: "and",
      operands: [cmp("<", "n", int(3)), cmp("==", "flag", bool(true))],
    });
    assert.deepEqual(valid?.set, [
      { target: "n", value: { kind: "offset", of: "n", delta: 1 } },
      { target: "mode", value: member("busy") },
    ]);
  });
});

describe("scan: hash, findings, risks, review", () => {
  it("hashes node files concatenated in relative path order", async () => {
    const a = ts("@state X", "@state-desc first");
    const b = ts("@state X");
    const root = await makeRepo({ "src/x/b.ts": b, "src/x/a.ts": a });
    const graph = await scan(root, { now: T1 });
    assert.equal(node(graph, "X").hash, sha1(a, b));
    assert.equal(node(graph, "X").lines, 3);
  });

  it("normalizes semgrep findings and attaches risks", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-risk トークン期限を未検証"),
      "src/b.ts": ts("@state B"),
      "semgrep.json": JSON.stringify({
        results: [
          {
            check_id: "js.xss",
            path: "./src/a.ts",
            start: { line: 3 },
            extra: { message: "XSS", severity: "ERROR" },
          },
        ],
      }),
    });
    const graph = await scan(root, { now: T1 });
    assert.equal(graph.findingsSource, "semgrep.json");
    const a = node(graph, "A");
    assert.deepEqual(a.findings, [
      { file: "src/a.ts", line: 3, severity: "high", rule: "js.xss", message: "XSS" },
    ]);
    assert.equal(a.status.vuln, true);
    assert.deepEqual(a.risks, [{ file: "src/a.ts", message: "トークン期限を未検証" }]);
    assert.equal(node(graph, "B").status.vuln, false);
    assert.equal(graph.stats.vuln, 1);
  });

  it("normalizes bandit findings from config.findings", async () => {
    const root = await makeRepo({
      "app/b.py": "# @state B\n",
      "everypath.config.json": JSON.stringify({ findings: "reports/bandit.json" }),
      "semgrep.json": JSON.stringify({ results: [] }),
      "reports/bandit.json": JSON.stringify({
        results: [
          {
            filename: "./app/b.py",
            issue_text: "assert used",
            issue_severity: "MEDIUM",
            line_number: 7,
            test_id: "B101",
          },
        ],
      }),
    });
    const graph = await scan(root, { now: T1 });
    assert.equal(graph.findingsSource, "reports/bandit.json");
    assert.deepEqual(node(graph, "B").findings, [
      { file: "app/b.py", line: 7, severity: "medium", rule: "B101", message: "assert used" },
    ]);
  });

  it("prefers everypath.findings.json and reports no source when none exists", async () => {
    const empty = JSON.stringify({ results: [] });
    const withBoth = await makeRepo({
      "src/a.ts": ts("@state A"),
      "everypath.findings.json": empty,
      "semgrep.json": empty,
    });
    assert.equal((await scan(withBoth, { now: T1 })).findingsSource, "everypath.findings.json");
    const withNone = await makeRepo({ "src/a.ts": ts("@state A") });
    assert.equal((await scan(withNone, { now: T1 })).findingsSource, null);
  });

  it("compares review.json hashes and fills status flags and stats", async () => {
    const a = ts("@state A");
    const root = await makeRepo({
      "src/a.ts": a,
      "src/b.ts": ts("@state B"),
      "src/c.ts": ts("@state C", "@state-status wip", "@state-require proof"),
      ".everypath/review.json": JSON.stringify({
        version: 1,
        approvals: {
          A: { hash: sha1(a), at: "2026-10-20T00:00:00Z", by: "taiga", note: "" },
          B: { hash: "deadbeef", at: "2026-10-20T00:00:00Z", by: "taiga", note: "" },
        },
      }),
    });
    const graph = await scan(root, { now: T1 });
    assert.equal(node(graph, "A").status.reviewed, true);
    assert.equal(node(graph, "A").status.changedSinceReview, false);
    assert.equal(node(graph, "B").status.reviewed, false);
    assert.equal(node(graph, "B").status.changedSinceReview, true);
    const c = node(graph, "C");
    assert.equal(c.status.reviewed, false);
    assert.equal(c.status.changedSinceReview, false);
    assert.equal(c.status.wip, true);
    assert.equal(c.status.requireProof, true);
    assert.equal(c.status.proof, "none");
    assert.deepEqual(c.violations, []);
    assert.deepEqual(graph.stats, {
      nodes: 3,
      edges: 0,
      tested: 0,
      untested: 3,
      vuln: 0,
      wip: 1,
      planned: 0,
      unreviewed: 2,
    });
  });
});

describe("scan: lastChangedAt and history", () => {
  it("keeps lastChangedAt for unchanged nodes and appends only real diffs", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-next B"),
      "src/b.ts": ts("@state B"),
    });
    const first = await scan(root, { now: T1 });
    assert.equal(first.generatedAt, T1.toISOString());

    await writeFiles(root, {
      "src/b.ts": ts("@state B", "@state-desc changed"),
      "src/c.ts": [ts("@state C"), 'import "./a";', ""].join("\n"),
    });
    const second = await scan(root, { now: T2 });
    assert.equal(node(second, "A").lastChangedAt, T1.toISOString());
    assert.equal(node(second, "B").lastChangedAt, T2.toISOString());
    assert.equal(node(second, "C").lastChangedAt, T2.toISOString());

    const third = await scan(root, { now: T3 });
    assert.deepEqual(third.nodes, second.nodes);
    assert.deepEqual(third.edges, second.edges);
    assert.deepEqual(third.model, second.model);
    assert.deepEqual(third.warnings, second.warnings);
    assert.deepEqual(await readGraph(root), third);

    const history = (await readFile(join(root, ".everypath", "history.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as HistoryEntry);
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], {
      at: T1.toISOString(),
      reason: "scan",
      added: ["A", "B"],
      removed: [],
      updated: [],
      addedEdges: [{ type: "flow", from: "A", to: "B", event: null }],
      removedEdges: [],
    });
    assert.deepEqual(history[1], {
      at: T2.toISOString(),
      reason: "scan",
      added: ["C"],
      removed: [],
      updated: ["B"],
      addedEdges: [{ type: "dep", from: "C", to: "A", event: null }],
      removedEdges: [],
    });
  });

  it("records removed nodes and edges", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-next B"),
      "src/b.ts": ts("@state B"),
    });
    await scan(root, { now: T1 });
    await writeFile(join(root, "src", "a.ts"), ts("@state A"));
    await scan(root, { now: T2, reason: "watch" });
    const lines = (await readFile(join(root, ".everypath", "history.jsonl"), "utf8"))
      .trim()
      .split("\n");
    const last = JSON.parse(lines.at(-1) ?? "{}") as HistoryEntry;
    assert.equal(last.reason, "watch");
    assert.deepEqual(last.updated, ["A"]);
    assert.deepEqual(last.removedEdges, [{ type: "flow", from: "A", to: "B", event: null }]);
  });
});
