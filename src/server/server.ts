import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseStateName } from "../core/expr.js";
import { asText, errorMessage, isMissing, isRecord } from "../core/json.js";
import { runTlc, type TlcOutcome } from "../core/tla/run.js";
import type { Graph, HistoryEntry, Layout, StateName } from "../core/types.js";
import { readOutput, serializeGraph } from "../core/workspace.js";
import { watchRepository } from "./watch.js";
import { type JobResult, openWriter, type Writer } from "./writer.js";

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

/** At most one TLC run. It writes nothing itself: its record lands through the writer. */
type TlcLane =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly abort: AbortController; readonly finished: Promise<void> };

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

  const reviewer = await reviewerName(root);
  const http = createServer();
  const listening = await listen(http, port);
  const opening = openWriter(root, reviewer, (published) =>
    broadcast({ type: "graph", ...published }),
  );
  const watcher = watchRepository(root, () => {
    void opening.then((writer) => writer.submit({ kind: "rescan", reason: "watch" })).catch(report);
  });
  http.on("request", (request: IncomingMessage, response: ServerResponse) => {
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
   */
  function startTlc(writer: Writer): boolean {
    if (lane.kind === "running") return false;
    const abort = new AbortController();
    let open = true;
    const settle = (event: TlcEvent): void => {
      open = false;
      lane = { kind: "idle" };
      if (!abort.signal.aborted) broadcast(event);
    };
    broadcast({ type: "tlc", status: "running", states: null, message: null });
    const finished = runTlc(root, { signal: abort.signal })
      .then(async (outcome) => {
        if (outcome.kind !== "checked") return settle(tlcEvent(outcome));
        const landed = (): void => settle(tlcEvent(outcome));
        await writer.submit({ kind: "tlc-commit", run: outcome.record, landed });
      })
      .catch((error: unknown) => {
        if (!open) return report(error);
        settle({ type: "tlc", status: "error", states: null, message: errorMessage(error) });
      });
    lane = { kind: "running", abort, finished };
    return true;
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
      const body = parseApproval(await readJson(request));
      if (body === null) {
        return send(response, 400, '本文は {"note": 文字列, "hash"?: 文字列} にしてください');
      }
      return answer(response, await writer.submit({ kind: "approve", id, ...body }));
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
        const body = parseLayout(await readJson(request));
        if (body === null) {
          return send(response, 400, '本文は {ノード名: {"x": 数, "y": 数}} にしてください');
        }
        return answer(response, await writer.submit({ kind: "layout", body }));
      }
      case "POST /check/tlc":
        return startTlc(writer)
          ? send(response, 202, "")
          : send(response, 409, "全探索はすでに実行中です。終わってからもう一度実行してください");
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

  let closing: Promise<void> | null = null;
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

/** The body as JSON, or `undefined` when it is not JSON, which every parser below refuses. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseApproval(value: unknown): { note: string; hash: string | null } | null {
  if (!isRecord(value)) return null;
  const note = asText(value.note);
  const hash = value.hash === undefined ? null : asText(value.hash);
  if (note === null || (value.hash !== undefined && hash === null)) return null;
  return { note, hash };
}

/** Exactly `x` and `y` per node, so `GET /layout.json` gives back what was put. */
function parseLayout(value: unknown): Layout | null {
  if (!isRecord(value)) return null;
  const nodes: [string, { x: number; y: number }][] = [];
  for (const [id, point] of Object.entries(value)) {
    if (!isRecord(point) || Object.keys(point).length !== 2) return null;
    const { x, y } = point;
    if (typeof x !== "number" || typeof y !== "number") return null;
    nodes.push([id, { x, y }]);
  }
  return Object.fromEntries(nodes);
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

async function sendViewer(response: ServerResponse, uiPath: string): Promise<void> {
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
