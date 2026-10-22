import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { get, request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hasFlow, serveUntilExit } from "../scripts/serve-client.js";
import type { Graph } from "../src/core/types.js";
import { flows, makeRepo, node, runCli, ts, writeFiles } from "./helpers/repo.js";
import {
  connect,
  GIT_USER,
  hasNode,
  javaEnv,
  propertyOf,
  rawRequest,
  readOutput,
  readReview,
  ready,
  request,
  reviewPath,
  serveEnv,
  serveRepo,
  sha1,
  staleModelOf,
  succeeded,
  violationRun,
} from "./helpers/server.js";
import { exampleRepo, fakeJava } from "./helpers/tlc.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const HOME_SOURCE = ts("@state Home", "@state-initial", "@state-next ログイン on:logout");
const LOGIN_SOURCE = ts("@state ログイン", "@state-next Home on:login_ok");
const SETTINGS_SOURCE = ts("@state 設定", "@state-next Home");
const small = { "src/home.ts": HOME_SOURCE, "src/login.ts": LOGIN_SOURCE };

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("serve: startup and /graph.json", () => {
  it("prints its URL as the first stdout line and serves the nodes and edges of scan --json", async () => {
    const root = await makeRepo(small);
    const before = runCli(["scan", "--json", "--quiet", root]);
    assert.equal(before.status, 0, before.stderr);
    const serve = await serveRepo(root);

    assert.match(serve.firstLine, /^http:\/\/(?:localhost|127\.0\.0\.1):[1-9]\d*\/?$/);
    const served = await request(serve, "GET", "/graph.json");
    assert.equal(served.status, 200);
    const graph: Graph = served.json() as Graph;
    const scanned: Graph = JSON.parse(before.stdout);
    assert.deepEqual(graph.nodes, scanned.nodes);
    assert.deepEqual(graph.edges, scanned.edges);
    const after = runCli(["scan", "--json", "--quiet", root]);
    assert.deepEqual(graph.nodes, (JSON.parse(after.stdout) as Graph).nodes);
  });

  it("answers GET /tla/Model.tla with 404 before any TLC run", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);

    assert.equal((await request(serve, "GET", "/tla/Model.tla")).status, 404);
  });

  const uiBuilt = existsSync(join(repoRoot, "dist", "ui.html"));
  it("answers GET / with 503 and Japanese guidance while dist/ui.html is not built", {
    skip: uiBuilt ? "dist/ui.html exists in this checkout" : false,
  }, async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);

    const reply = await request(serve, "GET", "/");

    assert.equal(reply.status, 503);
    assert.match(reply.text, JAPANESE);
  });

  it("exits 1 with a Japanese message when the port is in use", async () => {
    const root = await makeRepo(small);
    const taken = await occupyPort();
    try {
      const result = await serveUntilExit({
        directory: root,
        port: taken.port,
        env: await serveEnv(),
      });

      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, JAPANESE);
      assert.doesNotMatch(result.stdout, /https?:\/\//);
    } finally {
      await taken.release();
    }
  });
});

/** Holds one port on 127.0.0.1 and, where IPv6 works, on ::1, whichever address `localhost` picks. */
async function occupyPort(): Promise<{ port: number; release(): Promise<void> }> {
  const listen = (server: Server, port: number, host: string) =>
    new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, host, () => resolve(true));
    });
  const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
  const v4 = createServer();
  assert.ok(await listen(v4, 0, "127.0.0.1"), "could not listen on 127.0.0.1");
  const address = v4.address();
  assert.ok(address !== null && typeof address !== "string", "no port was assigned");
  const v6 = createServer();
  const holdsV6 = await listen(v6, address.port, "::1");
  return {
    port: address.port,
    release: async () => {
      await close(v4);
      if (holdsV6) await close(v6);
    },
  };
}

describe("serve: /events", () => {
  it("sends {type: graph, diff: null} as soon as a client connects", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);

    const events = await connect(serve);
    const first = await events.graph();

    assert.match(events.contentType ?? "", /^text\/event-stream/);
    assert.equal(events.received[0], first);
    assert.equal(first.diff, null);
    assert.deepEqual(first.graph.nodes.map((n) => n.id).sort(), ["Home", "ログイン"]);
  });

  it("sends a graph event with the new node and edge when a file with @state 設定 is added", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const events = await ready(serve);
    const since = events.received.length;

    await writeFiles(root, { "src/settings.ts": SETTINGS_SOURCE });
    const event = await events.graph((graph) => hasNode(graph, "設定"), { since });

    assert.ok(hasFlow(event.graph, "設定", "Home"), "the 設定 -> Home flow edge");
    assert.equal(flows(event.graph).filter((e) => e.from === "設定").length, 1);
    assert.deepEqual(event.diff?.added, ["設定"]);
    assert.ok(
      event.diff?.addedEdges.some((e) => e.type === "flow" && e.from === "設定" && e.to === "Home"),
      "the diff names the new edge",
    );
  });

  it("lists the diffs oldest first on GET /history.json, ending with the latest", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const events = await ready(serve);
    const since = events.received.length;

    await writeFiles(root, { "src/settings.ts": SETTINGS_SOURCE });
    await events.graph((graph) => hasNode(graph, "設定"), { since });

    const reply = await request(serve, "GET", "/history.json");
    assert.equal(reply.status, 200);
    const history = reply.json();
    assert.ok(Array.isArray(history), "an array");
    assert.ok(history.length >= 2 && history.length <= 200, `length ${history.length}`);
    const latest: unknown = history.at(-1);
    assert.ok(typeof latest === "object" && latest !== null && "added" in latest);
    assert.deepEqual(latest.added, ["設定"]);
  });

  it("answers GET /history.json with at most the latest 200 diffs", async () => {
    const root = await makeRepo(small);
    const lines = Array.from({ length: 250 }, (_, i) =>
      JSON.stringify({
        at: `t${i}`,
        reason: "seed",
        added: [],
        removed: [],
        updated: [],
        addedEdges: [],
        removedEdges: [],
      }),
    );
    await writeFiles(root, { ".everypath/history.jsonl": `${lines.join("\n")}\n` });
    const serve = await serveRepo(root);

    const history = (await request(serve, "GET", "/history.json")).json();
    assert.ok(Array.isArray(history));
    assert.equal(history.length, 200);
    assert.deepEqual(history[0], JSON.parse(lines[51] ?? ""));
  });
});

describe("serve: review", () => {
  it("writes the approval with hash, at and by, shows reviewed, flags a later edit and revokes", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const events = await ready(serve);
    const hash = sha1(HOME_SOURCE);
    const started = Date.now();
    let since = events.received.length;

    const approved = await request(serve, "POST", reviewPath("Home"), {
      body: { note: "仕様確認済み" },
    });
    assert.ok(succeeded(approved), `${approved.status} ${approved.text}`);
    const reviewed = await events.graph((graph) => node(graph, "Home").status.reviewed, { since });

    assert.equal(node(reviewed.graph, "Home").hash, hash);
    assert.equal(node(reviewed.graph, "ログイン").status.reviewed, false);
    const file = await readReview(root);
    assert.equal(file.version, 1);
    const entry = file.approvals.Home;
    assert.ok(entry, "an approval for Home");
    assert.deepEqual(
      { hash: entry.hash, by: entry.by, note: entry.note },
      { hash, by: GIT_USER, note: "仕様確認済み" },
    );
    const at = Date.parse(entry.at);
    assert.ok(at >= started - 2_000 && at <= Date.now() + 2_000, `at ${entry.at}`);

    since = events.received.length;
    await writeFile(join(root, "src", "home.ts"), `${HOME_SOURCE}// 変更\n`);
    const changed = await events.graph((graph) => node(graph, "Home").status.changedSinceReview, {
      since,
    });
    assert.equal(node(changed.graph, "Home").status.reviewed, false);
    assert.equal((await readReview(root)).approvals.Home?.hash, hash);

    since = events.received.length;
    const revoked = await request(serve, "DELETE", reviewPath("Home"));
    assert.ok(succeeded(revoked), `${revoked.status} ${revoked.text}`);
    const cleared = await events.graph(
      (graph) =>
        !node(graph, "Home").status.changedSinceReview && !node(graph, "Home").status.reviewed,
      { since },
    );
    assert.equal(node(cleared.graph, "Home").status.reviewed, false);
    assert.equal((await readReview(root)).approvals.Home, undefined);
  });

  it("answers 404 for a node that does not exist and records nothing", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);

    const reply = await request(serve, "POST", reviewPath("存在しない"), { body: { note: "x" } });

    assert.equal(reply.status, 404);
    assert.deepEqual((await readReview(root)).approvals, {});
  });

  it("answers 400 for a body that is not {note} and records nothing", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const bodies = ["{", "[]", '"just text"', '{"note":5}', '{"note":"ok","hash":5}'];

    for (const raw of bodies) {
      const reply = await request(serve, "POST", reviewPath("Home"), { raw });
      assert.equal(reply.status, 400, `${raw} -> ${reply.status} ${reply.text}`);
    }
    assert.deepEqual((await readReview(root)).approvals, {});
  });

  it("answers 409 in Japanese to approving a container, which has no file, and records nothing", async () => {
    const root = await makeRepo({
      ...small,
      "src/c.ts": ts("@state C", "@state-parent Ghost"),
    });
    const serve = await serveRepo(root);
    const shown = (await request(serve, "GET", "/graph.json")).json() as Graph;
    assert.equal(node(shown, "Ghost").container, true);

    const refused = await request(serve, "POST", reviewPath("Ghost"), { body: { note: "x" } });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.text, JAPANESE);
    assert.deepEqual((await readReview(root)).approvals, {});
    const child = await request(serve, "POST", reviewPath("C"), { body: { note: "x" } });
    assert.ok(succeeded(child), `${child.status} ${child.text}`);
  });

  it("answers 409 for a hash that is not the node's current hash, and approves the current one", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const events = await ready(serve);
    const oldHash = sha1(HOME_SOURCE);
    const edited = `${HOME_SOURCE}// 変更\n`;

    const unknown = await request(serve, "POST", reviewPath("Home"), {
      body: { note: "x", hash: "0".repeat(40) },
    });
    assert.equal(unknown.status, 409);
    assert.deepEqual((await readReview(root)).approvals, {});

    const current = await request(serve, "POST", reviewPath("Home"), {
      body: { note: "x", hash: oldHash },
    });
    assert.ok(succeeded(current), `${current.status} ${current.text}`);
    assert.equal((await readReview(root)).approvals.Home?.hash, oldHash);

    const since = events.received.length;
    await writeFile(join(root, "src", "home.ts"), edited);
    await events.graph((graph) => node(graph, "Home").hash === sha1(edited), { since });
    const stale = await request(serve, "POST", reviewPath("Home"), {
      body: { note: "x", hash: oldHash },
    });
    assert.equal(stale.status, 409);
    assert.equal((await readReview(root)).approvals.Home?.hash, oldHash);

    const renewed = await request(serve, "POST", reviewPath("Home"), {
      body: { note: "x", hash: sha1(edited) },
    });
    assert.ok(succeeded(renewed), `${renewed.status} ${renewed.text}`);
    assert.equal((await readReview(root)).approvals.Home?.hash, sha1(edited));
  });
});

describe("serve: layout", () => {
  const layout = { Home: { x: 40, y: 80 }, ログイン: { x: 260.5, y: 80 } };

  it("saves a valid body to .everypath/layout.json and returns it on GET", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);

    const saved = await request(serve, "PUT", "/layout.json", { body: layout });

    assert.ok(succeeded(saved), `${saved.status} ${saved.text}`);
    const got = await request(serve, "GET", "/layout.json");
    assert.equal(got.status, 200);
    assert.deepEqual(got.json(), layout);
    assert.deepEqual(JSON.parse(await readOutput(root, "layout.json")), layout);
  });

  it("answers 400 for a body that is not a layout and keeps the saved one", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const saved = await request(serve, "PUT", "/layout.json", { body: layout });
    assert.ok(succeeded(saved), `${saved.status} ${saved.text}`);
    const bodies = [
      "{",
      "[]",
      '"x"',
      "null",
      JSON.stringify({ Home: { x: "left", y: 1 } }),
      JSON.stringify({ Home: 5 }),
    ];

    for (const raw of bodies) {
      const reply = await request(serve, "PUT", "/layout.json", { raw });
      assert.equal(reply.status, 400, `${raw} -> ${reply.status} ${reply.text}`);
    }
    assert.deepEqual((await request(serve, "GET", "/layout.json")).json(), layout);
    assert.deepEqual(JSON.parse(await readOutput(root, "layout.json")), layout);
  });

  it("leaves layout.json byte-identical through rescans", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const events = await ready(serve);
    const saved = await request(serve, "PUT", "/layout.json", { body: layout });
    assert.ok(succeeded(saved), `${saved.status} ${saved.text}`);
    const before = await readOutput(root, "layout.json");
    const since = events.received.length;

    const rescan = await request(serve, "POST", "/rescan");
    assert.ok(succeeded(rescan), `${rescan.status} ${rescan.text}`);
    await writeFiles(root, { "src/settings.ts": SETTINGS_SOURCE });
    await events.graph((graph) => hasNode(graph, "設定"), { since });

    assert.equal(await readOutput(root, "layout.json"), before);
  });
});

describe("serve: POST /check/tlc", () => {
  it("answers 202, sends running then done, and re-broadcasts the graph with TLC's verdicts", async () => {
    const root = await exampleRepo();
    const java = await fakeJava(await violationRun());
    const serve = await serveRepo(root, javaEnv(java));
    const events = await ready(serve);
    const since = events.received.length;

    const started = await request(serve, "POST", "/check/tlc");
    assert.equal(started.status, 202, started.text);
    const running = await events.tlc("running", { since });
    const done = await events.tlc("done", { since });
    const broadcast = await events.graph(isTlcViolation, { since });

    assert.ok(events.received.indexOf(running) < events.received.indexOf(done));
    assert.equal(typeof done.states, "number");
    const result = propertyOf(broadcast.graph, "no-unauth-home");
    assert.deepEqual(
      result.counterexamples.map((c) => [...c.path]),
      [["ログイン", "パスワードリセット", "Home"]],
    );
    assert.deepEqual(violatedNodes(broadcast.graph), ["Home", "パスワードリセット", "ログイン"]);
    const model = await request(serve, "GET", "/tla/Model.tla");
    assert.equal(model.status, 200);
    assert.match(model.text, /MODULE Model/);
    assert.equal(model.text, await readOutput(root, "tla", "Model.tla"));
  });

  it("answers 409 to a second request while a run is open, keeps the other APIs live, then accepts again", async () => {
    const root = await exampleRepo();
    const gate = join(await makeRepo({}), "release");
    const java = await fakeJava(await violationRun(gate));
    const serve = await serveRepo(root, javaEnv(java));
    const events = await ready(serve);
    let since = events.received.length;

    const first = await request(serve, "POST", "/check/tlc");
    assert.equal(first.status, 202, first.text);
    await events.tlc("running", { since });
    const second = await request(serve, "POST", "/check/tlc");
    assert.equal(second.status, 409, second.text);

    assert.equal((await request(serve, "GET", "/graph.json")).status, 200);
    const approved = await request(serve, "POST", reviewPath("Home"), { body: { note: "x" } });
    assert.ok(succeeded(approved), `${approved.status} ${approved.text}`);
    await events.graph((graph) => node(graph, "Home").status.reviewed, { since });
    assert.equal(
      events.received.slice(since).filter((e) => e.type === "tlc" && e.status !== "running").length,
      0,
      "the run is still open",
    );

    await writeFile(gate, "");
    await events.tlc("done", { since });
    since = events.received.length;
    const third = await request(serve, "POST", "/check/tlc");
    assert.equal(third.status, 202, third.text);
    await events.tlc("done", { since });
  });

  it("sends an error event with install guidance when java is not on the PATH, and the other APIs keep answering", async () => {
    const root = await exampleRepo();
    const nowhere = await makeRepo({});
    const jar = await makeRepo({ "tla2tools.jar": "not a jar" });
    const serve = await serveRepo(
      root,
      serveEnv({ PATH: nowhere, EVERYPATH_TLA_JAR: join(jar, "tla2tools.jar") }),
    );
    const events = await ready(serve);
    const since = events.received.length;

    const started = await request(serve, "POST", "/check/tlc");
    assert.equal(started.status, 202, started.text);
    const failed = await events.tlc("error", { since });

    assert.match(failed.message ?? "", /everypath tla install/);
    const graph = await request(serve, "GET", "/graph.json");
    assert.equal(graph.status, 200);
    assert.ok((graph.json() as Graph).nodes.length > 0);
    const approved = await request(serve, "POST", reviewPath("Home"), { body: { note: "x" } });
    assert.ok(succeeded(approved), `${approved.status} ${approved.text}`);
    await events.graph((g) => node(g, "Home").status.reviewed, { since });
  });

  it("sends done only once the record is on disk, so Model.tla answers 200 at that moment", async () => {
    const root = await exampleRepo();
    const java = await fakeJava(await violationRun());
    const serve = await serveRepo(root, javaEnv(java));
    const events = await ready(serve);
    const since = events.received.length;

    const started = await request(serve, "POST", "/check/tlc");
    assert.equal(started.status, 202, started.text);
    const done = await events.tlc("done", { since });
    const model = await request(serve, "GET", "/tla/Model.tla");
    const verdicts = await events.graph(isTlcViolation, { since });

    assert.equal(model.status, 200, model.text);
    assert.ok(
      events.received.indexOf(done) < events.received.indexOf(verdicts),
      "done, then the graph",
    );
  });

  it("sends error with the reason when the record cannot be written, then accepts a new run", async () => {
    const root = await exampleRepo();
    await writeFiles(root, { ".everypath/tla": "a file where the directory goes" });
    const java = await fakeJava(await violationRun());
    const serve = await serveRepo(root, javaEnv(java));
    const events = await ready(serve);
    const since = events.received.length;

    const started = await request(serve, "POST", "/check/tlc");
    assert.equal(started.status, 202, started.text);
    const failed = await events.tlc("error", { since });

    assert.ok((failed.message ?? "").length > 0, "the error says why");
    assert.ok(
      !events.received.slice(since).some((e) => e.type === "tlc" && e.status === "done"),
      "no done for a run whose record was not written",
    );
    const again = await request(serve, "POST", "/check/tlc");
    assert.equal(again.status, 202, again.text);
  });

  const realJar = process.env.EVERYPATH_TLA_JAR ?? join(homedir(), ".everypath", "tla2tools.jar");
  const realTlc =
    existsSync(realJar) && spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0
      ? false
      : "needs a tla2tools.jar and a working java";
  it("finds the violation of no-unauth-home with the real TLC", { skip: realTlc }, async () => {
    const root = await exampleRepo();
    const serve = await serveRepo(root, serveEnv({ EVERYPATH_TLA_JAR: realJar }));
    const events = await ready(serve);
    const since = events.received.length;

    const started = await request(serve, "POST", "/check/tlc");
    assert.equal(started.status, 202, started.text);
    await events.tlc("done", { since, timeoutMs: 120_000 });
    const broadcast = await events.graph(isTlcViolation, { since, timeoutMs: 120_000 });

    assert.deepEqual(
      propertyOf(broadcast.graph, "no-unauth-home").counterexamples.map((c) => [...c.path]),
      [["ログイン", "パスワードリセット", "Home"]],
    );
    assert.equal(propertyOf(broadcast.graph, "lock-after-3").result, "ok");
  });
});

const LOGIN_FILE = "src/auth/login.ts";
const GUARD = "if:retries<3 set:retries=retries+1";
const NARROWER = "if:retries<2 set:retries=retries+1";

function isTlcViolation(graph: Graph): boolean {
  const result = propertyOf(graph, "no-unauth-home");
  return result.result === "violated" && result.checkedBy === "tlc";
}

/** Ids of the nodes whose `violations` mention any property, in id order. */
function violatedNodes(graph: Graph): string[] {
  return graph.nodes
    .filter((n) => n.violations.length > 0)
    .map((n) => n.id)
    .sort();
}

async function loginSource(root: string): Promise<string> {
  const source = await readFile(join(root, LOGIN_FILE), "utf8");
  assert.ok(source.includes(GUARD), `${LOGIN_FILE} should declare ${GUARD}`);
  return source;
}

describe("serve: a TLC result outlives rescans", () => {
  it("keeps it through an unrelated edit, marks it staleModel after a transition edit, and restores it when the edit is undone", async () => {
    const root = await exampleRepo();
    const java = await fakeJava(await violationRun());
    const serve = await serveRepo(root, javaEnv(java));
    const events = await ready(serve);
    let since = events.received.length;
    await request(serve, "POST", "/check/tlc");
    await events.tlc("done", { since });
    await events.graph(isTlcViolation, { since });

    const homePath = join(root, "src", "home.ts");
    const home = await readFile(homePath, "utf8");
    since = events.received.length;
    await writeFile(homePath, `${home}// 変更\n`);
    const unrelated = await events.graph((g) => node(g, "Home").hash === sha1(`${home}// 変更\n`), {
      since,
    });
    const kept = propertyOf(unrelated.graph, "no-unauth-home");
    assert.deepEqual([kept.result, kept.checkedBy], ["violated", "tlc"]);
    assert.notEqual(staleModelOf(kept), true);
    assert.deepEqual(violatedNodes(unrelated.graph), ["Home", "パスワードリセット", "ログイン"]);

    const original = await loginSource(root);
    const narrowed = original.replace(GUARD, NARROWER);
    since = events.received.length;
    await writeFile(join(root, LOGIN_FILE), narrowed);
    const stale = await events.graph((g) => node(g, "ログイン").hash === sha1(narrowed), { since });
    const old = propertyOf(stale.graph, "no-unauth-home");
    assert.deepEqual([old.result, old.checkedBy], ["violated", "tlc"]);
    assert.equal(staleModelOf(old), true);
    assert.deepEqual(violatedNodes(stale.graph), []);

    since = events.received.length;
    await writeFile(join(root, LOGIN_FILE), original);
    const restored = await events.graph((g) => node(g, "ログイン").hash === sha1(original), {
      since,
    });
    const back = propertyOf(restored.graph, "no-unauth-home");
    assert.deepEqual([back.result, back.checkedBy], ["violated", "tlc"]);
    assert.notEqual(staleModelOf(back), true);
    assert.deepEqual(violatedNodes(restored.graph), ["Home", "パスワードリセット", "ログイン"]);
  });

  it("is kept by scan --json and check, which stop counting it once a transition changes", async () => {
    const root = await exampleRepo();
    const java = await fakeJava(await violationRun());
    const checked = runCli(["check", "--tlc", root], root, java.env);
    assert.equal(checked.status, 1, `${checked.stdout}\n${checked.stderr}`);

    const scanned = scanJson(root);
    const kept = propertyOf(scanned, "no-unauth-home");
    assert.deepEqual([kept.result, kept.checkedBy], ["violated", "tlc"]);
    assert.notEqual(staleModelOf(kept), true);
    assert.deepEqual(
      kept.counterexamples.map((c) => [...c.path]),
      [["ログイン", "パスワードリセット", "Home"]],
    );
    assert.deepEqual(violatedNodes(scanned), ["Home", "パスワードリセット", "ログイン"]);
    const fresh = runCli(["check", root]);
    assert.equal(fresh.status, 1, `${fresh.stdout}\n${fresh.stderr}`);
    assert.match(fresh.stdout, /no-unauth-home/);

    await writeFile(join(root, LOGIN_FILE), (await loginSource(root)).replace(GUARD, NARROWER));
    const rescanned = scanJson(root);
    const old = propertyOf(rescanned, "no-unauth-home");
    assert.deepEqual([old.result, old.checkedBy], ["violated", "tlc"]);
    assert.equal(staleModelOf(old), true);
    assert.deepEqual(violatedNodes(rescanned), []);
    const plain = runCli(["check", root]);
    assert.equal(plain.status, 0, `${plain.stdout}\n${plain.stderr}`);
    assert.match(`${plain.stdout}${plain.stderr}`, /古いモデルに対する結果/);
  });
});

function scanJson(root: string): Graph {
  const result = runCli(["scan", "--json", "--quiet", root]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("serve: what triggers a rescan", () => {
  it("does not rescan for graph.json, history.jsonl or the temporary files of its own writes", async () => {
    const root = await makeRepo({ ...small, ".everypath/tla/.gitkeep": "" });
    const serve = await serveRepo(root);
    const events = await ready(serve);
    await writeFiles(root, { "src/prime.ts": ts("@state Prime") });
    await events.graph((graph) => hasNode(graph, "Prime"), { since: events.received.length });
    const since = events.received.length;
    const rewrite = async (path: string) => {
      const full = join(root, path);
      await writeFile(full, await readFile(full, "utf8").catch(() => ""));
    };

    await rewrite(".everypath/graph.json");
    await rewrite(".everypath/history.jsonl");
    await writeFiles(root, {
      ".everypath/graph.json.0f1e2d3c.tmp": "{}",
      ".everypath/review.json.0f1e2d3c.tmp": "{}",
      ".everypath/tla/result.json.0f1e2d3c.tmp": "{}",
      "everypath.properties.json.0f1e2d3c.tmp": "{}",
    });
    await delay(1_800);

    assert.deepEqual(events.received.slice(since), []);
    await writeFiles(root, { "src/settings.ts": SETTINGS_SOURCE });
    await events.graph((graph) => hasNode(graph, "設定"), { since });
  });

  it("writes and sends nothing for a rescan that changes nothing, and one graph event for an approval", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const events = await ready(serve);
    const graphFile = await readOutput(root, "graph.json");
    const historyFile = await readOutput(root, "history.jsonl");
    let since = events.received.length;

    const rescan = await request(serve, "POST", "/rescan");
    assert.ok(succeeded(rescan), `${rescan.status} ${rescan.text}`);
    await delay(1_000);

    assert.deepEqual(events.received.slice(since), []);
    assert.equal(await readOutput(root, "graph.json"), graphFile);
    assert.equal(await readOutput(root, "history.jsonl"), historyFile);

    since = events.received.length;
    const approved = await request(serve, "POST", reviewPath("Home"), { body: { note: "x" } });
    assert.ok(succeeded(approved), `${approved.status} ${approved.text}`);
    await delay(1_000);

    const sent = events.received.slice(since);
    assert.deepEqual(
      sent.map((event) => (event.type === "graph" ? event.reason : event.type)),
      ["approve"],
    );
  });

  const triggers: readonly {
    readonly file: string;
    readonly content: unknown;
    readonly seen: (graph: Graph) => boolean;
  }[] = [
    {
      file: ".everypath/review.json",
      content: {
        version: 1,
        approvals: {
          Home: { hash: sha1(HOME_SOURCE), at: "2026-10-21T04:50:00Z", by: "ci", note: "" },
        },
      },
      seen: (graph) => node(graph, "Home").status.reviewed,
    },
    {
      file: ".everypath/findings.json",
      content: {
        results: [
          {
            path: "src/home.ts",
            check_id: "demo.rule",
            extra: { message: "危険な呼び出し", severity: "ERROR" },
            start: { line: 1 },
          },
        ],
      },
      seen: (graph) => node(graph, "Home").status.vuln,
    },
    {
      file: "everypath.properties.json",
      content: {
        properties: [{ id: "never-login", kind: "never-reach", target: ["ログイン"] }],
      },
      seen: (graph) => graph.properties.some((p) => p.id === "never-login"),
    },
  ];
  for (const { file, content, seen } of triggers) {
    it(`rescans and broadcasts when ${file} changes`, async () => {
      const root = await makeRepo(small);
      const serve = await serveRepo(root);
      const events = await ready(serve);
      const since = events.received.length;

      await writeFiles(root, { [file]: JSON.stringify(content) });

      await events.graph(seen, { since });
    });
  }
});

/** A body sent in chunks with no Content-Length, so the server can only count what arrives. */
function chunkedRequest(
  serve: { readonly url: string },
  method: "POST" | "PUT",
  path: string,
  body: string,
): Promise<number> {
  const target = new URL(serve.url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        method,
        path,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    outgoing.on("error", reject);
    for (let at = 0; at < body.length; at += 64 * 1024)
      outgoing.write(body.slice(at, at + 64 * 1024));
    outgoing.end();
  });
}

describe("serve: request bodies", () => {
  const MiB = 1024 * 1024;

  it("answers 413 to a body over 1 MiB, with or without Content-Length, and records nothing", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const json = { "content-type": "application/json" };
    const note = JSON.stringify({ note: "x".repeat(2 * MiB) });
    const layout = JSON.stringify({ Home: { x: 1, y: 2, pad: "x".repeat(2 * MiB) } });

    assert.equal((await rawRequest(serve, "POST", reviewPath("Home"), json, note)).status, 413);
    assert.equal((await rawRequest(serve, "PUT", "/layout.json", json, layout)).status, 413);
    assert.equal(await chunkedRequest(serve, "POST", reviewPath("Home"), note), 413);

    assert.deepEqual((await readReview(root)).approvals, {});
    await assert.rejects(readOutput(root, "layout.json"), { code: "ENOENT" });
    assert.equal((await request(serve, "GET", "/graph.json")).status, 200);
  });

  it("answers 400 to a layout with a number that is not finite or a key that is no node", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);

    for (const raw of ['{"Home": {"x": 1e999, "y": 0}}', '{"Nope": {"x": 1, "y": 2}}']) {
      const reply = await request(serve, "PUT", "/layout.json", { raw });
      assert.equal(reply.status, 400, `${raw} -> ${reply.status} ${reply.text}`);
    }
    await assert.rejects(readOutput(root, "layout.json"), { code: "ENOENT" });
  });

  it("answers 400 to a note over 2,000 characters and accepts one of 2,000", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);

    const long = await request(serve, "POST", reviewPath("Home"), {
      body: { note: "あ".repeat(2_001) },
    });
    assert.equal(long.status, 400, long.text);
    assert.deepEqual((await readReview(root)).approvals, {});

    const fits = await request(serve, "POST", reviewPath("Home"), {
      body: { note: "😀".repeat(2_000) },
    });
    assert.ok(succeeded(fits), `${fits.status} ${fits.text}`);
  });
});

/** The response headers of a GET, without waiting for the body, which `/events` never ends. */
function headersOf(
  serve: { readonly url: string },
  path: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const outgoing = get(new URL(path, serve.url), (response) => {
      resolve({ status: response.statusCode, ...response.headers });
      outgoing.destroy();
    });
    outgoing.on("error", (error) => {
      if (!outgoing.destroyed) reject(error);
    });
  });
}

describe("serve: response headers", () => {
  it("sends nosniff on every response, and refuses framing and <base> on GET /", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);

    for (const path of ["/", "/graph.json", "/events", "/layout.json", "/nowhere"]) {
      const headers = await headersOf(serve, path);
      assert.equal(headers["x-content-type-options"], "nosniff", path);
    }
    const rescan = await request(serve, "POST", "/rescan");
    assert.equal(rescan.headers.get("x-content-type-options"), "nosniff");
    const viewer = await headersOf(serve, "/");
    assert.equal(viewer["content-security-policy"], "frame-ancestors 'none'; base-uri 'none'");
    assert.equal(viewer["x-frame-options"], "DENY");
  });
});

describe("serve: guards on state-changing requests", () => {
  const note = JSON.stringify({ note: "x" });
  const layout = JSON.stringify({ Home: { x: 1, y: 2 } });

  it("refuses a body whose Content-Type is not application/json", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const headerSets: Record<string, string>[] = [
      { "content-type": "text/plain" },
      { "content-type": "application/x-www-form-urlencoded" },
      {},
    ];

    for (const headers of headerSets) {
      for (const [method, path, body] of [
        ["POST", reviewPath("Home"), note],
        ["PUT", "/layout.json", layout],
      ] as const) {
        const reply = await rawRequest(serve, method, path, headers, body);
        assert.ok(
          reply.status === 400 || reply.status === 415,
          `${method} ${path} ${JSON.stringify(headers)} -> ${reply.status}`,
        );
      }
    }
    assert.deepEqual((await readReview(root)).approvals, {});
    await assert.rejects(readOutput(root, "layout.json"), { code: "ENOENT" });

    const json = { "content-type": "application/json; charset=utf-8" };
    const accepted = await rawRequest(serve, "POST", reviewPath("Home"), json, note);
    assert.ok(succeeded(accepted), `${accepted.status} ${accepted.text}`);
  });

  it("answers 403 to a Host other than localhost or 127.0.0.1", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const json = { "content-type": "application/json" };
    const hosts = ["evil.example", "localhost.evil.example", "127.0.0.1.evil.example"];

    for (const host of hosts) {
      for (const [method, path, body] of [
        ["POST", reviewPath("Home"), note],
        ["DELETE", reviewPath("Home"), ""],
        ["PUT", "/layout.json", layout],
        ["POST", "/rescan", ""],
        ["POST", "/check/tlc", ""],
      ] as const) {
        const reply = await rawRequest(serve, method, path, { ...json, host }, body);
        assert.equal(reply.status, 403, `${method} ${path} as ${host} -> ${reply.status}`);
      }
    }
    assert.deepEqual((await readReview(root)).approvals, {});
    await assert.rejects(readOutput(root, "layout.json"), { code: "ENOENT" });

    const port = new URL(serve.url).port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const reply = await rawRequest(serve, "POST", reviewPath("Home"), { ...json, host }, note);
      assert.ok(succeeded(reply), `${host} -> ${reply.status} ${reply.text}`);
    }
  });

  it("answers 403 to a state-changing request whose Origin is not this server", async () => {
    const root = await makeRepo(small);
    const serve = await serveRepo(root);
    const json = { "content-type": "application/json" };
    const port = Number(new URL(serve.url).port);
    const strangers = ["http://evil.example", "null", `http://localhost:${port + 1}`];

    for (const origin of strangers) {
      for (const [method, path, body] of [
        ["POST", reviewPath("Home"), note],
        ["DELETE", reviewPath("Home"), ""],
        ["PUT", "/layout.json", layout],
        ["POST", "/rescan", ""],
        ["POST", "/check/tlc", ""],
      ] as const) {
        const reply = await rawRequest(serve, method, path, { ...json, origin }, body);
        assert.equal(reply.status, 403, `${method} ${path} from ${origin} -> ${reply.status}`);
      }
    }
    assert.deepEqual((await readReview(root)).approvals, {});
    await assert.rejects(readOutput(root, "layout.json"), { code: "ENOENT" });

    for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
      const reply = await rawRequest(serve, "POST", reviewPath("Home"), { ...json, origin }, note);
      assert.ok(succeeded(reply), `${origin} -> ${reply.status} ${reply.text}`);
    }
  });
});

/** `GET /events` read by hand and left unread, as a viewer in a background tab or on a slow link. */
async function stalledEvents(base: string): Promise<{
  read(until: (events: readonly ServerFrame[]) => boolean): Promise<ServerFrame[]>;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = get(new URL("/events", base), (response) => {
      response.pause();
      resolve({
        read: (until) =>
          new Promise((done) => {
            const events: ServerFrame[] = [];
            let pending = "";
            response.setEncoding("utf8").on("data", (chunk: string) => {
              pending += chunk;
              for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
                events.push(JSON.parse(pending.slice("data: ".length, end)));
                pending = pending.slice(end + 2);
              }
              if (until(events)) done(events);
            });
            response.resume();
          }),
        close: () => outgoing.destroy(),
      });
    });
    outgoing.on("error", reject);
  });
}

type ServerFrame = { readonly type: string; readonly graph?: Graph };

describe("serve: an /events client that stops reading", () => {
  it("is sent no frames while its socket is full, then the latest graph once", async () => {
    const ids = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"];
    const files = Object.fromEntries(
      ids.map((id) => [`src/${id}.ts`, ts(`@state ${id}`, `@state-desc ${"x".repeat(500_000)}`)]),
    );
    const root = await makeRepo(files);
    const serve = await serveRepo(root);
    const stalled = await stalledEvents(serve.url);
    const approvals = ids.slice(0, 6);

    for (const id of approvals) {
      const reply = await request(serve, "POST", reviewPath(id), { body: { note: "x" } });
      assert.ok(succeeded(reply), `${reply.status} ${reply.text}`);
    }
    const allReviewed = (event: ServerFrame | undefined): boolean => {
      const graph = event?.graph;
      return graph !== undefined && approvals.every((id) => node(graph, id).status.reviewed);
    };
    const events = await stalled.read((received) => allReviewed(received.at(-1)));
    stalled.close();

    assert.ok(events.length < approvals.length + 1, `${events.length} frames`);
    assert.ok(allReviewed(events.at(-1)), "the last frame is the latest graph");
  });
});

describe("serve: prompt templates (docs/specs/viewer-panels.md condition 6)", () => {
  const kinds = [
    "draw-model",
    "explain-model",
    "fix-counterexample",
    "fix-drift",
    "propose-properties",
    "write-tests",
  ];

  it("serves every kind from templates/prompts, and a file in .everypath/templates over it", async () => {
    const root = await makeRepo({
      ...small,
      ".everypath/templates/write-tests.md": "{{TARGETS}} のテストを書いて",
      ".everypath/templates/unknown.md": "使われない",
    });
    const serve = await serveRepo(root);

    const reply = await request(serve, "GET", "/templates.json");
    assert.equal(reply.status, 200);
    const templates = reply.json() as Record<string, { text: string; source: string }>;
    assert.deepEqual(Object.keys(templates).sort(), kinds);
    assert.deepEqual(templates["write-tests"], {
      text: "{{TARGETS}} のテストを書いて",
      source: "override",
    });
    for (const kind of kinds.filter((k) => k !== "write-tests")) {
      const shipped = await readFile(join(repoRoot, "templates", "prompts", `${kind}.md`), "utf8");
      assert.deepEqual(templates[kind], { text: shipped, source: "default" }, kind);
    }
  });
});
