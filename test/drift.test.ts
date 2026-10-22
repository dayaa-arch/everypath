import assert from "node:assert/strict";
import { appendFile, cp, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, scan } from "../src/core/scan.js";
import { generateTla } from "../src/core/tla/generate.js";
import type { Graph, HistoryEntry } from "../src/core/types.js";
import { deps, flows, makeRepo, runCli, ts, writeFiles } from "./helpers/repo.js";

const T1 = new Date("2026-10-21T00:00:00.000Z");
const T2 = new Date("2026-10-21T01:00:00.000Z");

const example = fileURLToPath(new URL("../example", import.meta.url));

/** A file: its annotation block, then its code. */
const file = (tags: readonly string[], ...code: string[]): string =>
  `${ts(...tags)}\n${code.join("\n")}\n`;

const observedEdges = (graph: Graph) => graph.edges.filter((edge) => edge.type === "observed");

const driftPairs = (graph: Graph): string[] =>
  graph.drift.map((entry) => `${entry.from}->${entry.to}`);

async function historyOf(root: string): Promise<HistoryEntry[]> {
  return (await readFile(join(root, ".everypath", "history.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as HistoryEntry);
}

async function copyOfExample(): Promise<string> {
  const root = await makeRepo({});
  await cp(example, root, { recursive: true, filter: (path) => basename(path) !== ".everypath" });
  return root;
}

describe("drift: @state-route", () => {
  it("accepts /, a trailing slash, a parameter and several routes on one file", async () => {
    const root = await makeRepo({
      "src/top.ts": ts("@state Top", "@state-route /"),
      "src/reset.ts": ts("@state Reset", "@state-route /reset/", "@state-route /forgot"),
      "src/user.ts": ts("@state User", "@state-route /users/:id"),
      "src/nav.ts": file(
        ["@state Nav"],
        'router.push("/");',
        'router.push("/reset");',
        'router.push("/forgot");',
        'router.push("/users/42");',
      ),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(driftPairs(graph), ["Nav->Reset", "Nav->Top", "Nav->User"]);
  });

  it("warns on each malformed route by file and line, and keeps scanning", async () => {
    const root = await makeRepo({
      "src/bad.ts": ts(
        "@state Bad",
        "@state-route reset",
        "@state-route /a?b=1",
        "@state-route /a#top",
        "@state-route /a b",
        "@state-route /a//b",
        "@state-route /users/:",
        "@state-route /users/:1d",
        "@state-route /ok",
      ),
      "src/nav.ts": file(
        ["@state Nav"],
        'router.push("/a");',
        'router.push("/a/b");',
        'router.push("/users/1");',
        'router.push("/ok");',
      ),
    });

    const result = runCli(["scan", root, "--quiet"]);
    assert.equal(result.status, 0, result.stderr);
    const graph = await scan(root, { now: T1 });

    assert.deepEqual(
      graph.warnings.map((w) => [w.file, w.line]),
      [2, 3, 4, 5, 6, 7, 8].map((line) => ["src/bad.ts", line]),
    );
    for (const warning of graph.warnings) assert.match(warning.message, /@state-route/);
    assert.deepEqual(driftPairs(graph), ["Nav->Bad"]);
  });

  it("keeps the first file's state when two states claim one route", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-route /users/:id"),
      "src/b.ts": ts("@state B", "@state-route /users/:uid"),
      "src/c.ts": ts("@state C", "@state-route /x"),
      "src/d.ts": ts("@state D", "@state-route /x"),
      "src/e1.ts": ts("@state E", "@state-route /e"),
      "src/e2.ts": ts("@state E", "@state-route /e"),
      "src/nav.ts": file(
        ["@state Nav"],
        'router.push("/users/1");',
        'router.push("/x");',
        'router.push("/e");',
      ),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(
      graph.warnings.map((w) => [w.file, w.line]),
      [
        ["src/b.ts", 2],
        ["src/d.ts", 2],
      ],
    );
    assert.deepEqual(driftPairs(graph), ["Nav->A", "Nav->C", "Nav->E"]);
  });
});

describe("drift: extraction", () => {
  const routes = Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [
      `src/p${n}.ts`,
      ts(`@state P${n}`, `@state-route /p${n}`),
    ]),
  );

  it("reads the literal navigation forms of JS and TS files", async () => {
    const root = await makeRepo({
      ...routes,
      "src/nav.tsx": file(
        ["@state Nav"],
        'router.push("/p1");',
        "this.router.replace('/p2', undefined, { shallow: true });",
        'redirect("/p3");',
        'res.redirect(301, "/p4");',
        'navigate("/p5", { replace: true });',
        'export const six = <Link href="/p6">six</Link>;',
        "export const seven = <a href={'/p7'}>seven</a>;",
        'router.push("/p8?tab=1#top");',
      ),
      "src/legacy.cjs": file(["@state Legacy"], 'res.redirect("/p1");'),
      "src/plain.js": file(["@state Plain"], 'navigate("/p2");'),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(driftPairs(graph), [
      "Legacy->P1",
      "Nav->P1",
      "Nav->P2",
      "Nav->P3",
      "Nav->P4",
      "Nav->P5",
      "Nav->P6",
      "Nav->P7",
      "Nav->P8",
      "Plain->P2",
    ]);
  });

  it("records nothing it would have to guess, and nothing outside JS and TS", async () => {
    const root = await makeRepo({
      "src/x.ts": ts("@state X", "@state-route /x", "@state-route /x/:id"),
      "src/nav.tsx": file(
        ["@state Nav"],
        "router.push(`/x`);",
        `router.push(\`/x/\${id}\`);`,
        "router.push(path);",
        'router.push("/x/" + id);',
        'router.push(ok ? "/x" : "/y");',
        'navigate("https://example.com/x");',
        'export const cdn = <a href="//cdn.example.com/x">cdn</a>;',
        '// router.push("/x");',
        '/* navigate("/x") */',
        ' * redirect("/x")',
        'const href = "/x";',
        'export const data = <div data-href="/x" />;',
      ),
      "src/flask.py": '# @state Py\n\ndef go():\n    return redirect("/x")\n',
      "src/ok.ts": file(["@state Ok"], 'router.push("/x");'),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(driftPairs(graph), ["Ok->X"]);
  });
});

describe("drift: resolution", () => {
  it("prefers an exact route, then a single pattern, and records unknown or ambiguous paths as nothing", async () => {
    const root = await makeRepo({
      "src/new.ts": ts("@state New", "@state-route /users/new"),
      "src/detail.ts": ts("@state Detail", "@state-route /users/:id"),
      "src/org.ts": ts("@state Org", "@state-route /:org/settings"),
      "src/nav.ts": file(
        ["@state Nav"],
        'router.push("/users/new");',
        'router.push("/users/42");',
        'router.push("/users/settings");',
        'router.push("/acme/settings");',
        'router.push("/nowhere");',
        'router.push("/users/42/edit");',
      ),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(driftPairs(graph), ["Nav->Detail", "Nav->New", "Nav->Org"]);
  });

  it("takes the source state from the file the call is in", async () => {
    const root = await makeRepo({
      "src/home.ts": ts("@state Home", "@state-route /home"),
      "src/pages/settings-page.tsx": 'export const back = <Link href="/home">戻る</Link>;\n',
      "src/a1.ts": file(["@state A"], 'router.push("/home");'),
      "src/a2.ts": file(["@state A"], 'navigate("/home");'),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(graph.drift, [
      { kind: "observed-not-declared", from: "A", to: "Home", via: ["src/a1.ts", "src/a2.ts"] },
      {
        kind: "observed-not-declared",
        from: "settings_page",
        to: "Home",
        via: ["src/pages/settings-page.tsx"],
      },
    ]);
  });
});

describe("drift: edges", () => {
  it("marks declared flows observed, adds observed-only edges and drift, and leaves deps alone", async () => {
    const root = await makeRepo({
      "src/login.ts": file(
        [
          "@state Login",
          "@state-route /login",
          "@state-next Home on:ok",
          "@state-next Home on:retry",
          "@state-next Signup",
        ],
        'import { users } from "./db.js";',
        'router.push("/home");',
        'router.push("/reset");',
      ),
      "src/home.ts": ts("@state Home", "@state-route /home"),
      "src/signup.ts": ts("@state Signup", "@state-route /signup"),
      "src/reset.ts": file(["@state Reset", "@state-route /reset"], 'router.replace("/reset");'),
      "src/db.ts": ts("@state DB"),
    });

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(
      flows(graph).map(({ from, to, event, declared, observed, via }) => ({
        from,
        to,
        event,
        declared,
        observed,
        via,
      })),
      [
        {
          from: "Login",
          to: "Home",
          event: "ok",
          declared: true,
          observed: true,
          via: ["src/login.ts"],
        },
        {
          from: "Login",
          to: "Home",
          event: "retry",
          declared: true,
          observed: true,
          via: ["src/login.ts"],
        },
        {
          from: "Login",
          to: "Signup",
          event: null,
          declared: true,
          observed: false,
          via: ["src/login.ts"],
        },
      ],
    );
    assert.deepEqual(observedEdges(graph), [
      {
        type: "observed",
        from: "Login",
        to: "Reset",
        declared: false,
        observed: true,
        via: ["src/login.ts"],
      },
      {
        type: "observed",
        from: "Reset",
        to: "Reset",
        declared: false,
        observed: true,
        via: ["src/reset.ts"],
      },
    ]);
    assert.deepEqual(graph.drift, [
      { kind: "observed-not-declared", from: "Login", to: "Reset", via: ["src/login.ts"] },
      { kind: "observed-not-declared", from: "Reset", to: "Reset", via: ["src/reset.ts"] },
    ]);
    assert.deepEqual(deps(graph), [
      { type: "dep", from: "Login", to: "DB", via: ["src/login.ts"] },
    ]);
  });
});

describe("drift: model", () => {
  it("keeps the quick check and the TLA+ model on the declaration", async () => {
    const properties = {
      properties: [
        { id: "no-admin", kind: "never-reach", target: ["Admin"] },
        { id: "home-authed", kind: "invariant", expr: "state == Home => authed" },
        { id: "dead-end", kind: "no-dead-end", except: ["Home"] },
      ],
    };
    const login = [
      "@state Login",
      "@state-initial",
      "@state-route /login",
      "@state-var authed: BOOLEAN = FALSE",
      "@state-next Home on:ok set:authed=TRUE",
    ];
    const root = await makeRepo({
      "everypath.properties.json": JSON.stringify(properties),
      "src/login.ts": file(login, 'router.push("/home");'),
      "src/home.ts": ts("@state Home", "@state-route /home"),
      "src/admin.ts": ts("@state Admin", "@state-route /admin"),
    });
    const before = await analyze(root, { now: T1 });

    await writeFiles(root, {
      "src/login.ts": file(login, 'router.push("/home");', 'router.push("/admin");'),
    });
    const after = await analyze(root, { now: T1 });

    assert.deepEqual(driftPairs(before.graph), []);
    assert.deepEqual(driftPairs(after.graph), ["Login->Admin"]);
    assert.deepEqual(after.graph.properties, before.graph.properties);
    const noAdmin = after.graph.properties.find((result) => result.id === "no-admin");
    assert.equal(noAdmin?.result, "ok");
    const tla = (analyzed: typeof before) => {
      const generated = generateTla(analyzed.graph, analyzed.properties);
      assert.ok(generated.ok);
      return generated.model.tla;
    };
    assert.equal(tla(after), tla(before));
  });
});

describe("drift: history", () => {
  it("writes no history line when a repository with drift is scanned again unchanged", async () => {
    const root = await makeRepo({
      "src/a.ts": file(["@state A", "@state-next B"], 'router.push("/c");'),
      "src/b.ts": ts("@state B", "@state-route /b"),
      "src/c.ts": ts("@state C", "@state-route /c"),
    });

    const first = await scan(root, { now: T1 });
    await scan(root, { now: T2 });

    assert.deepEqual(driftPairs(first), ["A->C"]);
    const history = await historyOf(root);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0]?.addedEdges, [{ type: "flow", from: "A", to: "B", event: null }]);
  });
});

describe("drift: example", () => {
  it("routes the seven screens of example and ships it with no drift", async () => {
    const root = await copyOfExample();
    const before = await scan(root, { now: T1 });
    assert.deepEqual(before.warnings, []);
    assert.deepEqual(before.drift, []);
    for (const edge of flows(before)) assert.equal(edge.declared, true);

    const paths = ["/login", "/signup", "/home", "/mypage", "/logout", "/reset", "/locked"];
    await writeFiles(root, {
      "src/probe.ts": file(["@state Probe"], ...paths.map((path) => `router.push("${path}");`)),
    });
    const probed = await scan(root, { now: T2 });

    assert.deepEqual(probed.warnings, []);
    assert.deepEqual(driftPairs(probed), [
      "Probe->Home",
      "Probe->パスワードリセット",
      "Probe->マイページ",
      "Probe->ログアウト",
      "Probe->ログイン",
      "Probe->ロック",
      "Probe->新規登録",
    ]);
  });

  it("reports one drift when the copy's home screen navigates to the reset screen", async () => {
    const root = await copyOfExample();
    await appendFile(
      join(root, "src", "home.ts"),
      '\nexport const toReset = (router: { push(path: string): void }) => router.push("/reset");\n',
    );

    const graph = await scan(root, { now: T1 });

    assert.deepEqual(graph.warnings, []);
    assert.deepEqual(graph.drift, [
      {
        kind: "observed-not-declared",
        from: "Home",
        to: "パスワードリセット",
        via: ["src/home.ts"],
      },
    ]);
  });
});

describe("drift: speed", () => {
  it("scans 1,000 files with routes and navigation calls within one second", async () => {
    const size = 1000;
    const files: Record<string, string> = {};
    for (let i = 0; i < size; i += 1) {
      files[`src/n${i}.tsx`] = file(
        [`@state N${i}`, `@state-route /n/${i}`, `@state-next N${(i + 1) % size} on:next`],
        `import { shared } from "./n${(i + 1) % size}.js";`,
        ...Array.from({ length: 40 }, (_, k) => `export const v${k} = ${k} + shared;`),
        `export const go = () => router.push("/n/${(i + 1) % size}");`,
        `export const skip = <Link href="/n/${(i + 2) % size}">skip</Link>;`,
        `export const back = (id: number) => navigate(\`/n/\${id}\`);`,
      );
    }
    const root = await makeRepo(files);
    const graph = await scan(root, { now: T1 });

    // CPU time, not wall time: the other test files run in parallel and share the machine.
    const runs: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = process.cpuUsage();
      await scan(root, { now: T2 });
      const { user, system } = process.cpuUsage(started);
      runs.push((user + system) / 1000);
    }
    const best = Math.min(...runs);

    assert.equal(graph.nodes.length, size);
    assert.equal(flows(graph).filter((edge) => edge.observed).length, size);
    assert.equal(graph.drift.length, size);
    assert.ok(best < 1000, `runs took ${runs.map((ms) => ms.toFixed(0)).join(", ")} ms of CPU`);
  });
});
