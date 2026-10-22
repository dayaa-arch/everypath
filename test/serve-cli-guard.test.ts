import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { serveUntilExit } from "../scripts/serve-client.js";
import type { HistoryEntry } from "../src/core/types.js";
import { makeRepo, runCliAsync, ts, writeFiles } from "./helpers/repo.js";
import {
  hasNode,
  javaEnv,
  readOutput,
  ready,
  request,
  serveEnv,
  serveRepo,
  violationRun,
} from "./helpers/server.js";
import { exampleRepo, fakeJava } from "./helpers/tlc.js";

const ROUNDS = 5;
const OUTPUT = ".everypath";

async function historyOf(root: string): Promise<HistoryEntry[]> {
  const text = await readOutput(root, "history.jsonl");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as HistoryEntry);
}

const readDisk = (root: string, file: string): Promise<string> =>
  readFile(join(root, OUTPUT, file), "utf8");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const portOf = (url: string): number => Number(new URL(url).port);

/** A pid that belonged to a process which has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(typeof child.pid === "number" && child.pid > 0);
  return child.pid;
}

/** A port that was free a moment ago and has nothing listening on it now. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const record = (pid: number, port: number): string =>
  `${JSON.stringify({ version: 1, pid, port }, null, 2)}\n`;

describe("serve-cli guard: scan beside serve", () => {
  it("adds each change to history once and leaves graph.json as the server wrote it", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A") });
    const env = await serveEnv();
    const serve = await serveRepo(root, env);
    const events = await ready(serve);

    for (let round = 1; round <= ROUNDS; round++) {
      await writeFiles(root, { [`src/s${round}.ts`]: ts(`@state S${round}`, "@state-next A") });
      const runs = await Promise.all(
        [1, 2].map(() => runCliAsync(["scan", "--quiet", root], root, env)),
      );
      for (const run of runs) assert.equal(run.status, 0, run.stderr);
    }
    const last = `S${ROUNDS}`;
    await events.graph((graph) => hasNode(graph, last), { timeoutMs: 20_000 });
    const flushed = await request(serve, "POST", "/rescan");
    assert.ok(flushed.status < 300, `${flushed.status} ${flushed.text}`);

    const added = (await historyOf(root)).flatMap((entry) => entry.added);
    for (let round = 1; round <= ROUNDS; round++) {
      const lines = added.filter((id) => id === `S${round}`).length;
      assert.equal(lines, 1, `S${round} is added by ${lines} history lines`);
    }
    const served = await request(serve, "GET", "/graph.json");
    const disk = await readDisk(root, "graph.json");
    assert.equal(disk, served.text, "graph.json on disk is the graph the server last wrote");
  });
});

describe("serve-cli guard: the serve record", () => {
  it("holds the pid and port of a running serve and is gone once it stops", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A") });
    const serve = await serveRepo(root);

    const held = JSON.parse(await readDisk(root, "serve.json"));
    assert.equal(held.version, 1);
    assert.equal(held.port, portOf(serve.url));
    assert.ok(Number.isInteger(held.pid) && held.pid > 0, `pid ${held.pid}`);
    assert.doesNotThrow(() => process.kill(held.pid, 0), "the recorded pid is alive");

    await serve.stop();
    assert.equal(await exists(join(root, OUTPUT, "serve.json")), false, "serve.json is removed");
  });

  it("refuses a second serve of the same directory and names the first one's URL", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A") });
    const env = await serveEnv();
    const serve = await serveRepo(root, env);
    const before = await readDisk(root, "serve.json");

    const second = await serveUntilExit({ directory: root, env });

    assert.equal(second.status, 1, second.stderr);
    assert.ok(second.stderr.includes(`127.0.0.1:${portOf(serve.url)}`), second.stderr);
    assert.match(second.stderr, /[\p{Script=Hiragana}\p{Script=Han}]/u);
    assert.equal(await readDisk(root, "serve.json"), before);
    assert.equal((await request(serve, "GET", "/graph.json")).status, 200);
  });

  it("names the first serve rather than the busy port when the second asks for the same port", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A") });
    const env = await serveEnv();
    const serve = await serveRepo(root, env);
    const port = portOf(serve.url);

    const second = await serveUntilExit({ directory: root, env, port });

    assert.equal(second.status, 1, second.stderr);
    assert.ok(second.stderr.includes(`127.0.0.1:${port}/`), second.stderr);
    assert.doesNotMatch(second.stderr, /使用中/);
  });

  it("starts over a record whose pid has exited, and records itself", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A") });
    await writeFiles(root, { [`${OUTPUT}/serve.json`]: record(deadPid(), await closedPort()) });

    const serve = await serveRepo(root);

    assert.equal(JSON.parse(await readDisk(root, "serve.json")).port, portOf(serve.url));
  });
});

describe("serve-cli guard: scan and check hand their writes to a running serve", () => {
  it("prints the served graph for scan --json, and neither scan nor check writes graph.json", async () => {
    const root = await exampleRepo();
    const env = await serveEnv();
    const serve = await serveRepo(root, env);
    await ready(serve);
    const before = await readDisk(root, "graph.json");
    const direct = await exampleRepo();
    const expected = await runCliAsync(["check", direct], direct, env);

    const scanned = await runCliAsync(["scan", "--json", "--quiet", root], root, env);
    const checked = await runCliAsync(["check", root], root, env);

    assert.equal(scanned.status, 0, scanned.stderr);
    assert.equal(scanned.stdout, (await request(serve, "GET", "/graph.json")).text);
    assert.equal(checked.status, expected.status, `${checked.stdout}\n${checked.stderr}`);
    assert.equal(checked.stdout, expected.stdout);
    assert.equal(await readDisk(root, "graph.json"), before, "the CLI wrote graph.json itself");
  });

  it("runs check --tlc on the server, which a viewer sees, and reports what a direct run reports", async () => {
    const java = await fakeJava(await violationRun());
    const root = await exampleRepo();
    const serve = await serveRepo(root, javaEnv(java));
    const events = await ready(serve);
    const since = events.received.length;
    const direct = await exampleRepo();
    const expected = await runCliAsync(["check", "--tlc", direct], direct, java.env);
    const callsBefore = (await java.calls()).length;
    const withoutJava = await serveEnv();

    const checked = await runCliAsync(["check", "--tlc", root], root, withoutJava);

    assert.equal(expected.status, 1, expected.stdout);
    assert.equal(checked.status, 1, `${checked.stdout}\n${checked.stderr}`);
    assert.equal(checked.stdout, expected.stdout);
    await events.tlc("running", { since });
    await events.tlc("done", { since });
    assert.ok((await java.calls()).length > callsBefore, "TLC ran in the server's environment");
    assert.ok(await exists(join(root, OUTPUT, "tla", "result.json")));
  });

  it("passes --timeout to the server's run", async () => {
    const progress =
      "Progress(9) at 2026-10-21 23:01:25: 113 states generated, 47 distinct states found, 0 states left on queue.\n";
    const java = await fakeJava({ rules: [], otherwise: { output: progress, hang: true } });
    const root = await exampleRepo();
    const serve = await serveRepo(root, javaEnv(java));
    await ready(serve);
    const started = Date.now();

    const checked = await runCliAsync(
      ["check", "--tlc", "--timeout", "2", root],
      root,
      await serveEnv(),
    );

    assert.ok(Date.now() - started < 60_000, "the server's run kept the 2 s budget");
    assert.equal(checked.status, 1, `${checked.stdout}\n${checked.stderr}`);
    assert.match(checked.stdout, /タイムアウト/);
  });

  it("guides the install and decides by the quick check when the server has no Java (R-03)", async () => {
    const root = await makeRepo({
      "src/a.ts": ts("@state A", "@state-initial", "@state-next B"),
      "src/b.ts": ts("@state B", "@state-next A"),
    });
    const serve = await serveRepo(root);
    await ready(serve);
    const cliJava = await fakeJava(await violationRun());

    const checked = await runCliAsync(["check", "--tlc", root], root, cliJava.env);

    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    assert.match(checked.stderr, /TLC を動かせません/);
    assert.match(checked.stderr, /everypath tla install/);
  });
});

describe("serve-cli guard: a stale record", () => {
  it("lets scan write itself when the recorded pid has exited", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A") });
    await writeFiles(root, { [`${OUTPUT}/serve.json`]: record(deadPid(), await closedPort()) });

    const scanned = await runCliAsync(["scan", "--quiet", root], root);

    assert.equal(scanned.status, 0, scanned.stderr);
    assert.ok(await exists(join(root, OUTPUT, "graph.json")));
  });

  it("lets scan write itself when the recorded port refuses the connection", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A") });
    await writeFiles(root, { [`${OUTPUT}/serve.json`]: record(process.pid, await closedPort()) });

    const scanned = await runCliAsync(["scan", "--quiet", root], root);

    assert.equal(scanned.status, 0, scanned.stderr);
    assert.ok(await exists(join(root, OUTPUT, "graph.json")));
  });
});
