import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { printGuard } from "../src/core/expr.js";
import type { Flat } from "../src/core/flatten.js";
import { hierarchyOf, MAX_DEPTH, resolveHierarchy } from "../src/core/hierarchy.js";
import { toMermaid } from "../src/core/mermaid.js";
import { checkProperties } from "../src/core/properties.js";
import { analyze, scan } from "../src/core/scan.js";
import { generateTla, modelKey } from "../src/core/tla/generate.js";
import type { Graph, StateNode } from "../src/core/types.js";
import { makeRepo, node, runCli, ts, writeFiles } from "./helpers/repo.js";
import { exampleRepo } from "./helpers/tlc.js";
import { name } from "./helpers/ui-fixtures.js";

const T1 = new Date("2026-10-21T00:00:00.000Z");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const arcs = (flat: Flat): string[] =>
  flat.model.arcs.map(
    (arc) => `${arc.from}->${arc.to}${arc.event === null ? "" : `(${arc.event})`}`,
  );

const parentOf = (graph: Graph, id: string): string | undefined => node(graph, id).parent;

/** A logged-in area with two screens and a logout declared once, on the area. */
const AREA = {
  "src/area.ts": ts("@state Area", "@state-next Out on:logout"),
  "src/a.ts": ts("@state A", "@state-parent Area", "@state-initial", "@state-next B on:go"),
  "src/b.ts": ts("@state B", "@state-parent Area", "@state-next A on:back"),
  "src/out.ts": ts("@state Out"),
  "src/start.ts": ts("@state Start", "@state-initial", "@state-next Area on:login"),
} as const;

describe("hierarchy: a transition declared on a parent", () => {
  it("leaves every state inside it, and entering the parent lands on the marked child", async () => {
    const { graph, flat } = await analyze(await makeRepo(AREA), { now: T1 });

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(arcs(flat), [
      "A->B(go)",
      "A->Out(logout)",
      "B->A(back)",
      "B->Out(logout)",
      "Start->A(login)",
    ]);
    assert.deepEqual(flat.model.states, ["A", "B", "Out", "Start"]);
    assert.deepEqual(flat.entry, ["Start"]);
    assert.deepEqual(
      flat.model.arcs.filter((arc) => arc.event === "logout").map((arc) => arc.declared.from),
      ["Area", "Area"],
    );
    assert.equal(parentOf(graph, "A"), "Area");
    assert.equal(parentOf(graph, "Area"), undefined);
    assert.equal(node(graph, "Area").initialChild, "A");
  });

  it("yields to an inner state's unguarded transition on the same event", async () => {
    const root = await makeRepo({
      ...AREA,
      "src/a.ts": ts("@state A", "@state-parent Area", "@state-initial", "@state-next A on:logout"),
    });
    const { flat } = await analyze(root, { now: T1 });

    assert.deepEqual(
      arcs(flat).filter((arc) => arc.endsWith("(logout)")),
      ["A->A(logout)", "B->Out(logout)"],
    );
  });

  for (const [what, guard] of [
    ["does not check", "typo"],
    ["does not parse", "u &&"],
  ] as const) {
    it(`keeps the inherited arc, and says so, when an inner rival's if: ${what}`, async () => {
      const root = await makeRepo({
        ...AREA,
        "src/b.ts": ts(
          "@state B",
          "@state-parent Area",
          "@state-next A on:back",
          `@state-next X on:logout if:${guard}`,
        ),
        "src/x.ts": ts("@state X"),
      });
      const { graph, flat } = await analyze(root, { now: T1 });

      assert.ok(arcs(flat).includes("B->Out(logout)"), "B keeps Area's logout");
      assert.ok(arcs(flat).includes("B->X(logout)"), "the rival stays, without its if:");
      assert.deepEqual(
        graph.warnings.map((warning) => `${warning.file}:${warning.line}`),
        ["src/b.ts:4"],
      );
      assert.match(graph.warnings[0]?.message ?? "", /^if: /);
      assert.match(graph.warnings[0]?.message ?? "", /Area から継いだ logout の遷移は消しません/);
    });
  }

  it("fires only when no guarded inner rival on the same event can: g && !(r1 || r2)", async () => {
    const root = await makeRepo({
      ...AREA,
      "src/area.ts": ts(
        "@state Area",
        "@state-var u: BOOLEAN = FALSE",
        "@state-var v: BOOLEAN = FALSE",
        "@state-var w: BOOLEAN = FALSE",
        "@state-next Out on:logout if:u",
      ),
      "src/b.ts": ts(
        "@state B",
        "@state-parent Area",
        "@state-next X on:logout if:v",
        "@state-next Y on:logout if:w",
      ),
      "src/x.ts": ts("@state X"),
      "src/y.ts": ts("@state Y"),
    });
    const { flat } = await analyze(root, { now: T1 });
    const guardOf = (from: string, to: string): string | null => {
      const arc = flat.model.arcs.find((a) => a.from === from && a.to === to);
      assert.ok(arc !== undefined, `${from}->${to} is an arc`);
      return arc.guard === null ? null : printGuard(arc.guard);
    };

    assert.equal(guardOf("B", "Out"), "u && !(v || w)");
    assert.equal(guardOf("A", "Out"), "u");
    assert.equal(guardOf("B", "X"), "v");
  });

  it("lets the innermost state win across three levels", async () => {
    const root = await makeRepo({
      "src/outer.ts": ts("@state Outer", "@state-next X on:e"),
      "src/mid.ts": ts("@state Mid", "@state-parent Outer", "@state-next Y on:e"),
      "src/l.ts": ts("@state L", "@state-parent Mid", "@state-next Z on:e"),
      "src/m2.ts": ts("@state M2", "@state-parent Mid"),
      "src/o2.ts": ts("@state O2", "@state-parent Outer"),
      "src/x.ts": ts("@state X"),
      "src/y.ts": ts("@state Y"),
      "src/z.ts": ts("@state Z"),
    });
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(arcs(flat), ["L->Z(e)", "M2->Y(e)", "O2->X(e)"]);
  });

  it("never lets a transition with no event shadow another or be shadowed", async () => {
    const root = await makeRepo({
      "src/p.ts": ts("@state P", "@state-next X", "@state-next W on:go"),
      "src/c.ts": ts("@state C", "@state-parent P", "@state-next Y", "@state-next Z on:stop"),
      "src/w.ts": ts("@state W"),
      "src/x.ts": ts("@state X"),
      "src/y.ts": ts("@state Y"),
      "src/z.ts": ts("@state Z"),
    });
    const { flat } = await analyze(root, { now: T1 });

    assert.deepEqual(arcs(flat), ["C->W(go)", "C->X", "C->Y", "C->Z(stop)"]);
  });
});

describe("hierarchy: entering a parent", () => {
  const two = {
    "src/p.ts": ts("@state P"),
    "src/c1.ts": ts("@state C1", "@state-parent P"),
    "src/c2.ts": ts("@state C2", "@state-parent P"),
    "src/s.ts": ts("@state S", "@state-initial"),
  };
  const ambiguous = (graph: Graph) =>
    graph.warnings.filter((warning) => warning.message.includes("@state-initial がありません"));

  it("enters every child, and warns, when several children have no @state-initial", async () => {
    const root = await makeRepo({
      ...two,
      "src/s.ts": ts("@state S", "@state-initial", "@state-next P"),
    });
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.deepEqual(arcs(flat), ["S->C1", "S->C2"]);
    assert.equal(graph.warnings.length, 1);
    assert.match(graph.warnings[0]?.message ?? "", /P の子（C1、C2）/);
    assert.equal(ambiguous(graph).length, 1);
  });

  it("does not warn about an unmarked parent nothing enters", async () => {
    const { graph } = await analyze(await makeRepo(two), { now: T1 });
    assert.deepEqual(graph.warnings, []);
  });

  it("warns when the model starts in the unmarked parent, or the properties file enters it", async () => {
    const started = await analyze(
      await makeRepo({
        ...two,
        "src/p.ts": ts("@state P", "@state-initial"),
        "src/s.ts": ts("@state S"),
      }),
      { now: T1 },
    );
    assert.equal(ambiguous(started.graph).length, 1);
    assert.deepEqual(started.flat.entry, ["C1", "C2"]);

    const named = await analyze(
      await makeRepo({
        ...two,
        "everypath.properties.json": JSON.stringify({ entry: ["P"], properties: [] }),
      }),
      { now: T1 },
    );
    assert.equal(ambiguous(named.graph).length, 1);
    assert.deepEqual(named.flat.entry, ["C1", "C2"]);
  });

  it("enters the only child without a mark and without a warning", async () => {
    const root = await makeRepo({
      "src/p.ts": ts("@state P"),
      "src/c1.ts": ts("@state C1", "@state-parent P"),
      "src/s.ts": ts("@state S", "@state-initial", "@state-next P"),
    });
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.deepEqual(arcs(flat), ["S->C1"]);
    assert.deepEqual(graph.warnings, []);
  });

  it("descends through nested parents, each by its own mark", async () => {
    const root = await makeRepo({
      "src/p.ts": ts("@state P"),
      "src/q.ts": ts("@state Q", "@state-parent P", "@state-initial"),
      "src/r.ts": ts("@state R", "@state-parent P"),
      "src/q1.ts": ts("@state Q1", "@state-parent Q"),
      "src/q2.ts": ts("@state Q2", "@state-parent Q", "@state-initial"),
      "src/s.ts": ts("@state S", "@state-initial", "@state-next P"),
    });
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(arcs(flat), ["S->Q2"]);
  });

  it("lets a parent be the top-level @state-initial: the model starts in its entry", async () => {
    const root = await makeRepo({
      "src/p.ts": ts("@state P", "@state-initial"),
      "src/c.ts": ts("@state C", "@state-parent P", "@state-initial"),
    });
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.equal(graph.model.initial, "P");
    assert.deepEqual(flat.entry, ["C"]);
    assert.deepEqual(graph.warnings, []);
  });
});

describe("hierarchy: a tree that is not a tree never stops a scan (R-04)", () => {
  const chainOf = (length: number) => Array.from({ length }, (_, index) => name(`L${index}`));

  it("cuts every fourth link of a 2,000-link chain, the shallowest first, in under 100 ms", () => {
    const chain = chainOf(2000);
    const parents = chain.slice(1).map((node, index) => ({
      node,
      parent: chain[index] ?? node,
      file: `src/${node}.ts`,
      line: 2,
    }));
    const started = performance.now();
    const { nodes, problems } = resolveHierarchy({ nodes: chain, parents, initials: [] });
    const elapsed = performance.now() - started;

    assert.deepEqual(
      problems.map((problem) => (problem.kind === "parent-too-deep" ? problem.claim.node : "?")),
      chain.filter((_, index) => index > 0 && index % (MAX_DEPTH + 1) === 0),
    );
    const tree = hierarchyOf(nodes);
    assert.ok(chain.every((id) => tree.ancestorsOf(id).length <= MAX_DEPTH));
    assert.ok(elapsed < 100, `${Math.round(elapsed)} ms`);
  });

  it("caps the depth of a hand-edited graph.json, so a 20,000-link chain overflows no stack", () => {
    const chain = chainOf(20_000);
    const tree = hierarchyOf(
      chain.map((id, index) => {
        const parent = chain[index - 1];
        return parent === undefined ? { id } : { id, parent };
      }),
    );

    assert.deepEqual(tree.within(name("L0")), ["L3"]);
    assert.deepEqual(tree.ancestorsOf(name("L19999")), ["L19998", "L19997", "L19996"]);
  });

  it("drops the links of cycles and of a pile too deep, keeps every node, warns once each, exits 0", async () => {
    const chain = Array.from({ length: MAX_DEPTH + 2 }, (_, index) => `L${index}`);
    const files: Record<string, string> = {
      "src/a.ts": ts("@state A", "@state-parent B"),
      "src/b.ts": ts("@state B", "@state-parent A"),
      "src/me.ts": ts("@state Me", "@state-parent Me"),
      "src/x.ts": ts("@state X", "@state-parent Y"),
      "src/y.ts": ts("@state Y", "@state-parent Z"),
      "src/z.ts": ts("@state Z", "@state-parent X"),
      "src/t.ts": ts("@state T", "@state-parent A"),
    };
    for (const [index, id] of chain.entries()) {
      files[`src/${id}.ts`] = ts(
        `@state ${id}`,
        ...(index === 0 ? [] : [`@state-parent ${chain[index - 1]}`]),
      );
    }
    const root = await makeRepo(files);
    const graph = await scan(root, { now: T1 });

    for (const id of ["A", "B", "Me", "X", "Y", "Z", "L0", "L4"]) {
      assert.equal(parentOf(graph, id), undefined, id);
    }
    assert.equal(parentOf(graph, "T"), "A");
    assert.equal(parentOf(graph, "L3"), "L2");
    assert.equal(graph.nodes.length, 7 + chain.length);
    assert.equal(graph.warnings.length, 4, JSON.stringify(graph.warnings));
    assert.equal(runCli(["scan", root, "--quiet"]).status, 0);
  });

  it("keeps the first file's parent when two files of one state disagree, and warns at the later", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state S", "@state-parent P"),
      "src/b.ts": ts("@state S", "@state-parent Q"),
      "src/p.ts": ts("@state P"),
      "src/q.ts": ts("@state Q"),
    });
    const graph = await scan(root, { now: T1 });

    assert.equal(parentOf(graph, "S"), "P");
    assert.deepEqual(
      graph.warnings.map((warning) => `${warning.file}:${warning.line}`),
      ["src/b.ts:2"],
    );
  });

  it("makes a parent no file claims a container: no files, not planned, counted nowhere, and warns", async () => {
    const root = await makeRepo({ "src/c.ts": ts("@state C", "@state-parent Ghost") });
    const graph = await scan(root, { now: T1 });
    const ghost = node(graph, "Ghost");

    assert.deepEqual(ghost.files, []);
    assert.equal(ghost.container, true);
    assert.equal(ghost.status.planned, false);
    assert.equal(parentOf(graph, "C"), "Ghost");
    assert.deepEqual(
      [graph.stats.planned, graph.stats.untested, graph.stats.unreviewed],
      [0, 1, 1],
    );
    assert.deepEqual(
      graph.warnings.map((warning) => [warning.file, warning.line]),
      [["src/c.ts", 2]],
    );
    assert.match(graph.warnings[0]?.message ?? "", /Ghost/);
    assert.equal(runCli(["scan", root, "--quiet"]).status, 0);
  });

  it("writes parent, initialChild and container only when they are set", async () => {
    const graph = await scan(await makeRepo(AREA), { now: T1 });
    const keys = (node: StateNode) =>
      Object.keys(node).filter((key) => ["parent", "initialChild", "container"].includes(key));

    assert.deepEqual(keys(node(graph, "Out")), []);
    assert.deepEqual(keys(node(graph, "A")), ["parent"]);
    assert.deepEqual(keys(node(graph, "Area")), ["initialChild"]);
  });
});

describe("hierarchy: the @state-parent tag", () => {
  it("is read in every comment style, once per file, and not from hidden or test files", async () => {
    const root = await makeRepo({
      "src/p.ts": ts("@state P"),
      "src/slash.ts": ts("@state Slash", "@state-parent P"),
      "src/hash.py": "# @state Hash\n# @state-parent P\n",
      "src/block.ts": "/*\n * @state Block\n * @state-parent P\n */\n",
      "src/doc.py": '"""\n@state Doc\n@state-parent P\n"""\n',
      "src/twice.ts": ts("@state Twice", "@state-parent P", "@state-parent Q"),
      "src/bad.ts": ts("@state Bad", "@state-parent a-b"),
      "src/empty.ts": ts("@state Empty", "@state-parent"),
      "src/q.ts": ts("@state Q"),
      "src/hidden.ts": ts("@state Hidden", "@state-hidden", "@state-parent P"),
      "src/thing.test.ts": ts("@state Tested", "@state-parent P"),
    });
    const graph = await scan(root, { now: T1 });

    for (const id of ["Slash", "Hash", "Block", "Doc", "Twice"]) {
      assert.equal(parentOf(graph, id), "P", id);
    }
    assert.equal(parentOf(graph, "Bad"), undefined);
    assert.equal(parentOf(graph, "Empty"), undefined);
    assert.equal(
      graph.nodes.some((n) => n.id === "Hidden" || n.id === "Tested"),
      false,
    );
    assert.deepEqual(
      graph.warnings.map((warning) => `${warning.file}:${warning.line}`),
      ["src/bad.ts:2", "src/empty.ts:2", "src/twice.ts:3"],
    );
  });

  it("keeps one @state-initial per level, the first file's, with the top level's wording as before", async () => {
    const root = await makeRepo({
      "src/p.ts": ts("@state P"),
      "src/a.ts": ts("@state A", "@state-parent P", "@state-initial"),
      "src/b.ts": ts("@state B", "@state-parent P", "@state-initial"),
      "src/x.ts": ts("@state X", "@state-initial"),
      "src/y.ts": ts("@state Y", "@state-initial"),
    });
    const graph = await scan(root, { now: T1 });

    assert.equal(graph.model.initial, "X");
    assert.equal(node(graph, "P").initialChild, "A");
    assert.deepEqual(
      graph.warnings.map((warning) => warning.message),
      [
        "P の中に @state-initial が複数あります。先の src/a.ts の A を使います",
        "@state-initial が複数の状態にあります。先の src/x.ts の X を使います",
      ],
    );
  });

  it("counts the mark of a state whose parent was dropped as a top-level mark", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-parent B", "@state-initial"),
      "src/b.ts": ts("@state B", "@state-parent A"),
    });
    assert.equal((await scan(root, { now: T1 })).model.initial, "A");
  });
});

describe("hierarchy: a parent named in a property", () => {
  const props = (definitions: readonly unknown[], entry: readonly string[] = ["Start"]) =>
    JSON.stringify({ entry, properties: definitions });

  it("means the leaves inside it in state in, target, avoid and except; leaves alone are judged", async () => {
    const root = await makeRepo({
      ...AREA,
      "everypath.properties.json": props([
        { id: "in-area", kind: "invariant", expr: "state in {Area} => state != Out" },
        { id: "reach", kind: "never-reach", target: ["Area"] },
        { id: "reach-avoided", kind: "never-reach", target: ["Out"], avoid: ["Area"] },
        { id: "dead", kind: "no-dead-end", except: ["Out"] },
        { id: "dead-all", kind: "no-dead-end" },
        { id: "always", kind: "always-reach", target: ["Area"] },
      ]),
    });
    const { graph } = await analyze(root, { now: T1 });
    const result = (id: string) => graph.properties.find((p) => p.id === id);

    assert.equal(result("in-area")?.result, "ok");
    assert.deepEqual(result("reach")?.counterexamples[0]?.path, ["Start", "A"]);
    assert.equal(result("reach-avoided")?.result, "ok");
    assert.equal(result("dead")?.result, "ok");
    assert.deepEqual(
      result("dead-all")?.counterexamples.map((c) => c.path),
      [["Out"]],
    );
    assert.deepEqual(
      result("always")?.counterexamples.map((c) => c.path[0]),
      ["Out"],
    );
  });

  it("means its entry in the properties file's entry", async () => {
    const root = await makeRepo({ ...AREA, "everypath.properties.json": props([], ["Area"]) });
    assert.deepEqual((await analyze(root, { now: T1 })).flat.entry, ["A"]);
  });

  it("means it and every state under it in dep-only-via, and rolls no import up to it", async () => {
    const root = await makeRepo({
      "src/shell.ts": ts("@state Shell"),
      "src/screen.ts": `${ts("@state Screen", "@state-group UI", "@state-parent Shell")}import "./db.js";\n`,
      "src/db.ts": ts("@state Db"),
      "src/other.ts": `${ts("@state Other", "@state-group UI")}import "./shell.js";\n`,
      "everypath.properties.json": JSON.stringify({
        properties: [
          { id: "via", kind: "dep-only-via", from_group: "UI", target: ["Db"], via: ["Shell"] },
        ],
      }),
    });
    const { graph } = await analyze(root, { now: T1 });

    assert.deepEqual(
      graph.edges.filter((edge) => edge.type === "dep").map((edge) => `${edge.from}->${edge.to}`),
      ["Other->Shell", "Screen->Db"],
    );
    assert.equal(graph.properties.find((p) => p.id === "via")?.result, "ok");
  });
});

/** example/ with 認証済み holding Home and マイページ, logout declared once on it (or by hand on each). */
async function exampleTwins(): Promise<{ readonly hier: string; readonly flat: string }> {
  const read = (path: string) => readFile(join(repoRoot, "example", path), "utf8");
  const logout = "// @state-next ログアウト on:logout set:authed=FALSE\n";
  const [home, mypage, login] = await Promise.all([
    read("src/home.ts"),
    read("src/mypage.ts"),
    read("src/auth/login.ts"),
  ]);
  const hier = await exampleRepo();
  await writeFiles(hier, {
    "src/authed.ts": `// @state 認証済み\n// @state-group 画面\n${logout}`,
    "src/home.ts": home.replace(
      "// @state Home\n",
      "// @state Home\n// @state-parent 認証済み\n// @state-initial\n",
    ),
    "src/mypage.ts": mypage
      .replace("// @state マイページ\n", "// @state マイページ\n// @state-parent 認証済み\n")
      .replace(logout, ""),
    "src/auth/login.ts": login.replace(
      "@state-next Home on:login_ok",
      "@state-next 認証済み on:login_ok",
    ),
  });
  const flat = await exampleRepo();
  await writeFile(
    join(flat, "src/home.ts"),
    home.replace("// @state-route", `${logout}// @state-route`),
  );
  return { hier, flat };
}

describe("hierarchy: a parent is a shorthand, never a different model", () => {
  it("gives a hierarchical example and its hand-flattened twin the same modelKey and quick check", async () => {
    const { hier, flat } = await exampleTwins();
    const [a, b] = await Promise.all([analyze(hier, { now: T1 }), analyze(flat, { now: T1 })]);
    const key = (analyzed: typeof a) => {
      const generated = generateTla(analyzed.flat);
      assert.ok(generated.ok);
      return modelKey(generated.model);
    };

    assert.equal(a.graph.warnings.length, b.graph.warnings.length);
    assert.equal(key(a), key(b));
    assert.deepEqual(
      checkProperties(a.flat, "t").properties,
      checkProperties(b.flat, "t").properties,
    );
    assert.ok(a.graph.nodes.some((n) => n.id === "認証済み"));
  });

  it("writes into Model.tla exactly the arcs the quick check searches, inherited ones marked", async () => {
    const { flat } = await analyze(
      await makeRepo({
        ...AREA,
        "src/b.ts": ts(
          "@state B",
          "@state-parent Area",
          "@state-var v: BOOLEAN = FALSE",
          "@state-next A on:back",
          "@state-next Out on:logout if:v",
        ),
        "everypath.properties.json": JSON.stringify({ entry: ["Start"], properties: [] }),
      }),
      { now: T1 },
    );
    const generated = generateTla(flat);
    assert.ok(generated.ok);
    const { tla, names } = generated.model;
    const written = [...tla.matchAll(/^A\d+ ==\n((?: {2}.*\n?)+)/gm)].map((match) => {
      const body = match[1] ?? "";
      const from = /state = "([^"]+)"/.exec(body)?.[1] ?? "";
      const to = /state' = "([^"]+)"/.exec(body)?.[1] ?? "";
      const event = /lastEvent' = "([^"]+)"/.exec(body)?.[1] ?? "";
      return `${names.states[from]}->${names.states[to]}${event === "tau" ? "" : `(${names.events[event]})`}`;
    });

    assert.deepEqual(written, arcs(flat));
    assert.equal(tla.match(/（Area から継承）/g)?.length, 2);
    assert.ok(!tla.includes('"Area"'));
  });

  it("keeps TLC's key when only a comment of a parent changes", async () => {
    const key = async (note: string) => {
      const { flat } = await analyze(
        await makeRepo({
          ...AREA,
          "src/area.ts": ts("@state Area", "@state-next Out on:logout", `@state-desc ${note}`),
        }),
        { now: T1 },
      );
      const generated = generateTla(flat);
      assert.ok(generated.ok);
      return modelKey(generated.model);
    };
    assert.equal(await key("one"), await key("two"));
  });
});

describe("hierarchy: a model too large for TLC", () => {
  /** P holds `children` unmarked children; S enters P. A stored result.json makes every scan generate. */
  const parentWith = (children: number, p: string): Record<string, string> => {
    const files: Record<string, string> = {
      "src/p.ts": p,
      "src/s.ts": ts("@state S", "@state-initial", "@state-next P on:go"),
      "everypath.properties.json": JSON.stringify({
        properties: [{ id: "no-c1", kind: "never-reach", target: ["C1"] }],
      }),
      ".everypath/tla/result.json": JSON.stringify({ version: 1, key: "old", properties: [] }),
    };
    for (let index = 0; index < children; index++) {
      files[`src/c${index}.ts`] = ts(`@state C${index}`, "@state-parent P");
    }
    return files;
  };
  const tooLarge = (graph: Graph) =>
    graph.warnings.filter((warning) => warning.message.includes("Model.tla を作りません"));

  it("skips Model.tla for the 1,000-children arc explosion and names the parent; the scan and the quick check go on", async () => {
    const root = await makeRepo(parentWith(1000, ts("@state P", "@state-next P on:reset")));
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.equal(flat.model.arcs.length, 1000 * 1000 + 1000);
    const generated = generateTla(flat);
    assert.ok(!generated.ok);
    assert.match(generated.reason, /1001000 本で、上限 20000 本/);
    const [warning, ...others] = tooLarge(graph);
    assert.deepEqual(others, []);
    assert.equal(warning?.message, generated.reason);
    assert.match(warning?.message ?? "", /親: P（1001000 本）/);
    assert.equal(warning?.file, "src/p.ts");
    assert.equal(graph.properties.find((p) => p.id === "no-c1")?.result, "violated");
  });

  it("skips Model.tla once its text would pass 8 MB, with few arcs and one long guard", async () => {
    const guard = Array.from({ length: 10_000 }, (_, index) => `n == ${index % 4}`).join(" || ");
    const root = await makeRepo(
      parentWith(
        100,
        ts("@state P", "@state-var n: 0..3 = 0", `@state-next S on:back if:${guard}`),
      ),
    );
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.ok(flat.model.arcs.length < 20_000);
    const generated = generateTla(flat);
    assert.ok(!generated.ok);
    assert.match(generated.reason, /Model.tla が上限 8 MB を超える/);
    assert.equal(tooLarge(graph).length, 1);
  });

  it("warns about nothing for a model inside both budgets", async () => {
    const { graph } = await analyze(await makeRepo(parentWith(3, ts("@state P"))), { now: T1 });
    assert.deepEqual(tooLarge(graph), []);
  });
});

describe("hierarchy: drift", () => {
  it("counts a child's call as declared when its parent declares the transition", async () => {
    const root = await makeRepo({
      ...AREA,
      "src/a.ts": `${ts("@state A", "@state-parent Area", "@state-initial", "@state-next B on:go")}router.push("/out");\n`,
      "src/out.ts": ts("@state Out", "@state-route /out"),
    });
    const { graph } = await analyze(root, { now: T1 });

    assert.deepEqual(graph.drift, []);
    const logout = graph.edges.find((edge) => edge.type === "flow" && edge.from === "Area");
    assert.equal(logout?.type === "flow" && logout.observed, true);
  });

  const driftOf = (graph: Graph): string[] =>
    graph.drift.map((drift) => `${drift.from}->${drift.to}`);

  it("counts a leaf's call as drift when an inner transition shadowed its parent's", async () => {
    const root = await makeRepo({
      ...AREA,
      "src/a.ts": `${ts("@state A", "@state-parent Area", "@state-initial", "@state-next A on:logout")}router.push("/out");\n`,
      "src/out.ts": ts("@state Out", "@state-route /out"),
    });
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.ok(!arcs(flat).includes("A->Out(logout)"), "A's logout stays in A");
    assert.deepEqual(driftOf(graph), ["A->Out"]);
    const logout = graph.edges.find((edge) => edge.type === "flow" && edge.from === "Area");
    assert.equal(logout?.type === "flow" && logout.observed, false);
  });

  it("counts a call between children as drift under a parent's self-loop, except where re-entry lands", async () => {
    const root = await makeRepo({
      "src/p.ts": ts("@state P", "@state-next P on:reset"),
      "src/a.ts": `${ts("@state A", "@state-parent P", "@state-initial", "@state-route /a")}router.push("/b");\n`,
      "src/b.ts": `${ts("@state B", "@state-parent P", "@state-route /b")}router.push("/a");\n`,
    });
    const { graph, flat } = await analyze(root, { now: T1 });

    assert.deepEqual(arcs(flat), ["A->A(reset)", "B->A(reset)"]);
    assert.deepEqual(driftOf(graph), ["A->B"]);
  });
});

describe("hierarchy: Mermaid", () => {
  it("writes a parent as a composite state, its arrows in the block that holds both ends", async () => {
    const { graph } = await analyze(await makeRepo(AREA), { now: T1 });

    assert.equal(
      toMermaid(graph),
      [
        "stateDiagram-v2",
        "    classDef violated fill:#f8cecc,stroke:#c62828,stroke-width:3px,color:#222222",
        "    classDef planned fill:#ffffff,stroke:#8c8c8c,stroke-width:1.5px,stroke-dasharray:6 4,color:#8c8c8c",
        "    s2 : Area",
        "    state s2 {",
        "        s1 : A",
        "        s3 : B",
        "        [*] --> s1",
        "        s1 --> s3 : go",
        "        s3 --> s1 : back",
        "    }",
        "    s4 : Out",
        "    s5 : Start",
        "    [*] --> s5",
        "    s2 --> s4 : logout",
        "    s5 --> s2 : login",
        "",
      ].join("\n"),
    );
  });

  it("marks leaves only, draws no entry arrow inside an unmarked parent, and never marks a container planned", async () => {
    const root = await makeRepo({
      "src/c1.ts": ts("@state C1", "@state-parent P"),
      "src/c2.ts": ts("@state C2", "@state-parent P"),
      "src/s.ts": ts("@state S", "@state-initial", "@state-next P", "@state-next Later"),
      "everypath.properties.json": JSON.stringify({
        entry: ["S"],
        properties: [{ id: "no-c1", kind: "never-reach", target: ["C1"] }],
      }),
    });
    const { graph } = await analyze(root, { now: T1 });
    const text = toMermaid(graph);
    const id = (state: string) => `s${graph.nodes.findIndex((n) => n.id === state) + 1}`;

    assert.match(text, new RegExp(`class ${id("C1")},${id("S")} violated\n`));
    assert.match(text, new RegExp(`class ${id("Later")} planned\n`));
    assert.ok(!new RegExp(`class [^\n]*${id("P")}\\b`).test(text));
    const start = text.indexOf(`state ${id("P")} {`);
    assert.ok(start > 0, "P is a composite state");
    assert.ok(!text.slice(start, text.indexOf("}", start)).includes("[*]"));
  });
});

describe("hierarchy: documentation", () => {
  for (const path of ["skill/SKILL.md", "README.md"]) {
    it(`${path} names @state-parent and shows it in an example`, async () => {
      const text = await readFile(join(repoRoot, path), "utf8");
      const fences = [...text.matchAll(/^```\w*\n([\s\S]*?)^```$/gm)].map(([, body = ""]) => body);

      assert.match(text, /`@state-parent <[^>]+>`/);
      assert.ok(fences.some((body) => body.includes("@state-parent")));
    });
  }
});

describe("hierarchy: the tree is total", () => {
  it("answers [] for a name the graph does not have", async () => {
    const { flat } = await analyze(await makeRepo(AREA), { now: T1 });
    assert.deepEqual(flat.model.hierarchy.within(name("Nowhere")), []);
  });
});
