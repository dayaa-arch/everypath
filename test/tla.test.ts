import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROPERTIES_FILE } from "../src/core/properties.js";
import { analyze, scan } from "../src/core/scan.js";
import { generateTla, type TlaNames } from "../src/core/tla/generate.js";
import { parseTlcOutput } from "../src/core/tla/parse.js";
import type { Graph, PropertyResult } from "../src/core/types.js";
import { makeRepo, readGraph, runCli, ts, writeFiles } from "./helpers/repo.js";
import {
  EXAMPLE_NAMES,
  exampleRepo,
  type FakeJavaScript,
  fakeJava,
  fixture,
  forExample,
} from "./helpers/tlc.js";

const EXPECTED_EXAMPLE_TLA = String.raw`---- MODULE Model ----
\* everypath が注釈から生成した。手で直さず、注釈を直して作り直す
EXTENDS Naturals

\* S1 = DB層
\* S2_Home = Home
\* S3 = パスワードリセット
\* S4 = マイページ
\* S5 = ログアウト
\* S6 = ログイン
\* S7 = ロック
\* S8 = 新規登録
States == {"S1", "S2_Home", "S3", "S4", "S5", "S6", "S7", "S8"}

\* tau = イベント無しの遷移
\* e1_back = back
\* e2_cancel = cancel
\* e3_code_invalid = code_invalid
\* e4_login_fail = login_fail
\* e5_login_ok = login_ok
\* e6_logout = logout
\* e7_open_mypage = open_mypage
\* e8_reset_done = reset_done
\* e9_signup_done = signup_done
Events == {"tau", "e1_back", "e2_cancel", "e3_code_invalid", "e4_login_fail", "e5_login_ok", "e6_logout", "e7_open_mypage", "e8_reset_done", "e9_signup_done"}

\* v1_authed = authed
\* v2_retries = retries
VARIABLES state, v1_authed, v2_retries, lastEvent
vars == <<state, v1_authed, v2_retries, lastEvent>>

TypeOK ==
  /\ state \in States
  /\ v1_authed \in BOOLEAN
  /\ v2_retries \in 0..3
  /\ lastEvent \in Events

\* 入口: ログイン
Init ==
  /\ state \in {"S6"}
  /\ v1_authed = FALSE
  /\ v2_retries = 0
  /\ lastEvent = "tau"

\* src/home.ts: @state-next マイページ on:open_mypage
A1 ==
  /\ state = "S2_Home"
  /\ state' = "S4"
  /\ lastEvent' = "e7_open_mypage"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/auth/reset.ts: @state-next Home on:reset_done
A2 ==
  /\ state = "S3"
  /\ state' = "S2_Home"
  /\ lastEvent' = "e8_reset_done"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/auth/reset.ts: @state-next パスワードリセット on:code_invalid
A3 ==
  /\ state = "S3"
  /\ state' = "S3"
  /\ lastEvent' = "e3_code_invalid"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/auth/reset.ts: @state-next ログイン on:cancel
A4 ==
  /\ state = "S3"
  /\ state' = "S6"
  /\ lastEvent' = "e2_cancel"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/mypage.ts: @state-next Home on:back
A5 ==
  /\ state = "S4"
  /\ state' = "S2_Home"
  /\ lastEvent' = "e1_back"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/mypage.ts: @state-next ログアウト on:logout set:authed=FALSE
A6 ==
  /\ state = "S4"
  /\ state' = "S5"
  /\ v1_authed' = FALSE
  /\ lastEvent' = "e6_logout"
  /\ UNCHANGED <<v2_retries>>

\* src/auth/logout.ts: @state-next ログイン
A7 ==
  /\ state = "S5"
  /\ state' = "S6"
  /\ lastEvent' = "tau"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/auth/login.ts: @state-next Home on:login_ok set:authed=TRUE, retries=0
A8 ==
  /\ state = "S6"
  /\ state' = "S2_Home"
  /\ v1_authed' = TRUE
  /\ v2_retries' = 0
  /\ lastEvent' = "e5_login_ok"

\* src/auth/login.ts: @state-next パスワードリセット
A9 ==
  /\ state = "S6"
  /\ state' = "S3"
  /\ lastEvent' = "tau"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/auth/login.ts: @state-next ログイン on:login_fail if:retries<3 set:retries=retries+1
A10 ==
  /\ state = "S6"
  /\ v2_retries < 3
  /\ state' = "S6"
  /\ v2_retries' = v2_retries + 1
  /\ lastEvent' = "e4_login_fail"
  /\ UNCHANGED <<v1_authed>>

\* src/auth/login.ts: @state-next ロック on:login_fail if:retries==3
A11 ==
  /\ state = "S6"
  /\ v2_retries = 3
  /\ state' = "S7"
  /\ lastEvent' = "e4_login_fail"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/auth/login.ts: @state-next 新規登録
A12 ==
  /\ state = "S6"
  /\ state' = "S8"
  /\ lastEvent' = "tau"
  /\ UNCHANGED <<v1_authed, v2_retries>>

\* src/auth/signup.ts: @state-next ログイン on:signup_done
A13 ==
  /\ state = "S8"
  /\ state' = "S6"
  /\ lastEvent' = "e9_signup_done"
  /\ UNCHANGED <<v1_authed, v2_retries>>

Next ==
  \/ A1
  \/ A2
  \/ A3
  \/ A4
  \/ A5
  \/ A6
  \/ A7
  \/ A8
  \/ A9
  \/ A10
  \/ A11
  \/ A12
  \/ A13

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* everypath.properties.json: no-unauth-home（未認証で Home・マイページにいない）
P1_no_unauth_home == (state \in {"S2_Home", "S4"} => v1_authed = TRUE)

\* everypath.properties.json: lock-after-3（4 回目の失敗は存在しない）
P2_lock_after_3 == v2_retries <= 3

\* everypath.properties.json: logout-eventually-login（ログアウトしたら必ずログイン画面に戻る）
P3_logout_eventually_login == state \in {"S5"} ~> state \in {"S6"}
====
`;

const EXPECTED_EXAMPLE_CFG = `SPECIFICATION Spec
INVARIANT P1_no_unauth_home
INVARIANT P2_lock_after_3
INVARIANT TypeOK
PROPERTY P3_logout_eventually_login
`;

/** The cfg of each TLC run on example/ when P1 is violated and the rest hold. */
const EXPECTED_EXAMPLE_RUNS = [
  "SPECIFICATION Spec\nINVARIANT P1_no_unauth_home\nINVARIANT P2_lock_after_3\nINVARIANT TypeOK\n",
  "SPECIFICATION Spec\nINVARIANT P2_lock_after_3\nINVARIANT TypeOK\n",
  "SPECIFICATION Spec\nCONSTRAINT TypeOK\nPROPERTY P3_logout_eventually_login\n",
];

async function generatedFrom(files: Readonly<Record<string, string>>) {
  const { graph, properties } = await analyze(await makeRepo(files));
  return generateTla(graph, properties);
}

async function modelOf(files: Readonly<Record<string, string>>) {
  const generated = await generatedFrom(files);
  assert.ok(generated.ok, generated.ok ? "" : generated.reason);
  return generated.model;
}

const propertiesFile = (properties: unknown[]) => ({
  [PROPERTIES_FILE]: JSON.stringify({ properties }),
});

const TRANSLATION = {
  "src/a.ts": ts(
    "@state A",
    "@state-initial",
    "@state-var b: BOOLEAN = FALSE",
    "@state-var n: 0..5 = 0",
    "@state-var mode: {red, green} = red",
    "@state-next B on:go if:n<2 && !b set:n=n+1, mode=green",
  ),
  "src/b.ts": ts("@state B", "@state-next A on:back set:n=n-1"),
};

/** Property text and the TLA+ it becomes. Compounds are parenthesized, atoms are bare. */
const TRANSLATED: readonly (readonly [string, string])[] = [
  ["n < 1", "v2_n < 1"],
  ["n <= 2", "v2_n <= 2"],
  ["n > 1", "v2_n > 1"],
  ["n >= 0", "v2_n >= 0"],
  ["n == 3", "v2_n = 3"],
  ["n != 4", "v2_n # 4"],
  ["b", "v1_b = TRUE"],
  ["mode == red", 'v3_mode = "m1_red"'],
  ["mode != green", 'v3_mode # "m2_green"'],
  ["state in {A, Missing}", 'state \\in {"S1_A"}'],
  ["state != B", '~(state \\in {"S2_B"})'],
  ["state == Missing", "state \\in {}"],
  ["!b", "~(v1_b = TRUE)"],
  ["!(b && n < 2)", "~(v1_b = TRUE /\\ v2_n < 2)"],
  ["b || n == 0 || mode == red", '(v1_b = TRUE \\/ v2_n = 0 \\/ v3_mode = "m1_red")'],
  ["state == A => !b", '(state \\in {"S1_A"} => ~(v1_b = TRUE))'],
];

describe("tla: generating Model.tla and Model.cfg", () => {
  it("starts from analyze, which folds the repository exactly as scan does and writes nothing", async () => {
    const root = await exampleRepo();
    const now = new Date("2026-10-21T00:00:00.000Z");

    const analyzed = await analyze(root, { now });

    assert.ok(!(await readdir(root)).includes(".everypath"));
    assert.deepEqual(analyzed.graph, await scan(root, { now }));
    assert.deepEqual(
      analyzed.properties.properties.map((p) => p.id),
      ["no-unauth-home", "lock-after-3", "logout-eventually-login", "no-dead-end"],
    );
    assert.equal(analyzed.history?.reason, "scan");
  });

  it("writes the example as ASCII identifiers with the display names in comments", async () => {
    const { graph, properties } = await analyze(await exampleRepo());
    const generated = generateTla(graph, properties);

    assert.ok(generated.ok);
    const { model } = generated;
    assert.equal(model.tla, EXPECTED_EXAMPLE_TLA);
    assert.deepEqual(model.names, EXAMPLE_NAMES);
    assert.deepEqual(model.invariants, ["P1_no_unauth_home", "P2_lock_after_3", "TypeOK"]);
    assert.deepEqual(model.temporal, ["P3_logout_eventually_login"]);
    assert.deepEqual(model.rejected, []);
    assert.equal(model.cfg([...model.invariants, ...model.temporal]), EXPECTED_EXAMPLE_CFG);
  });

  it("adds CONSTRAINT TypeOK to a cfg that does not check TypeOK", async () => {
    const { graph, properties } = await analyze(await exampleRepo());
    const generated = generateTla(graph, properties);
    assert.ok(generated.ok);
    const { cfg } = generated.model;

    assert.equal(
      cfg(["P2_lock_after_3"]),
      "SPECIFICATION Spec\nCONSTRAINT TypeOK\nINVARIANT P2_lock_after_3\n",
    );
    assert.equal(
      cfg(["TypeOK", "P1_no_unauth_home"]),
      "SPECIFICATION Spec\nINVARIANT TypeOK\nINVARIANT P1_no_unauth_home\n",
    );
  });

  it("translates every expression kind and every operator", async () => {
    const model = await modelOf({
      ...TRANSLATION,
      ...propertiesFile([
        ...TRANSLATED.map(([expr], index) => ({ id: `t${index}`, kind: "invariant", expr })),
        { id: "lt", kind: "leads-to", from: "state == A", to: "n >= 1 && !b" },
      ]),
    });

    const lines = model.tla.split("\n");
    for (const [index, [expr, tla]] of TRANSLATED.entries()) {
      const name = `P${index + 1}_t${index}`;
      assert.ok(
        lines.includes(`${name} == ${tla}`),
        `${expr} should become ${tla}; have ${lines.find((line) => line.startsWith(`${name} `))}`,
      );
    }
    const last = TRANSLATED.length + 1;
    assert.ok(
      lines.includes(`P${last}_lt == state \\in {"S1_A"} ~> (v2_n >= 1 /\\ ~(v1_b = TRUE))`),
    );
    assert.deepEqual(model.rejected, []);
  });

  it("translates guards, offsets and member assignments in the actions", async () => {
    const { tla } = await modelOf(TRANSLATION);

    for (const block of [
      `\\* src/a.ts: @state-next B on:go if:n<2 && !b set:n=n+1, mode=green
A1 ==
  /\\ state = "S1_A"
  /\\ (v2_n < 2 /\\ ~(v1_b = TRUE))
  /\\ state' = "S2_B"
  /\\ v2_n' = v2_n + 1
  /\\ v3_mode' = "m2_green"
  /\\ lastEvent' = "e2_go"
  /\\ UNCHANGED <<v1_b>>
`,
      `\\* src/b.ts: @state-next A on:back set:n=n-1
A2 ==
  /\\ state = "S2_B"
  /\\ state' = "S1_A"
  /\\ v2_n' = v2_n - 1
  /\\ lastEvent' = "e1_back"
  /\\ UNCHANGED <<v1_b, v3_mode>>
`,
    ]) {
      assert.ok(tla.includes(block), `${block}\nin\n${tla}`);
    }
    assert.ok(tla.includes('  /\\ v3_mode \\in {"m1_red", "m2_green"}'));
    assert.ok(tla.includes("Spec == Init /\\ [][Next]_vars /\\ WF_vars(Next)"));
  });

  it("gives non-ASCII variables, events and enum members ASCII identifiers and a table", async () => {
    const model = await modelOf({
      "src/in.ts": ts(
        "@state 入口",
        "@state-initial",
        "@state-var 回数: 0..2 = 0",
        "@state-var 色: {赤, 青} = 赤",
        "@state-next 次 on:進む if:回数<2 && 色==赤 set:回数=回数+1, 色=青",
      ),
      ...propertiesFile([
        { id: "回数の上限", kind: "invariant", expr: "回数 <= 2" },
        { id: "no-blue", kind: "invariant", expr: "色 != 青" },
      ]),
    });

    assert.deepEqual(model.names, {
      states: { S1: "入口", S2: "次" },
      vars: { v1: "回数", v2: "色" },
      events: { tau: null, e1: "進む" },
      members: { m1: "赤", m2: "青" },
      checks: { P1: "回数の上限", P2_no_blue: "no-blue", TypeOK: "TypeOK" },
    });
    for (const line of model.tla.split("\n")) {
      if (line.startsWith("\\*")) continue;
      assert.match(line, /^[\x20-\x7e]*$/, line);
    }
    assert.ok(model.tla.includes('P2_no_blue == v2 # "m2"'));
  });

  it("rejects a property that cannot become TLA+ and keeps the others", async () => {
    const model = await modelOf({
      ...TRANSLATION,
      ...propertiesFile([
        { id: "fine", kind: "invariant", expr: "n <= 5" },
        { id: "undeclared", kind: "invariant", expr: "nope == 1" },
        { id: "wrong-type", kind: "leads-to", from: "state == A", to: "b == 3" },
        { id: "ordering", kind: "invariant", expr: "b < 2" },
        { id: "not-a-member", kind: "invariant", expr: "mode == purple" },
        { id: "also-fine", kind: "leads-to", from: "state == A", to: "state == B" },
      ]),
    });

    assert.deepEqual(
      model.rejected.map(({ id }) => id),
      ["undeclared", "wrong-type", "ordering", "not-a-member"],
    );
    const reasons = model.rejected.map(({ reason }) => reason);
    assert.match(reasons[0] ?? "", /nope/);
    assert.match(reasons[1] ?? "", /b/);
    assert.deepEqual(model.invariants, ["P1_fine", "TypeOK"]);
    assert.deepEqual(model.temporal, ["P2_also_fine"]);
    assert.ok(!model.tla.includes("nope"));
    assert.ok(!model.tla.includes("purple"));
  });

  it("fails as a whole only when there is no entry state", async () => {
    const generated = await generatedFrom({
      "src/a.ts": ts("@state A", "@state-next B"),
      "src/b.ts": ts("@state B", "@state-next A"),
    });

    assert.ok(!generated.ok);
    assert.match(generated.reason, /入口/);
  });
});

const names = (value: unknown) => value as TlaNames;

/** The table the hand-written model behind the fixtures used: plain variable and event names. */
const FIXTURE_NAMES = names({
  states: EXAMPLE_NAMES.states,
  vars: { authed: "authed", retries: "retries" },
  events: {
    tau: null,
    login_fail: "login_fail",
    reset_done: "reset_done",
    open_mypage: "open_mypage",
    back: "back",
    cancel: "cancel",
  },
  members: {},
  checks: { NoUnauthHome: "no-unauth-home", TypeOK: "TypeOK" },
});

const vars = (authed: string, retries: string) => ({ authed, retries });

describe("tla: reading TLC output", () => {
  it("reads the violated invariant and its three-step counterexample", async () => {
    const report = parseTlcOutput(await fixture("violation"), FIXTURE_NAMES);

    assert.deepEqual(report, {
      kind: "violated",
      check: "NoUnauthHome",
      distinctStates: 25,
      trace: {
        path: ["ログイン", "パスワードリセット", "Home"],
        loopStart: null,
        steps: [
          { state: "ログイン", event: null, vars: vars("FALSE", "0") },
          { state: "パスワードリセット", event: null, vars: vars("FALSE", "0") },
          { state: "Home", event: "reset_done", vars: vars("FALSE", "0") },
        ],
      },
    });
  });

  it("reads an invariant that the initial state violates, which TLC prints without a State header", async () => {
    const report = parseTlcOutput(
      await fixture("initial"),
      names({
        states: EXAMPLE_NAMES.states,
        vars: { v1_authed: "authed", v2_retries: "retries" },
        events: { tau: null },
        members: {},
        checks: { P4_never_login: "never-login", TypeOK: "TypeOK" },
      }),
    );

    assert.deepEqual(report, {
      kind: "violated",
      check: "P4_never_login",
      distinctStates: null,
      trace: {
        path: ["ログイン"],
        loopStart: null,
        steps: [{ state: "ログイン", event: null, vars: vars("FALSE", "0") }],
      },
    });
  });

  it("reads a clean run with its state count", async () => {
    assert.deepEqual(parseTlcOutput(await fixture("ok"), FIXTURE_NAMES), {
      kind: "ok",
      distinctStates: 47,
    });
  });

  it("reads a temporal violation whose behavior goes back to an earlier state", async () => {
    const report = parseTlcOutput(await fixture("liveness"), FIXTURE_NAMES);

    assert.equal(report.kind, "violated");
    assert.ok(report.kind === "violated");
    assert.equal(report.check, null);
    assert.equal(report.distinctStates, 47);
    assert.equal(report.trace.steps.length, 7);
    assert.equal(report.trace.loopStart, 5);
    assert.deepEqual(
      report.trace.steps.map(({ state, event }) => [state, event]),
      [
        ["ログイン", null],
        ["ログイン", "login_fail"],
        ["ログイン", "login_fail"],
        ["パスワードリセット", null],
        ["Home", "reset_done"],
        ["マイページ", "open_mypage"],
        ["Home", "back"],
      ],
    );
    assert.deepEqual(report.trace.steps[2]?.vars, vars("FALSE", "2"));
  });

  it("reads a behavior that stops moving as a loop on its last step", async () => {
    const report = parseTlcOutput(await fixture("stuttering"), FIXTURE_NAMES);

    assert.ok(report.kind === "violated");
    assert.equal(report.check, null);
    assert.equal(report.trace.steps.length, 7);
    assert.equal(report.trace.loopStart, 6);
    assert.equal(report.trace.steps.at(-1)?.state, "ロック");
    assert.deepEqual(report.trace.steps.at(-1)?.vars, vars("FALSE", "3"));
  });

  it("reads a parse failure as an error", async () => {
    const report = parseTlcOutput(await fixture("parse-error"), FIXTURE_NAMES);

    assert.ok(report.kind === "error");
    assert.match(report.message, /Parsing or semantic analysis failed/);
    assert.equal(report.distinctStates, null);
  });

  it("reads the last state count of a run that was killed before it finished", () => {
    const killed = [
      "Finished computing initial states: 1 distinct state generated at 2026-10-21 23:01:24.",
      "Progress(3) at 2026-10-21 23:01:25: 1,234 states generated, 1,200 distinct states found, 9 states left on queue.",
      "Progress(4) at 2026-10-21 23:01:26: 2,468 states generated, 2,400 distinct states found, 9 states left on queue.",
    ].join("\n");

    const parsed = parseTlcOutput(killed, FIXTURE_NAMES);

    assert.ok(parsed.kind === "error");
    assert.equal(parsed.distinctStates, 2400);
  });

  it("reads a Java failure as an error that carries the first line TLC printed", () => {
    const output = 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space\n';

    const parsed = parseTlcOutput(output, FIXTURE_NAMES);

    assert.ok(parsed.kind === "error");
    assert.match(parsed.message, /OutOfMemoryError/);
  });

  it("turns anything it cannot map back into an error, never an exception", async () => {
    const violation = await fixture("violation");
    const inputs = [
      "",
      "\n\n",
      "garbage",
      "Error: Invariant NoSuchCheck is violated.\nState 1: <Initial predicate>\n",
      "Error: Invariant constructor is violated.\n",
      violation.replace("NoUnauthHome", "TypeOK").replace('state = "S6"', 'state = "zzz"'),
      violation.replace('state = "S3"', 'state = "constructor"'),
      violation.replace('lastEvent = "reset_done"', 'lastEvent = "__proto__"'),
      violation.replace(/^\/\\ authed = FALSE$/m, "/\\ authed = {1, 2}"),
      violation.replace(/^\/\\ state = .*$/gm, ""),
      (await fixture("liveness")).replace("Back to state 6", "Back to state 99"),
      (await fixture("liveness")).replace("Back to state 6", "Back to state 0"),
      (await fixture("liveness")).replace(/Back to state 6.*\n/, ""),
    ];

    for (const input of inputs) {
      assert.equal(parseTlcOutput(input, FIXTURE_NAMES).kind, "error", input);
    }
  });

  it("survives output cut off at every line", async () => {
    for (const name of ["violation", "ok", "liveness", "stuttering", "parse-error"] as const) {
      const lines = (await fixture(name)).split("\n");
      for (let end = 0; end <= lines.length; end++) {
        const parsed = parseTlcOutput(lines.slice(0, end).join("\n"), FIXTURE_NAMES);
        assert.ok(["ok", "violated", "error"].includes(parsed.kind), `${name} to line ${end}`);
      }
    }
  });
});

const exampleRun = async (): Promise<FakeJavaScript> => ({
  rules: [
    {
      when: "INVARIANT P1_no_unauth_home",
      reply: { output: forExample(await fixture("violation")), exit: 12 },
    },
  ],
  otherwise: { output: await fixture("ok") },
});

async function checkExample(script: FakeJavaScript, args: readonly string[] = []) {
  const root = await exampleRepo();
  const java = await fakeJava(script);
  const result = runCli(["check", "--tlc", ...args, root], root, java.env);
  return { root, java, result };
}

async function addProperty(root: string, definition: unknown): Promise<void> {
  const path = join(root, PROPERTIES_FILE);
  const file = JSON.parse(await readFile(path, "utf8"));
  file.properties.push(definition);
  await writeFile(path, JSON.stringify(file));
}

const readResult = async (root: string) =>
  JSON.parse(await readFile(join(root, ".everypath", "tla", "result.json"), "utf8"));

const resultOf = (graph: Graph, id: string): PropertyResult => {
  const found = graph.properties.find((p) => p.id === id);
  assert.ok(found, `property ${id} in ${graph.properties.map((p) => p.id)}`);
  return found;
};

describe("tla: running TLC and merging its verdicts", () => {
  it("reruns without the violated invariant, then runs each temporal property alone", async () => {
    const { root, java, result } = await checkExample(await exampleRun());

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(await java.cfgs(), EXPECTED_EXAMPLE_RUNS);
    const first = (await java.calls())[0] ?? "";
    assert.ok(first.split(" ")[0]?.endsWith(join(".everypath", "tla")), first);
    assert.ok(
      first.includes(
        `-XX:+UseParallelGC -jar ${java.jar} -workers auto -deadlock -config Model.cfg -metadir `,
      ),
      first,
    );
    assert.ok(first.endsWith(" Model.tla"), first);
    const directory = join(root, ".everypath", "tla");
    assert.equal(await readFile(join(directory, "Model.cfg"), "utf8"), EXPECTED_EXAMPLE_CFG);
    assert.equal(await readFile(join(directory, "Model.tla"), "utf8"), EXPECTED_EXAMPLE_TLA);
  });

  it("replaces the pending results in graph.json and marks the counterexample's states", async () => {
    const { root } = await checkExample(await exampleRun());

    const graph = await readGraph(root);
    const violated = resultOf(graph, "no-unauth-home");
    assert.equal(violated.checkedBy, "tlc");
    assert.equal(violated.result, "violated");
    assert.equal(violated.statesExplored, 25);
    assert.deepEqual(
      violated.counterexamples.map((c) => [...c.path]),
      [["ログイン", "パスワードリセット", "Home"]],
    );
    assert.equal(violated.counterexamples[0]?.loopStart, null);
    assert.deepEqual(violated.counterexamples[0]?.steps[2], {
      state: "Home",
      event: "reset_done",
      vars: { authed: "FALSE", retries: "0" },
    });
    for (const id of ["lock-after-3", "logout-eventually-login"]) {
      const held = resultOf(graph, id);
      assert.deepEqual(
        [held.checkedBy, held.result, held.statesExplored, held.counterexamples],
        ["tlc", "ok", 47, []],
        id,
      );
    }
    assert.equal(resultOf(graph, "no-dead-end").checkedBy, "bfs");
    const marked = graph.nodes.filter((n) => n.violations.length > 0).map((n) => n.id);
    assert.deepEqual(marked.sort(), ["Home", "パスワードリセット", "ログイン"]);
  });

  it("writes result.json with the name table and the verdicts TLC decided", async () => {
    const { root } = await checkExample(await exampleRun());

    const stored = await readResult(root);
    const graph = await readGraph(root);
    assert.equal(stored.version, 1);
    assert.equal(stored.checkedAt, resultOf(graph, "no-unauth-home").checkedAt);
    assert.deepEqual(stored.names, EXAMPLE_NAMES);
    assert.deepEqual(
      stored.properties,
      graph.properties.filter((p) => p.checkedBy === "tlc"),
    );
    assert.equal(stored.typeOk, null);
    assert.equal(stored.error, null);
  });

  it("runs each leads-to by itself, so one that fails does not decide another", async () => {
    const root = await exampleRepo();
    await writeFiles(root, {
      [PROPERTIES_FILE]: JSON.stringify({
        entry: ["ログイン"],
        properties: [
          { id: "first", kind: "leads-to", from: "state == ログアウト", to: "state == ログイン" },
          { id: "second", kind: "leads-to", from: "state == Home", to: "state == ログアウト" },
        ],
      }),
    });
    const java = await fakeJava({
      rules: [
        {
          when: "PROPERTY P2_second",
          reply: { output: forExample(await fixture("liveness")), exit: 13 },
        },
      ],
      otherwise: { output: await fixture("ok") },
    });

    const result = runCli(["check", "--tlc", root], root, java.env);

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(await java.cfgs(), [
      "SPECIFICATION Spec\nINVARIANT TypeOK\n",
      "SPECIFICATION Spec\nCONSTRAINT TypeOK\nPROPERTY P1_first\n",
      "SPECIFICATION Spec\nCONSTRAINT TypeOK\nPROPERTY P2_second\n",
    ]);
    const graph = await readGraph(root);
    assert.equal(resultOf(graph, "first").result, "ok");
    assert.equal(resultOf(graph, "second").result, "violated");
  });

  it("keeps a temporal violation as a loop and marks every state on it", async () => {
    const { root, java } = await checkExample({
      rules: [
        {
          when: "PROPERTY P3_logout_eventually_login",
          reply: { output: forExample(await fixture("liveness")), exit: 13 },
        },
      ],
      otherwise: { output: await fixture("ok") },
    });

    assert.equal((await java.cfgs()).length, 2);
    const graph = await readGraph(root);
    const lasso = resultOf(graph, "logout-eventually-login");
    assert.equal(lasso.result, "violated");
    assert.equal(lasso.counterexamples[0]?.loopStart, 5);
    const marked = graph.nodes.filter((n) => n.violations.length > 0).map((n) => n.id);
    assert.deepEqual(marked.sort(), ["Home", "パスワードリセット", "マイページ", "ログイン"]);
  });

  it("reports a TypeOK violation apart from the properties and keeps checking inside the ranges", async () => {
    const { root, java, result } = await checkExample({
      rules: [
        {
          when: "INVARIANT TypeOK",
          reply: { output: forExample(await fixture("violation"), "TypeOK"), exit: 12 },
        },
      ],
      otherwise: { output: await fixture("ok") },
    });

    assert.equal(result.status, 1);
    const cfgs = await java.cfgs();
    assert.equal(cfgs.length, 3);
    const second = cfgs[1] ?? "";
    assert.ok(second.includes("CONSTRAINT TypeOK"), second);
    assert.ok(!second.includes("INVARIANT TypeOK"), second);
    const stored = await readResult(root);
    assert.equal(stored.typeOk.steps.length, 3);
    assert.ok(
      (await readGraph(root)).properties.every(
        (p) => p.kind === "no-dead-end" || p.result === "ok",
      ),
    );
  });

  it("settles variable-free invariants as both and turns a rejected property into an error", async () => {
    const root = await exampleRepo();
    await writeFiles(root, {
      [PROPERTIES_FILE]: JSON.stringify({
        entry: ["ログイン"],
        properties: [
          {
            id: "no-unauth-home",
            kind: "invariant",
            expr: "state in {Home, マイページ} => authed",
          },
          { id: "no-db", kind: "invariant", expr: "state != DB層" },
          { id: "typo", kind: "invariant", expr: "retriez <= 3" },
          {
            id: "logout-eventually-login",
            kind: "leads-to",
            from: "state == ログアウト",
            to: "state == ログイン",
          },
        ],
      }),
    });
    const java = await fakeJava(await exampleRun());

    const result = runCli(["check", "--tlc", root], root, java.env);

    assert.equal(result.status, 1, result.stderr);
    const graph = await readGraph(root);
    const noDb = resultOf(graph, "no-db");
    assert.deepEqual([noDb.checkedBy, noDb.result, noDb.statesExplored], ["both", "ok", 47]);
    const typo = resultOf(graph, "typo");
    assert.deepEqual([typo.checkedBy, typo.result, typo.statesExplored], ["tlc", "error", null]);
    const warnings = graph.warnings.filter((w) => w.file === PROPERTIES_FILE);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]?.message ?? "", /typo/);
    assert.match(warnings[0]?.message ?? "", /retriez/);
    assert.equal(resultOf(graph, "no-unauth-home").result, "violated");
    const stored = await readResult(root);
    assert.ok(!Object.values(stored.names.checks).includes("typo"));
  });

  it("makes the properties still open errors, without running them, when the time budget runs out", async () => {
    const progress =
      "Progress(9) at 2026-10-21 23:01:25: 113 states generated, 47 distinct states found, 0 states left on queue.\n";
    const root = await exampleRepo();
    await addProperty(root, {
      id: "after-timeout",
      kind: "leads-to",
      from: "state == Home",
      to: "state == ログアウト",
    });
    const java = await fakeJava({
      rules: [
        {
          when: "INVARIANT P1_no_unauth_home",
          reply: { output: forExample(await fixture("violation")), exit: 12 },
        },
        { when: "PROPERTY P3_logout_eventually_login", reply: { output: progress, hang: true } },
      ],
      otherwise: { output: await fixture("ok") },
    });
    const started = Date.now();

    const result = runCli(["check", "--tlc", "--timeout", "2", root], root, java.env);

    assert.ok(Date.now() - started < 30_000, "the sleeping java was not waited for");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /タイムアウト/);
    assert.equal((await java.cfgs()).length, 3);
    const graph = await readGraph(root);
    for (const id of ["logout-eventually-login", "after-timeout"]) {
      const open = resultOf(graph, id);
      assert.deepEqual(
        [open.result, open.statesExplored, open.counterexamples],
        ["error", 47, []],
        id,
      );
    }
    assert.equal(resultOf(graph, "no-unauth-home").result, "violated");
    assert.equal(resultOf(graph, "lock-after-3").result, "ok");
  });

  it("turns every TLC property into an error when TLC rejects the model", async () => {
    const { root, result } = await checkExample({
      rules: [],
      otherwise: { output: await fixture("parse-error"), exit: 150 },
    });

    assert.equal(result.status, 1);
    const graph = await readGraph(root);
    for (const id of ["no-unauth-home", "lock-after-3", "logout-eventually-login"]) {
      assert.equal(resultOf(graph, id).result, "error", id);
    }
    assert.match(result.stdout, /Parsing or semantic analysis failed/);
  });
});
