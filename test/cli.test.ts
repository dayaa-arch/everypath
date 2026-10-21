import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeRepo, readGraph, runCli, runCliAsync, ts, writeFiles } from "./helpers/repo.js";
import { exampleRepo, type FakeJavaScript, fakeJava, fixture, forExample } from "./helpers/tlc.js";

const files = {
  "src/a.ts": ts("@state A", "@state-next B if:isValid(x)"),
  "src/b.ts": ts("@state B"),
};

describe("everypath scan", () => {
  it("exits 0 with warnings and writes graph.json", async () => {
    const root = await makeRepo(files);
    const result = runCli(["scan", root]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readGraph(root)).warnings.length, 1);
  });

  it("prints graph.json to stdout under --json", async () => {
    const root = await makeRepo(files);
    const result = runCli(["scan", root, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), await readGraph(root));
  });

  it("prints nothing under --quiet", async () => {
    const root = await makeRepo(files);
    const result = runCli(["scan", "--quiet", root]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("scans the current directory by default", async () => {
    const root = await makeRepo(files);
    const result = runCli(["scan", "--quiet"], root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readGraph(root)).nodes.length, 2);
  });

  it("exits 2 for a missing directory or an unknown command", async () => {
    const root = await makeRepo(files);
    assert.equal(runCli(["scan", join(root, "missing")]).status, 2);
    assert.equal(runCli(["bogus"]).status, 2);
  });
});

const login = {
  "src/login.ts": ts(
    "@state ログイン",
    "@state-initial",
    "@state-next パスワードリセット on:forgot",
  ),
  "src/reset.ts": ts("@state パスワードリセット", "@state-next Home on:reset_done"),
  "src/home.ts": ts("@state Home", "@state-next ログイン"),
};

const withProperties = (properties: unknown[]) => ({
  ...login,
  "everypath.properties.json": JSON.stringify({ properties }),
});

describe("everypath check", () => {
  it("exits 1 and prints the counterexample path for a never-reach violation", async () => {
    const root = await makeRepo(
      withProperties([
        { id: "no-reset-home", kind: "never-reach", description: "d", target: ["Home"] },
      ]),
    );
    const result = runCli(["check", root]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /no-reset-home/);
    assert.ok(
      result.stdout.includes("ログイン →(forgot) パスワードリセット →(reset_done) Home"),
      result.stdout,
    );
    const graph = await readGraph(root);
    assert.equal(graph.properties[0]?.result, "violated");
  });

  it("prints an event-less edge as a bare arrow", async () => {
    const root = await makeRepo({
      ...login,
      "everypath.properties.json": JSON.stringify({
        entry: ["Home"],
        properties: [{ id: "loop", kind: "invariant", expr: "state != ログイン" }],
      }),
    });
    const result = runCli(["check", root]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes("Home → ログイン"), result.stdout);
  });

  it("exits 0 when every property holds or waits for TLC", async () => {
    const root = await makeRepo(
      withProperties([
        { id: "nd", kind: "no-dead-end" },
        { id: "lt", kind: "leads-to", from: "state == Home", to: "state == ログイン" },
      ]),
    );
    const result = runCli(["check", root]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it("exits 1 when a property definition was rejected", async () => {
    const root = await makeRepo(withProperties([{ id: "bad", kind: "eventually" }]));
    assert.equal(runCli(["check", root]).status, 1);
  });

  it("says there are no properties and exits 0 without the file", async () => {
    const root = await makeRepo(login);
    const result = runCli(["check", root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /性質がありません/);
  });

  it("exits 2 for a missing directory", async () => {
    const root = await makeRepo(login);
    assert.equal(runCli(["check", join(root, "missing")]).status, 2);
  });
});

const VIOLATED_EXAMPLE = `違反 no-unauth-home [invariant] 未認証で Home・マイページにいない
  1. ログイン（authed=FALSE, retries=0）
  2. → パスワードリセット（authed=FALSE, retries=0）
  3. →(reset_done) Home（authed=FALSE, retries=0）
成立 lock-after-3 [invariant] 4 回目の失敗は存在しない
成立 logout-eventually-login [leads-to] ログアウトしたら必ずログイン画面に戻る
成立 no-dead-end [no-dead-end] ロックと遷移を持たない DB層 のほかに行き止まりが無い
性質 4 件: 違反 1、成立 3
`;

async function checkTlcWith(script: FakeJavaScript) {
  const root = await exampleRepo();
  const java = await fakeJava(script);
  return { root, ...runCli(["check", "--tlc", root], root, java.env) };
}

describe("everypath check --tlc", () => {
  it("prints each counterexample step with its variables and exits 1", async () => {
    const result = await checkTlcWith({
      rules: [
        {
          when: "INVARIANT P1_no_unauth_home",
          reply: { output: forExample(await fixture("violation")), exit: 12 },
        },
      ],
      otherwise: { output: await fixture("ok") },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, VIOLATED_EXAMPLE);
  });

  it("says where a behavior that never ends goes back to", async () => {
    const result = await checkTlcWith({
      rules: [
        {
          when: "PROPERTY P3_logout_eventually_login",
          reply: { output: forExample(await fixture("liveness")), exit: 13 },
        },
      ],
      otherwise: { output: await fixture("ok") },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.ok(
      result.stdout.includes(
        [
          "違反 logout-eventually-login [leads-to] ログアウトしたら必ずログイン画面に戻る",
          "  1. ログイン（authed=FALSE, retries=0）",
          "  2. →(login_fail) ログイン（authed=FALSE, retries=1）",
          "  3. →(login_fail) ログイン（authed=FALSE, retries=2）",
          "  4. → パスワードリセット（authed=FALSE, retries=2）",
          "  5. →(reset_done) Home（authed=FALSE, retries=2）",
          "  6. →(open_mypage) マイページ（authed=FALSE, retries=2）",
          "  7. →(back) Home（authed=FALSE, retries=2）",
          "  → 6 に戻って繰り返す",
        ].join("\n"),
      ),
      result.stdout,
    );
  });

  it("exits 0 when TLC finds nothing", async () => {
    const result = await checkTlcWith({ rules: [], otherwise: { output: await fixture("ok") } });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /成立 no-unauth-home/);
    assert.match(result.stdout, /性質 4 件: 成立 4/);
  });

  it("exits 1 and says what TLC reported when it fails", async () => {
    const result = await checkTlcWith({
      rules: [],
      otherwise: { output: await fixture("parse-error"), exit: 150 },
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /エラー no-unauth-home/);
    assert.match(result.stdout, /エラー TLC: .*Parsing or semantic analysis failed/);
  });

  it("exits 1 for a variable that left its declared range, even when every property holds", async () => {
    const result = await checkTlcWith({
      rules: [
        {
          when: "INVARIANT TypeOK",
          reply: { output: forExample(await fixture("violation"), "TypeOK"), exit: 12 },
        },
      ],
      otherwise: { output: await fixture("ok") },
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /成立 no-unauth-home/);
    assert.ok(result.stdout.includes("違反 TypeOK 変数が宣言した範囲を外れました"), result.stdout);
    assert.ok(result.stdout.includes("  3. →(reset_done) Home（authed=FALSE, retries=0）"));
  });

  it("prints no parentheses for a model without variables", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-initial", "@state-next B on:go"),
      "src/b.ts": ts("@state B"),
      "everypath.properties.json": JSON.stringify({
        properties: [{ id: "reach-b", kind: "leads-to", from: "state == A", to: "state == B" }],
      }),
    });
    const java = await fakeJava({
      rules: [],
      otherwise: {
        output: [
          "Error: Temporal properties were violated.",
          "Error: The following behavior constitutes a counter-example:",
          "State 1: <Initial predicate>",
          '/\\ state = "S1_A"',
          '/\\ lastEvent = "tau"',
          "",
          "State 2: Stuttering",
          "",
        ].join("\n"),
        exit: 13,
      },
    });

    const result = runCli(["check", "--tlc", root], root, java.env);

    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes("違反 reach-b [leads-to]\n  1. A\n  → 1 に戻って繰り返す\n"));
  });

  it("is not run by a plain check", async () => {
    const root = await exampleRepo();
    const java = await fakeJava({ rules: [], otherwise: { output: await fixture("ok") } });

    const result = runCli(["check", root], root, java.env);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await java.cfgs(), []);
    assert.match(result.stdout, /保留 no-unauth-home/);
  });
});

describe("everypath tla export", () => {
  it("writes Model.tla and Model.cfg and nothing else, with no Java on the PATH", async () => {
    const root = await exampleRepo();
    const emptyPath = await makeRepo({});

    const result = runCli(["tla", "export", root], root, { ...process.env, PATH: emptyPath });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Model\.tla と Model\.cfg/);
    assert.deepEqual(await readdir(join(root, ".everypath")), ["tla"]);
    assert.deepEqual((await readdir(join(root, ".everypath", "tla"))).sort(), [
      "Model.cfg",
      "Model.tla",
    ]);
    const tla = await readFile(join(root, ".everypath", "tla", "Model.tla"), "utf8");
    assert.ok(tla.startsWith("---- MODULE Model ----\n"));
    const cfg = await readFile(join(root, ".everypath", "tla", "Model.cfg"), "utf8");
    assert.match(cfg, /^SPECIFICATION Spec\n/);
    assert.match(cfg, /INVARIANT TypeOK\n/);
  });

  it("warns about a property it left out and still exits 0", async () => {
    const root = await exampleRepo();
    await writeFiles(root, {
      "everypath.properties.json": JSON.stringify({
        properties: [{ id: "typo", kind: "invariant", expr: "retriez <= 3" }],
      }),
    });

    const result = runCli(["tla", "export", root]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /typo/);
    assert.match(result.stderr, /retriez/);
  });

  it("exits 1 and writes nothing when no state can start the model", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-next B"),
      "src/b.ts": ts("@state B", "@state-next A"),
    });

    const result = runCli(["tla", "export", root]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /入口/);
    assert.deepEqual(await readdir(root), ["src"]);
  });
});

type Served = { readonly url: string; close(): Promise<void> };

function serve(respond: (response: ServerResponse) => void): Promise<Served> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => respond(response));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      resolve({
        url: `http://127.0.0.1:${address.port}/tla2tools.jar`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

const JAR_BYTES = Buffer.from("PK pretend this is tla2tools.jar");
const JAR_SHA256 = createHash("sha256").update(JAR_BYTES).digest("hex");

async function install(
  respond: (response: ServerResponse) => void,
  existing?: Buffer,
): Promise<{ status: number | null; stderr: string; target: string; directory: string }> {
  const scratch = await makeRepo({});
  const directory = join(scratch, "home");
  const target = join(directory, "tla2tools.jar");
  if (existing !== undefined) {
    await mkdir(directory, { recursive: true });
    await writeFile(target, existing);
  }
  const server = await serve(respond);
  try {
    const result = await runCliAsync(["tla", "install"], scratch, {
      ...process.env,
      EVERYPATH_TLA_URL: server.url,
      EVERYPATH_TLA_SHA256: JAR_SHA256,
      EVERYPATH_TLA_JAR: target,
    });
    return { status: result.status, stderr: result.stderr, target, directory };
  } finally {
    await server.close();
  }
}

describe("everypath tla install", () => {
  it("puts the downloaded jar where EVERYPATH_TLA_JAR points and leaves no temporary file", async () => {
    const result = await install((response) => response.end(JAR_BYTES));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(result.target), JAR_BYTES);
    assert.deepEqual(await readdir(result.directory), ["tla2tools.jar"]);
  });

  it("refuses a jar whose sha256 differs and leaves the old jar alone", async () => {
    const old = Buffer.from("the jar that was already there");

    const result = await install((response) => response.end("something else"), old);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /sha256/);
    assert.deepEqual(await readFile(result.target), old);
    assert.deepEqual(await readdir(result.directory), ["tla2tools.jar"]);
  });

  it("places nothing when the server answers with an error", async () => {
    const result = await install((response) => {
      response.statusCode = 404;
      response.end("not found");
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /404/);
    await assert.rejects(readdir(result.directory), { code: "ENOENT" });
  });

  it("exits 2 when only one of EVERYPATH_TLA_URL and EVERYPATH_TLA_SHA256 is set", () => {
    const onlyUrl = runCli(["tla", "install"], undefined, {
      ...process.env,
      EVERYPATH_TLA_URL: "http://127.0.0.1:9/tla2tools.jar",
      EVERYPATH_TLA_SHA256: "",
    });
    const onlySha = runCli(["tla", "install"], undefined, {
      ...process.env,
      EVERYPATH_TLA_URL: "",
      EVERYPATH_TLA_SHA256: JAR_SHA256,
    });

    assert.equal(onlyUrl.status, 2, onlyUrl.stderr);
    assert.equal(onlySha.status, 2, onlySha.stderr);
    assert.match(onlyUrl.stderr, /EVERYPATH_TLA_SHA256/);
    assert.match(onlySha.stderr, /EVERYPATH_TLA_URL/);
  });
});

describe("everypath usage errors for the TLA+ commands", () => {
  const badUsage: readonly (readonly [readonly string[], RegExp])[] = [
    [["check", "--timeout", "5"], /--tlc/],
    [["check", "--tlc", "--timeout", "0"], /整数/],
    [["check", "--tlc", "--timeout", "abc"], /整数/],
    [["check", "--tlc", "--timeout"], /整数/],
    [["check", "--tlc", "--json"], /check は --json/],
    [["scan", "--tlc"], /scan は --tlc/],
    [["tla"], /export/],
    [["tla", "bogus"], /tla bogus/],
    [["tla", "export", "a", "b"], /tla export a b/],
    [["tla", "export", "--json"], /tla export は --json/],
    [["tla", "install", "somewhere"], /tla install somewhere/],
  ];

  for (const [args, message] of badUsage) {
    it(`exits 2 for ${args.join(" ")}`, () => {
      const result = runCli(args);

      assert.equal(result.status, 2);
      assert.match(result.stderr, message);
    });
  }

  it("lists the new commands in --help", () => {
    const result = runCli(["--help"]);

    assert.equal(result.status, 0);
    for (const command of ["check [dir] [--tlc", "tla export", "tla install"]) {
      assert.ok(result.stdout.includes(command), command);
    }
  });
});
