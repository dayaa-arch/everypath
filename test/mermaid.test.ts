import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { toMermaid } from "../src/core/mermaid.js";
import { analyze } from "../src/core/scan.js";
import type { Graph } from "../src/core/types.js";
import { TONES } from "../src/ui/view.js";
import { flows, makeRepo, runCli, runCliAsync, ts } from "./helpers/repo.js";
import { ready, serveEnv, serveRepo } from "./helpers/server.js";
import { exampleRepo } from "./helpers/tlc.js";

const ID = "s[1-9]\\d*";
const DECLARATION = new RegExp(`^ {4}(${ID}) : (.+)$`);
const INITIAL = new RegExp(`^ {4}\\[\\*\\] --> (${ID})$`);
const TRANSITION = new RegExp(`^ {4}(${ID}) --> (${ID})(?: : (.+))?$`);
const CLASS_DEF = /^ {4}classDef (\w+) (\S.*)$/;
const CLASS = new RegExp(`^ {4}class (${ID}(?:,${ID})*) (\\w+)$`);

type Transition = { readonly from: string; readonly to: string; readonly label: string | null };

/** What a Mermaid reader gets from the output: states by id, the start, arrows, and marks by id. */
type Diagram = {
  readonly states: ReadonlyMap<string, string>;
  readonly initial: string | null;
  readonly transitions: readonly Transition[];
  readonly classDefs: ReadonlyMap<string, string>;
  readonly marks: ReadonlyMap<string, string>;
};

/**
 * Reads the output by the six line shapes `stateDiagram-v2` has to accept, and fails on any other
 * line, on an id used before it is declared, and on a second declaration of one id.
 */
function readDiagram(text: string): Diagram {
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "ends with exactly one newline");
  const [header, ...body] = text.slice(0, -1).split("\n");
  assert.equal(header, "stateDiagram-v2");
  const states = new Map<string, string>();
  const classDefs = new Map<string, string>();
  const marks = new Map<string, string>();
  const transitions: Transition[] = [];
  let initial: string | null = null;
  const declared = (id: string | undefined): string => {
    assert.ok(id !== undefined && states.has(id), `${id} is declared before it is used`);
    return id;
  };

  for (const line of body) {
    const declaration = DECLARATION.exec(line);
    const start = INITIAL.exec(line);
    const transition = TRANSITION.exec(line);
    const classDef = CLASS_DEF.exec(line);
    const mark = CLASS.exec(line);
    if (declaration?.[1] !== undefined && declaration[2] !== undefined) {
      assert.ok(!states.has(declaration[1]), `${declaration[1]} is declared once`);
      states.set(declaration[1], declaration[2]);
    } else if (start !== null) {
      assert.equal(initial, null, "one start arrow");
      initial = declared(start[1]);
    } else if (transition !== null) {
      transitions.push({
        from: declared(transition[1]),
        to: declared(transition[2]),
        label: transition[3] ?? null,
      });
    } else if (classDef?.[1] !== undefined && classDef[2] !== undefined) {
      classDefs.set(classDef[1], classDef[2]);
    } else if (mark?.[1] !== undefined && mark[2] !== undefined) {
      for (const id of mark[1].split(",")) {
        assert.ok(!marks.has(declared(id)), `${id} has one mark`);
        marks.set(id, mark[2]);
      }
    } else {
      assert.fail(`not a line of the grammar: ${JSON.stringify(line)}`);
    }
  }
  for (const name of marks.values()) assert.ok(classDefs.has(name), `${name} has a classDef`);
  return { states, initial, transitions, classDefs, marks };
}

const nameOf = (diagram: Diagram, id: string): string => diagram.states.get(id) ?? `?${id}`;

const idOf = (diagram: Diagram, name: string): string => {
  const found = [...diagram.states].find(([, display]) => display === name);
  assert.ok(found !== undefined, `${name} is declared`);
  return found[0];
};

/** Display name to the mark it carries; a state with none is absent. */
const markedNames = (diagram: Diagram): Record<string, string> =>
  Object.fromEntries([...diagram.marks].map(([id, mark]) => [nameOf(diagram, id), mark]));

const graphOf = async (files: Record<string, string>): Promise<Graph> =>
  (await analyze(await makeRepo(files))).graph;

const textOf = async (files: Record<string, string>): Promise<string> =>
  toMermaid(await graphOf(files));

const small = {
  "src/login.ts": ts(
    "@state ログイン",
    "@state-initial",
    "@state-var retries: 0..3 = 0",
    "@state-next Home on:login_ok",
    "@state-next ログイン on:login_fail if:retries<3 set:retries=retries+1",
    "@state-next 計画中",
  ),
  "src/home.ts": ts("@state Home", "@state-next ログイン"),
};

/** Written from the requirement, not from a run: ids by name order, then start, arrows, marks. */
const SMALL_DIAGRAM = [
  "stateDiagram-v2",
  "    classDef violated fill:#f8cecc,stroke:#c62828,stroke-width:3px,color:#222222",
  "    classDef planned fill:#ffffff,stroke:#8c8c8c,stroke-width:1.5px,stroke-dasharray:6 4,color:#8c8c8c",
  "    s1 : Home",
  "    s2 : ログイン",
  "    s3 : 計画中",
  "    [*] --> s2",
  "    s1 --> s2",
  "    s2 --> s1 : login_ok",
  "    s2 --> s2 : login_fail [retries<3]",
  "    s2 --> s3",
  "    class s3 planned",
  "",
].join("\n");

describe("toMermaid: the shape of the diagram", () => {
  it("writes the header, marks, states, start, arrows and class lines in that order", async () => {
    assert.equal(await textOf(small), SMALL_DIAGRAM);
  });

  it("declares every state once under an ASCII id, in node order", async () => {
    const graph = await graphOf(small);
    const diagram = readDiagram(toMermaid(graph));

    assert.deepEqual(
      [...diagram.states],
      graph.nodes.map((node, index) => [`s${index + 1}`, node.id]),
    );
  });

  it("keeps every non-ASCII character on a declaration line, even for names Mermaid reserves", async () => {
    const text = await textOf({
      "src/k.ts": ts(
        "@state 開始",
        "@state-initial",
        ...["end", "note", "class", "click", "direction", "style"].map(
          (name) => `@state-next ${name}`,
        ),
      ),
    });

    const diagram = readDiagram(text);
    for (const name of ["end", "note", "class", "click", "direction", "style"]) {
      assert.ok(diagram.states.has(idOf(diagram, name)), name);
    }
    const nonAscii = text.split("\n").filter((line) => /\P{ASCII}/u.test(line));
    assert.deepEqual(nonAscii, ["    s7 : 開始"]);
  });

  it("draws flow edges only", async () => {
    const files = {
      "src/home.ts": [ts("@state Home", "@state-next ログイン"), 'import "./db";', ""].join("\n"),
      "src/db.ts": ts("@state DB層"),
      "src/login.ts": ts("@state ログイン"),
    };
    const graph = await graphOf(files);
    assert.ok(
      graph.edges.some((edge) => edge.type === "dep"),
      "the repo has a dep edge",
    );

    const diagram = readDiagram(toMermaid(graph));

    assert.equal(diagram.transitions.length, 1);
    assert.deepEqual(
      diagram.transitions.map((t) => [nameOf(diagram, t.from), nameOf(diagram, t.to)]),
      [["Home", "ログイン"]],
    );
  });

  it("starts at the initial state, and has no start arrow without one", async () => {
    const withStart = readDiagram(await textOf(small));
    assert.equal(
      withStart.initial === null ? null : nameOf(withStart, withStart.initial),
      "ログイン",
    );

    const without = readDiagram(
      await textOf({ "src/a.ts": ts("@state A", "@state-next B"), "src/b.ts": ts("@state B") }),
    );
    assert.equal(without.initial, null);
    assert.equal(without.transitions.length, 1);
  });
});

/** Every operator of SPEC 5.1, nested the ways the printer has to bracket. */
const guards = {
  "src/g.ts": ts(
    "@state G",
    "@state-initial",
    "@state-var a: BOOLEAN = FALSE",
    "@state-var b: BOOLEAN = FALSE",
    "@state-var n: 0..5 = 0",
    "@state-var mode: {idle,busy,done} = idle",
    "@state-next G on:e1 if:a",
    "@state-next G on:e2 if:!a",
    "@state-next G on:e3 if:a==TRUE",
    "@state-next G on:e4 if:a==FALSE",
    "@state-next G on:e5 if:n<3",
    "@state-next G on:e6 if:n<=3 && n>=1",
    "@state-next G on:e7 if:n>0 || n!=2",
    "@state-next G on:e8 if:(a || b) && !(n==2)",
    "@state-next G on:e9 if:mode==busy",
    "@state-next G on:e10 if:mode!=done && !b",
    "@state-next G on:e11 if:!(!a)",
    "@state-next G on:e12 set:n=n+1",
    "@state-next H if:a",
    "@state-next H",
  ),
};

describe("toMermaid: edge labels", () => {
  it("prints the event, then [guard] with SPEC 5.1's operators and the fewest brackets", async () => {
    const graph = await graphOf(guards);
    assert.deepEqual(graph.warnings, []);
    const diagram = readDiagram(toMermaid(graph));

    const drawn = diagram.transitions.map((t) => [
      nameOf(diagram, t.from),
      nameOf(diagram, t.to),
      t.label,
    ]);
    const loop = (label: string) => ["G", "G", label];
    const expected = [
      loop("e1 [a]"),
      loop("e2 [!a]"),
      loop("e3 [a]"),
      loop("e4 [a==FALSE]"),
      loop("e5 [n<3]"),
      loop("e6 [n<=3 && n>=1]"),
      loop("e7 [n>0 || n!=2]"),
      loop("e8 [(a || b) && !(n==2)]"),
      loop("e9 [mode==busy]"),
      loop("e10 [mode!=done && !b]"),
      loop("e11 [!!a]"),
      loop("e12"),
      ["G", "H", "[a]"],
      ["G", "H", null],
    ];
    const order = (rows: readonly unknown[][]) => rows.map((row) => JSON.stringify(row)).sort();
    assert.equal(drawn.length, flows(graph).length);
    assert.deepEqual(order(drawn), order(expected));
  });

  it("leaves out the colon for an arrow with no event and no guard", async () => {
    const diagram = readDiagram(await textOf(guards));

    const bare = diagram.transitions.filter((t) => t.label === null);
    assert.deepEqual(
      bare.map((t) => nameOf(diagram, t.to)),
      ["H"],
    );
  });
});

/** ログイン is the start; Home, which no file claims, is where the property says nobody may go. */
const violating = {
  "src/login.ts": ts(
    "@state ログイン",
    "@state-initial",
    "@state-next パスワードリセット on:forgot",
    "@state-next 脇道 on:other",
    "@state-next 計画中 on:later",
  ),
  "src/reset.ts": ts("@state パスワードリセット", "@state-next Home on:reset_done"),
  "src/side.ts": ts("@state 脇道"),
  "everypath.properties.json": JSON.stringify({
    properties: [{ id: "no-home", kind: "never-reach", target: ["Home"] }],
  }),
};

describe("toMermaid: marks", () => {
  it("marks the states on a live violation, and a planned state that is on none", async () => {
    const diagram = readDiagram(await textOf(violating));

    assert.deepEqual(markedNames(diagram), {
      ログイン: "violated",
      パスワードリセット: "violated",
      Home: "violated",
      計画中: "planned",
    });
  });

  it("gives a planned state on a violation one mark, violated, as SPEC 7.2 orders them", async () => {
    const graph = await graphOf(violating);
    const home = graph.nodes.find((node) => node.id === "Home");
    assert.equal(home?.status.planned, true, "Home has no file");

    const diagram = readDiagram(toMermaid(graph));

    assert.equal(diagram.marks.get(idOf(diagram, "Home")), "violated");
  });

  it("does not mark a state for a verdict about a model that has since changed", async () => {
    const graph = await graphOf(violating);
    const stale: Graph = {
      ...graph,
      properties: graph.properties.map((property) => ({ ...property, staleModel: true })),
    };

    const diagram = readDiagram(toMermaid(stale));

    assert.deepEqual(markedNames(diagram), { Home: "planned", 計画中: "planned" });
  });

  it("does not mark a state while no property is violated", async () => {
    const graph = await graphOf(violating);
    const holding: Graph = {
      ...graph,
      properties: graph.properties.map((property) => ({ ...property, result: "ok" as const })),
    };

    assert.deepEqual(markedNames(readDiagram(toMermaid(holding))), {
      Home: "planned",
      計画中: "planned",
    });
  });

  it("paints violated and planned with the viewer's danger and planned colors", async () => {
    const { classDefs } = readDiagram(await textOf(violating));

    for (const [mark, tone] of [
      ["violated", "danger"],
      ["planned", "planned"],
    ] as const) {
      const row = TONES.find((candidate) => candidate.tone === tone);
      assert.ok(row !== undefined, tone);
      const style = classDefs.get(mark) ?? "";
      const parts = [`fill:${row.fill}`, `stroke:${row.stroke}`, `color:${row.text}`];
      parts.push(`stroke-width:${row.width}px`);
      if (row.dash !== null) parts.push(`stroke-dasharray:${row.dash}`);
      for (const part of parts) assert.ok(style.split(",").includes(part), `${mark} has ${part}`);
    }
  });
});

describe("toMermaid: the same code gives the same text", () => {
  it("ignores the clock of the scan", async () => {
    const root = await makeRepo(small);

    const first = toMermaid((await analyze(root, { now: new Date("2026-01-01T00:00:00Z") })).graph);
    const later = toMermaid((await analyze(root, { now: new Date("2027-06-30T12:34:56Z") })).graph);

    assert.equal(first, later);
    assert.equal(readDiagram(first).states.size, 3);
  });

  it("is the same for the same sources in another directory, and names neither it nor a time", async () => {
    const firstRoot = await makeRepo(small);
    const secondRoot = await makeRepo(small);

    const first = toMermaid((await analyze(firstRoot)).graph);
    const second = toMermaid((await analyze(secondRoot)).graph);

    assert.equal(first, second);
    assert.equal(readDiagram(first).states.size, 3);
    assert.ok(!first.includes(firstRoot) && !second.includes(secondRoot));
    assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T/);
  });
});

/** sha1 of every file under `root`, `.everypath/` included. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const hash = createHash("sha1")
      .update(await readFile(path))
      .digest("hex");
    hashes.set(relative(root, path), hash);
  }
  return hashes;
}

describe("everypath export --mermaid", () => {
  it("prints the diagram and nothing else to stdout, and exits 0 with nothing on stderr", async () => {
    const root = await makeRepo(small);

    const result = runCli(["export", root, "--mermaid"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, SMALL_DIAGRAM);
    assert.equal(result.stderr, "");
  });

  it("exports the current directory by default", async () => {
    const root = await makeRepo(small);

    const result = runCli(["export", "--mermaid"], root);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, SMALL_DIAGRAM);
  });

  it("reads example/ into a diagram of its 8 states with the start at ログイン", async () => {
    const result = runCli(["export", await exampleRepo(), "--mermaid"]);

    assert.equal(result.status, 0, result.stderr);
    const diagram = readDiagram(result.stdout);
    assert.equal([...diagram.states.values()].length, 8);
    assert.equal(diagram.initial === null ? null : nameOf(diagram, diagram.initial), "ログイン");
    assert.ok(diagram.transitions.length > 8);
  });

  it("puts the scan's warnings on stderr and still prints the diagram", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-initial", "@state-next B on:go if:isValid(x)"),
      "src/b.ts": ts("@state B"),
    });

    const result = runCli(["export", root, "--mermaid"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /警告 src\/a\.ts:\d+:/);
    assert.doesNotMatch(result.stdout, /警告/);
    assert.deepEqual(
      readDiagram(result.stdout).transitions.map((t) => t.label),
      ["go"],
    );
  });

  it("says there is nothing to draw, prints nothing and exits 1 when no state is declared", async () => {
    const root = await makeRepo({ "README.md": "no annotations here\n" });

    const result = runCli(["export", root, "--mermaid"]);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /状態がありません/);
  });

  const badUsage: readonly (readonly [string[], RegExp])[] = [
    [["export"], /--mermaid/],
    [["export", "."], /--mermaid/],
    [["export", ".", "--mermaid", "--json"], /export は --json/],
    [["export", "a", "b", "--mermaid"], /export a b/],
  ];
  for (const [args, message] of badUsage) {
    it(`exits 2 for ${args.join(" ")}`, () => {
      const result = runCli(args);

      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, message);
    });
  }

  it("exits 2 for a directory that is not there", async () => {
    const root = await makeRepo(small);

    const result = runCli(["export", join(root, "missing"), "--mermaid"]);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ディレクトリが見つかりません/);
  });

  it("is listed in --help", () => {
    const result = runCli(["--help"]);

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("everypath export [dir] --mermaid"), result.stdout);
  });
});

describe("R-01: export --mermaid writes nothing", () => {
  it("does not create .everypath/ in a repository that has none", async () => {
    const root = await makeRepo(small);
    const before = await readdir(root);

    const result = runCli(["export", root, "--mermaid"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(root), before);
  });

  it("leaves every byte of an existing .everypath/ and of the sources as they were", async () => {
    const root = await makeRepo(small);
    assert.equal(runCli(["scan", "--quiet", root]).status, 0);
    const before = await snapshot(root);
    assert.ok([...before.keys()].some((path) => path.startsWith(".everypath")));

    const result = runCli(["export", root, "--mermaid"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await snapshot(root), before);
  });

  it("leaves what a running serve wrote as it was, and does not hand a scan to it", async () => {
    const root = await makeRepo(small);
    const env = await serveEnv();
    const serve = await serveRepo(root, env);
    await ready(serve);
    const before = await snapshot(root);

    const result = await runCliAsync(["export", root, "--mermaid"], root, env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, SMALL_DIAGRAM);
    assert.deepEqual(await snapshot(root), before);
  });
});
