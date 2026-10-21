import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Graph, HistoryEntry } from "../src/core/types.js";

/**
 * Drives `everypath serve` from outside: a child process, `fetch` and a small SSE reader. The R-05
 * row of `verify-requirements.ts` and the server tests share it, so both measure the same thing.
 */

const checkout = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");
const DEFAULT_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 30_000;

export type GraphEvent = {
  readonly type: "graph";
  readonly graph: Graph;
  readonly diff: HistoryEntry | null;
  readonly reason?: string;
};

export type TlcEvent = {
  readonly type: "tlc";
  readonly status: "running" | "done" | "error";
  readonly states: number | null;
  readonly message: string | null;
};

export type ServerEvent = GraphEvent | TlcEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServerEvent(text: string): ServerEvent {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("an event must be a JSON object");
  if (raw.type === "graph") {
    const { graph, diff, reason } = raw;
    if (!isRecord(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error("a graph event must carry a graph with nodes and edges");
    }
    if (diff !== null && !isRecord(diff)) throw new Error("diff must be null or an object");
    return {
      type: "graph",
      graph: graph as Graph,
      diff: diff as HistoryEntry | null,
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }
  if (raw.type === "tlc") {
    const { status, states, message } = raw;
    if (status !== "running" && status !== "done" && status !== "error") {
      throw new Error(`unknown tlc status ${String(status)}`);
    }
    return {
      type: "tlc",
      status,
      states: typeof states === "number" ? states : null,
      message: typeof message === "string" ? message : null,
    };
  }
  throw new Error(`unknown event type ${String(raw.type)}`);
}

function describeEvent(event: ServerEvent): string {
  return event.type === "graph"
    ? `graph(nodes=${event.graph.nodes.length}, diff=${event.diff === null ? "null" : "set"})`
    : `tlc(${event.status})`;
}

type Waiter = {
  readonly since: number;
  readonly accepts: (event: ServerEvent) => boolean;
  readonly resolve: (event: ServerEvent) => void;
  readonly reject: (error: Error) => void;
};

export type WaitOptions = {
  /** Only events at this index of `received` or later count. Take it from `received.length`. */
  readonly since?: number;
  readonly timeoutMs?: number;
};

export type EventStream = {
  readonly status: number;
  readonly contentType: string | null;
  /** Every event so far, oldest first. */
  readonly received: readonly ServerEvent[];
  graph(
    match?: (graph: Graph, event: GraphEvent) => boolean,
    options?: WaitOptions,
  ): Promise<GraphEvent>;
  tlc(status: TlcEvent["status"], options?: WaitOptions): Promise<TlcEvent>;
  close(): void;
};

/** `GET /events`. Resolves once the response headers are in; events are collected from then on. */
export async function openEvents(base: string): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(new URL("/events", base), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (response.body === null || response.status !== 200) {
    controller.abort();
    throw new Error(`GET /events answered ${response.status}: ${await response.text()}`);
  }

  const received: ServerEvent[] = [];
  let waiters: Waiter[] = [];
  let ended: Error | null = null;

  const settle = (): void => {
    waiters = waiters.filter((waiter) => {
      const hit = received.findIndex(
        (event, index) => index >= waiter.since && waiter.accepts(event),
      );
      const event = received[hit];
      if (event !== undefined) waiter.resolve(event);
      else if (ended !== null) waiter.reject(ended);
      return event === undefined && ended === null;
    });
  };

  const handle = (block: string): void => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
    if (data.length === 0) return;
    try {
      received.push(parseServerEvent(data.join("\n")));
    } catch (error) {
      ended = new Error(`unreadable SSE data ${data.join("\n")}: ${String(error)}`);
    }
    settle();
  };

  void (async () => {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (reader !== undefined && ended === null) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending = (pending + decoder.decode(chunk.value, { stream: true })).replaceAll(
          "\r\n",
          "\n",
        );
        for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
          handle(pending.slice(0, end));
          pending = pending.slice(end + 2);
        }
      }
      ended ??= new Error("the event stream closed");
    } catch (error) {
      ended ??= new Error(`the event stream failed: ${String(error)}`);
    }
    settle();
  })();

  const wait = (
    accepts: (event: ServerEvent) => boolean,
    what: string,
    { since = 0, timeoutMs = DEFAULT_TIMEOUT_MS }: WaitOptions,
  ): Promise<ServerEvent> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((waiter) => waiter !== entry);
        const seen = received.slice(since).map(describeEvent).join(", ") || "none";
        reject(new Error(`no ${what} within ${timeoutMs} ms; events since ${since}: ${seen}`));
      }, timeoutMs);
      const entry: Waiter = {
        since,
        accepts,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      waiters.push(entry);
      settle();
    });

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    received,
    async graph(match = () => true, options = {}) {
      const event = await wait(
        (candidate) => candidate.type === "graph" && match(candidate.graph, candidate),
        "matching graph event",
        options,
      );
      if (event.type !== "graph") throw new Error("a graph waiter resolved with a tlc event");
      return event;
    },
    async tlc(status, options = {}) {
      const event = await wait(
        (candidate) => candidate.type === "tlc" && candidate.status === status,
        `tlc ${status} event`,
        options,
      );
      if (event.type !== "tlc") throw new Error("a tlc waiter resolved with a graph event");
      return event;
    },
    close: () => controller.abort(),
  };
}

export type ServeOptions = {
  /** The repository to serve. */
  readonly directory: string;
  /** The CLI entry. Defaults to `src/cli.ts` of this checkout. */
  readonly cli?: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
};

export type Exited = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type Running = {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<Exited>;
};

function start({ directory, cli, port = 0, env = process.env }: ServeOptions): Running {
  const entry = cli ?? join(checkout, "src", "cli.ts");
  const child = spawn(
    process.execPath,
    ["--import", tsx, entry, "serve", directory, "--port", String(port)],
    { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<Exited>((resolve) => {
    child.on("error", (error) => resolve({ status: null, stdout, stderr: `${stderr}${error}` }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

export type Serve = {
  /** The first stdout line, trimmed. */
  readonly firstLine: string;
  readonly url: string;
  stderr(): string;
  stop(): Promise<void>;
};

async function stopChild({ child, exited }: Running): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(killer);
}

function originOf(line: string): string {
  try {
    return new URL(line).origin;
  } catch {
    throw new Error(`the first stdout line is not a URL: ${JSON.stringify(line)}`);
  }
}

/** Starts `everypath serve <directory> --port <port>` and waits for its URL line. */
export async function launchServe(options: ServeOptions): Promise<Serve> {
  const running = start(options);
  const { child, stdout, stderr, exited } = running;
  try {
    const firstLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no URL on stdout within ${STARTUP_TIMEOUT_MS} ms`)),
        STARTUP_TIMEOUT_MS,
      );
      const look = (): void => {
        const newline = stdout().indexOf("\n");
        if (newline === -1) return;
        clearTimeout(timer);
        resolve(stdout().slice(0, newline).trim());
      };
      child.stdout?.on("data", look);
      void exited.then(({ status }) => {
        clearTimeout(timer);
        reject(
          new Error(
            `everypath serve exited with ${status} before printing a URL\nstdout: ${stdout()}\nstderr: ${stderr()}`,
          ),
        );
      });
    });
    const origin = originOf(firstLine);
    return { firstLine, url: origin, stderr, stop: () => stopChild(running) };
  } catch (error) {
    await stopChild(running);
    throw error;
  }
}

/** For a `serve` that must refuse to start: its exit status and output, killed after `timeoutMs`. */
export async function serveUntilExit(options: ServeOptions, timeoutMs = 30_000): Promise<Exited> {
  const running = start(options);
  const timer = setTimeout(() => running.child.kill("SIGKILL"), timeoutMs);
  const result = await running.exited;
  clearTimeout(timer);
  return result;
}

export function hasFlow(graph: Graph, from: string, to: string): boolean {
  return graph.edges.some((edge) => edge.type === "flow" && edge.from === from && edge.to === to);
}
