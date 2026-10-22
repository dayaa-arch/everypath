import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseStateName } from "../core/expr.js";
import { asText, errorMessage, isMissing, isRecord } from "../core/json.js";
import { runTlc, summarizeTlc, type TlcOutcome, type TlcSummary } from "../core/tla/run.js";
import type { Graph, HistoryEntry, Layout, StateName } from "../core/types.js";
import { isRunning, readOutput, readServeRecord, serializeGraph } from "../core/workspace.js";
import { watchRepository } from "./watch.js";
import { alreadyServed, type JobResult, openWriter, STOPPING, type Writer } from "./writer.js";

/** Every SSE `data:` line. A viewer reads nothing from the server but these and the HTTP bodies. */
export type ServerEvent =
  | {
      readonly type: "graph";
      readonly graph: Graph;
      readonly diff: HistoryEntry | null;
      readonly reason: string;
    }
  | {
      readonly type: "tlc";
      readonly status: "running" | "done" | "error";
      readonly states: number | null;
      readonly message: string | null;
    };

type TlcEvent = Extract<ServerEvent, { readonly type: "tlc" }>;

/**
 * At most one TLC run. It writes nothing itself: its record lands through the writer. `finished`
 * settles when the run is over, whatever way, and never rejects.
 */
type TlcLane =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly abort: AbortController; readonly finished: Promise<void> };

/**
 * The body of `POST /check/tlc`. `start`: no body, a body that is not JSON or `{}` start a run and
 * answer at once. `wait`: wait for the open run, start one with `timeoutMs`, answer when it is settled.
 */
type CheckTlcBody =
  | { readonly kind: "start" }
  | { readonly kind: "wait"; readonly budget: { readonly timeoutMs?: number } };

export type RunningServer = {
  /** `http://127.0.0.1:<port>/`. */
  readonly url: string;
  /** Stops the watcher, every `/events` stream and a running TLC, then waits for the writes in flight. */
  close(): Promise<void>;
};

/**
 * `everypath serve`. Listens on 127.0.0.1 first, so a port in use fails before anything is scanned,
 * then scans and watches. `uiPath` is the viewer `GET /` hands out.
 */
export async function startServer({
  root,
  port,
  uiPath,
}: {
  readonly root: string;
  readonly port: number;
  readonly uiPath: string;
}): Promise<RunningServer> {
  const streams = new Set<Stream>();
  const broadcast = (event: ServerEvent): void => {
    let frame: string | undefined;
    for (const stream of streams) push(stream, event, () => (frame ??= eventFrame(event)));
  };
  let lane: TlcLane = { kind: "idle" };
  let closing: Promise<void> | null = null;

  // The writer's claim decides; this only names the holder before a shared --port fails to listen.
  const holder = await readServeRecord(root);
  if (holder !== null && isRunning(holder.pid)) throw alreadyServed(holder);
  const reviewer = await reviewerName(root);
  const http = createServer();
  const listening = await listen(http, port);
  const opening = openWriter(root, reviewer, listening, (published) =>
    broadcast({ type: "graph", ...published }),
  );
  const watcher = watchRepository(root, () => {
    void opening.then((writer) => writer.submit({ kind: "rescan", reason: "watch" })).catch(report);
  });
  /** A page served by this server sends one of these; any other page is someone else's. */
  const ownOrigins: ReadonlySet<string> = new Set(
    ["localhost", "127.0.0.1"].map((host) => `http://${host}:${listening}`),
  );
  http.on("request", (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("x-content-type-options", "nosniff");
    void opening
      .then((writer) => route(writer, request, response))
      .catch((error: unknown) => send(response, 500, errorMessage(error)));
  });
  const stopHttp = (): Promise<void> =>
    new Promise((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
  const writer = await opening.catch(async (error: unknown) => {
    watcher.close();
    await stopHttp();
    throw error;
  });

  /**
   * A run ends with one `done` or `error`. A checked run's record lands through the writer first, so
   * `done` means Model.tla and result.json are on disk, and the lane stays busy until then. The graph
   * with the verdicts follows `done`. A failure after that is the rescan's, so it goes to stderr.
   * `null` while a run is open. Otherwise the summary of the run this starts: it settles once the
   * rescan that publishes a checked run's verdicts is through the queue, and rejects if the run threw.
   */
  function startTlc(
    writer: Writer,
    budget: { readonly timeoutMs?: number } = {},
  ): Promise<TlcSummary> | null {
    if (lane.kind === "running") return null;
    const abort = new AbortController();
    let open = true;
    const settle = (event: TlcEvent): void => {
      open = false;
      lane = { kind: "idle" };
      if (!abort.signal.aborted) broadcast(event);
    };
    broadcast({ type: "tlc", status: "running", states: null, message: null });
    const settled = runTlc(root, { ...budget, signal: abort.signal })
      .then(async (outcome) => {
        if (outcome.kind !== "checked") {
          settle(tlcEvent(outcome));
        } else {
          const landed = (): void => settle(tlcEvent(outcome));
          await writer
            .submit({ kind: "tlc-commit", run: outcome.record, landed })
            .catch((error: unknown) => {
              if (open) throw error;
              report(error);
            });
        }
        return summarizeTlc(outcome);
      })
      .catch((error: unknown) => {
        settle({ type: "tlc", status: "error", states: null, message: errorMessage(error) });
        throw error;
      });
    lane = { kind: "running", abort, finished: settled.then(ignore, ignore) };
    return settled;
  }

  /** `start` answers 202 or 409 at once. `wait` answers 200 with the summary of its own run. */
  async function checkTlc(
    writer: Writer,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJson(request);
    if (body.kind === "too-large") return send(response, 413, TOO_LARGE);
    const parsed = parseCheckTlcBody(body.value);
    if (parsed === null) {
      return send(
        response,
        400,
        '本文は空か {"wait": true, "timeoutMs"?: 1 以上の整数（ミリ秒）} にしてください',
      );
    }
    if (parsed.kind === "start") {
      return startTlc(writer) !== null
        ? send(response, 202, "")
        : send(response, 409, "全探索はすでに実行中です。終わってからもう一度実行してください");
    }
    for (;;) {
      if (closing !== null) return send(response, 503, STOPPING);
      const run = startTlc(writer, parsed.budget);
      if (run !== null) return send(response, 200, JSON.stringify(await run), JSON_TYPE);
      if (lane.kind === "running") await lane.finished;
    }
  }

  function subscribe(writer: Writer, request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const stream: Stream = { response, missed: null };
    const send = (event: ServerEvent): void => push(stream, event, () => eventFrame(event));
    send({ type: "graph", graph: writer.current().graph, diff: null, reason: "connect" });
    if (lane.kind === "running")
      send({ type: "tlc", status: "running", states: null, message: null });
    response.on("drain", () => {
      const missed = stream.missed;
      stream.missed = null;
      if (missed?.tlc) send(missed.tlc);
      if (missed?.graph) send({ ...writer.current(), type: "graph", diff: null });
    });
    streams.add(stream);
    request.on("close", () => streams.delete(stream));
  }

  async function route(
    writer: Writer,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!LOCAL_HOST.test(request.headers.host ?? "")) {
      return send(response, 403, "localhost か 127.0.0.1 で開いてください");
    }
    const method = request.method ?? "GET";
    const origin = request.headers.origin;
    if (method !== "GET" && origin !== undefined && !ownOrigins.has(origin)) {
      return send(response, 403, "このサーバーが配ったページからだけ受け付けます");
    }
    if (method !== "GET" && !isJson(request)) {
      return send(response, 415, "Content-Type: application/json で送ってください");
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const review = /^\/review\/([^/]+)$/.exec(path)?.[1];
    if (review !== undefined && (method === "POST" || method === "DELETE")) {
      const id = nodeId(review);
      if (id === null) return answer(response, "missing-node");
      if (method === "DELETE") {
        return answer(response, await writer.submit({ kind: "revoke", id }));
      }
      const body = await readJson(request);
      if (body.kind === "too-large") return send(response, 413, TOO_LARGE);
      const approval = parseApproval(body.value);
      if (approval === null) {
        return send(
          response,
          400,
          `本文は {"note": ${NOTE_LIMIT} 文字までの文字列, "hash"?: 文字列} にしてください`,
        );
      }
      return answer(response, await writer.submit({ kind: "approve", id, ...approval }));
    }
    switch (`${method} ${path}`) {
      case "GET /":
        return sendViewer(response, uiPath);
      case "GET /graph.json":
        return send(response, 200, serializeGraph(writer.current().graph), JSON_TYPE);
      case "GET /events":
        return subscribe(writer, request, response);
      case "POST /rescan":
        return answer(response, await writer.submit({ kind: "rescan", reason: "rescan" }));
      case "GET /history.json":
        return send(
          response,
          200,
          recentHistory(await readOutput(root, "history.jsonl")),
          JSON_TYPE,
        );
      case "GET /layout.json":
        return send(response, 200, (await readOutput(root, "layout.json")) ?? "{}\n", JSON_TYPE);
      case "PUT /layout.json": {
        const body = await readJson(request);
        if (body.kind === "too-large") return send(response, 413, TOO_LARGE);
        const nodes = new Set<string>(writer.current().graph.nodes.map((node) => node.id));
        const layout = parseLayout(body.value, nodes);
        if (layout === null) {
          return send(
            response,
            400,
            '本文は {今の図にあるノード名: {"x": 有限の数, "y": 有限の数}} にしてください',
          );
        }
        return answer(response, await writer.submit({ kind: "layout", body: layout }));
      }
      case "POST /check/tlc":
        return checkTlc(writer, request, response);
      case "GET /tla/Model.tla": {
        const model = await readOutput(root, "tla/Model.tla");
        return model === null
          ? send(response, 404, "Model.tla はまだありません。全探索を実行すると作られます")
          : send(response, 200, model);
      }
      default:
        return send(response, 404, `${method} ${path} はありません`);
    }
  }

  return {
    url: `http://127.0.0.1:${listening}/`,
    close: () => {
      closing ??= (async () => {
        watcher.close();
        const running = lane.kind === "running" ? lane : null;
        running?.abort.abort();
        for (const stream of streams) stream.response.end();
        streams.clear();
        await stopHttp();
        await running?.finished;
        await writer.close();
      })();
      return closing;
    },
  };
}

const JSON_TYPE = "application/json; charset=utf-8";
const ignore = (): void => {};
const HISTORY_LIMIT = 200;

/** The last lines of `history.jsonl` as a JSON array, oldest first. A damaged line is left out. */
function recentHistory(jsonl: string | null): string {
  const entries: unknown[] = [];
  for (const line of (jsonl ?? "").split("\n").slice(-HISTORY_LIMIT - 1)) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return `${JSON.stringify(entries.slice(-HISTORY_LIMIT))}\n`;
}
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

function eventFrame(event: ServerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * One `/events` stream. `missed` is `null` while its socket takes frames. Once a write leaves the
 * socket full, frames are left out until `drain`, which sends the last TLC event left out and then
 * the current graph: a viewer that fell behind needs the latest state, not every step to it, and a
 * stream that never reads cannot make the server hold every graph for it.
 */
type Stream = { readonly response: ServerResponse; missed: Missed | null };
type Missed = { graph: boolean; tlc: TlcEvent | null };

/** `frame` serializes `event`, only once some stream takes it: a server with no viewer serializes nothing. */
function push(stream: Stream, event: ServerEvent, frame: () => string): void {
  if (stream.missed === null) {
    if (!stream.response.write(frame())) stream.missed = { graph: false, tlc: null };
  } else if (event.type === "graph") {
    stream.missed.graph = true;
  } else {
    stream.missed.tlc = event;
  }
}

/** A violation is a result, so `done`. Only a run that could not decide is an `error`. */
function tlcEvent(outcome: TlcOutcome): TlcEvent {
  switch (outcome.kind) {
    case "missing":
      return { type: "tlc", status: "error", states: null, message: outcome.guide.join("\n") };
    case "unmodeled":
      return { type: "tlc", status: "error", states: null, message: outcome.reason };
    case "checked": {
      const { states, error, typeOk } = outcome.record;
      return error !== null
        ? { type: "tlc", status: "error", states, message: error }
        : {
            type: "tlc",
            status: "done",
            states,
            message: typeOk === null ? null : "違反 TypeOK 変数が宣言した範囲を外れました",
          };
    }
  }
}

/** Rejects with a Japanese message for a port in use, the one failure a person can fix with `--port`. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      const inUse = "code" in error && error.code === "EADDRINUSE";
      reject(
        inUse
          ? new Error(`ポート ${port} は使用中です。--port で別の番号を指定してください`)
          : error,
      );
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(address !== null && typeof address === "object" ? address.port : port);
    });
  });
}

/** SPEC §6.2: `git config user.name`, else `$USER`, else empty. */
function reviewerName(root: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["config", "user.name"], { cwd: root }, (error, stdout) => {
      const name = error === null ? stdout.trim() : "";
      resolve(name !== "" ? name : (process.env.USER ?? ""));
    });
  });
}

/** A request body without this type cannot be sent by another site's page without asking first. */
function isJson(request: IncomingMessage): boolean {
  const type = request.headers["content-type"] ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function nodeId(segment: string): StateName | null {
  try {
    const parsed = parseStateName(decodeURIComponent(segment));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

const BODY_LIMIT = 1024 * 1024;
const TOO_LARGE = "本文は 1 MiB までにしてください";
/** In characters, so a note in Japanese gets as many as one in English. */
const NOTE_LIMIT = 2_000;

/**
 * The body as JSON (`undefined` when it is not JSON, which every parser below refuses), or
 * `too-large` past 1 MiB: from there the rest is read and dropped, never kept.
 */
function readJson(
  request: IncomingMessage,
): Promise<{ readonly kind: "json"; readonly value: unknown } | { readonly kind: "too-large" }> {
  if (Number(request.headers["content-length"] ?? 0) > BODY_LIMIT) {
    return Promise.resolve({ kind: "too-large" });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= BODY_LIMIT) {
        chunks.push(chunk);
        return;
      }
      request.off("data", take).off("end", finish);
      resolve({ kind: "too-large" });
    };
    const finish = (): void => {
      try {
        resolve({ kind: "json", value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ kind: "json", value: undefined });
      }
    };
    request.on("data", take).on("end", finish).on("error", reject);
  });
}

function parseApproval(value: unknown): { note: string; hash: string | null } | null {
  if (!isRecord(value)) return null;
  const note = asText(value.note);
  const hash = value.hash === undefined ? null : asText(value.hash);
  if (note === null || (value.hash !== undefined && hash === null)) return null;
  if ([...note].length > NOTE_LIMIT) return null;
  return { note, hash };
}

/**
 * Exactly `x` and `y` per node, both finite (`1e999` parses as Infinity), so `GET /layout.json`
 * gives back what was put. Every key is a node of the current graph.
 */
function parseLayout(value: unknown, nodes: ReadonlySet<string>): Layout | null {
  if (!isRecord(value)) return null;
  const points: [string, { x: number; y: number }][] = [];
  for (const [id, point] of Object.entries(value)) {
    if (!nodes.has(id) || !isRecord(point) || Object.keys(point).length !== 2) return null;
    const { x, y } = point;
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push([id, { x, y }]);
  }
  return Object.fromEntries(points);
}

/** An absent body, or `{}`, starts a run at once. */
function parseCheckTlcBody(value: unknown): CheckTlcBody | null {
  if (value === undefined) return { kind: "start" };
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return { kind: "start" };
  if (value.wait !== true || keys.some((key) => key !== "wait" && key !== "timeoutMs")) return null;
  const { timeoutMs } = value;
  if (timeoutMs === undefined) return { kind: "wait", budget: {} };
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return { kind: "wait", budget: { timeoutMs } };
}

const ANSWERS: Readonly<Record<JobResult, readonly [number, string]>> = {
  done: [204, ""],
  "missing-node": [404, "そのノードはありません"],
  "stale-hash": [
    409,
    "ノードが表示中の版から変わっています。最新の図を確かめてから承認してください",
  ],
};

function answer(response: ServerResponse, result: JobResult): void {
  const [status, body] = ANSWERS[result];
  send(response, status, body);
}

/** The viewer may not be framed by another page, nor have its relative URLs moved by a `<base>`. */
async function sendViewer(response: ServerResponse, uiPath: string): Promise<void> {
  response.setHeader("content-security-policy", "frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("x-frame-options", "DENY");
  try {
    send(response, 200, await readFile(uiPath, "utf8"), "text/html; charset=utf-8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    send(
      response,
      503,
      `ビューアがまだありません（${uiPath}）。npm run build で作ってから開き直してください`,
    );
  }
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function report(error: unknown): void {
  process.stderr.write(`エラー: ${errorMessage(error)}\n`);
}
