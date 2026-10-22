import { request } from "node:http";
import { errorMessage, isRecord } from "../core/json.js";
import { parseTlcSummary } from "../core/tla/result.js";
import type { TlcSummary } from "../core/tla/run.js";
import type { Graph } from "../core/types.js";
import { isRunning, readServeRecord } from "../core/workspace.js";

/**
 * Where the CLI's writes go, decided once when it starts: to the `everypath serve` that owns the
 * directory (`serve.json` names a running process), or to the CLI itself.
 */
export type Route =
  | { readonly kind: "direct" }
  /** `http://127.0.0.1:<port>/`. */
  | { readonly kind: "server"; readonly url: string };

/**
 * What asking the running serve came to. `refused`: nothing listens on the recorded port, so the
 * record is stale and the caller writes itself. `failed` is every other trouble, as a Japanese
 * message: a server is there, so the caller must not write behind its back.
 */
export type Handoff<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly message: string };

/** The graph the serve holds: its exact text (what `GET /graph.json` sent) and the same, read. */
export type ServedGraph = { readonly text: string; readonly graph: Graph };

export async function findServer(root: string): Promise<Route> {
  const record = await readServeRecord(root);
  return record !== null && isRunning(record.pid)
    ? { kind: "server", url: `http://127.0.0.1:${record.port}/` }
    : { kind: "direct" };
}

/**
 * The serve's rescan, then its graph. The serve is the only writer, so this writes nothing; the
 * graph is the one it just wrote (or the newer one a request after it wrote).
 */
export async function handOffScan(url: string): Promise<Handoff<ServedGraph>> {
  const rescanned = await call(url, "POST", "/rescan");
  if (rescanned.kind !== "answered") return rescanned;
  const served = await call(url, "GET", "/graph.json");
  if (served.kind !== "answered") return served;
  const graph = parseJson(served.value);
  return readsAsGraph(graph)
    ? { kind: "answered", value: { text: served.value, graph } }
    : failed(url, "の /graph.json を読めません");
}

/** `check --tlc` in the serve's environment: waits for its own run, `timeoutMs` long if given. */
export async function handOffTlc(
  url: string,
  { timeoutMs }: { readonly timeoutMs?: number },
): Promise<Handoff<TlcSummary>> {
  const body = JSON.stringify({ wait: true, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const answered = await call(url, "POST", "/check/tlc", body);
  if (answered.kind !== "answered") return answered;
  const summary = parseTlcSummary(parseJson(answered.value));
  return summary === null
    ? failed(url, "の答えを読めません")
    : { kind: "answered", value: summary };
}

function failed(url: string, what: string): Handoff<never> {
  return { kind: "failed", message: `起動中の everypath serve（${url}）${what}` };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The server is our own, found through our own record, so its graph needs only a light look. */
function readsAsGraph(value: unknown): value is Graph {
  return (
    isRecord(value) &&
    ["nodes", "edges", "warnings", "properties"].every((key) => Array.isArray(value[key]))
  );
}

/**
 * One request to the serve at `url`, with `node:http` because it sets no time limit of its own: a
 * TLC wait takes minutes. A POST says it is JSON, which the server asks of every write. Every 2xx
 * answers with its body.
 */
function call(
  url: string,
  method: "GET" | "POST",
  path: string,
  body = "",
): Promise<Handoff<string>> {
  return new Promise((resolve) => {
    const target = new URL(path, url);
    const headers =
      method === "GET"
        ? {}
        : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers,
        agent: false,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
        response.on("error", (error) =>
          resolve(failed(url, `との通信が途切れました: ${errorMessage(error)}`)),
        );
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve(
            status >= 200 && status < 300
              ? { kind: "answered", value: text }
              : failed(url, `が ${status} を返しました: ${text.trim()}`),
          );
        });
      },
    );
    outgoing.on("error", (error) =>
      resolve(
        "code" in error && error.code === "ECONNREFUSED"
          ? { kind: "refused" }
          : failed(url, `と通信できません: ${errorMessage(error)}`),
      ),
    );
    outgoing.end(body);
  });
}
