import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { after } from "node:test";
import {
  type EventStream,
  launchServe,
  openEvents,
  type Serve,
} from "../../scripts/serve-client.js";
import type { Approval, Graph, PropertyResult } from "../../src/core/types.js";
import { makeRepo } from "./repo.js";
import { type FakeJava, type FakeJavaScript, fixture, forExample } from "./tlc.js";

/** `user.name` in the HOME every served process gets, so the `by` of an approval is known. */
export const GIT_USER = "Taro Tester";

const servers: Serve[] = [];
const streams: EventStream[] = [];

after(async () => {
  for (const stream of streams) stream.close();
  await Promise.all(servers.map((serve) => serve.stop()));
});

/**
 * The environment of a served process: a HOME with a git identity and no `~/.everypath`, and a jar
 * path that does not exist, so no test depends on the machine's real TLC. `overrides` win.
 */
export async function serveEnv(overrides: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const home = await makeRepo({ ".gitconfig": `[user]\n\tname = ${GIT_USER}\n` });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    EVERYPATH_TLA_JAR: join(home, "absent", "tla2tools.jar"),
    ...overrides,
  };
}

/** The served process finds the fake `java` first and its dummy jar, and nothing else from this machine. */
export const javaEnv = (java: FakeJava): Promise<NodeJS.ProcessEnv> =>
  serveEnv({ PATH: java.env.PATH, EVERYPATH_TLA_JAR: java.jar });

export async function serveRepo(
  directory: string,
  env?: NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>,
): Promise<Serve> {
  const serve = await launchServe({ directory, env: await (env ?? serveEnv()) });
  servers.push(serve);
  return serve;
}

export async function connect(serve: Serve): Promise<EventStream> {
  const stream = await openEvents(serve.url);
  streams.push(stream);
  return stream;
}

/** Connected, with the event every client gets on connect already received. */
export async function ready(serve: Serve): Promise<EventStream> {
  const stream = await connect(serve);
  await stream.graph();
  return stream;
}

export type Reply = {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  json(): unknown;
};

export type Send = {
  /** Serialized as JSON. */
  readonly body?: unknown;
  /** Sent as is; wins over `body`. */
  readonly raw?: string;
  /** `content-type: application/json` is sent with every non-GET request unless this overrides it. */
  readonly headers?: Readonly<Record<string, string>>;
};

export async function request(
  serve: Serve,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  { body, raw, headers }: Send = {},
): Promise<Reply> {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const response = await fetch(new URL(path, serve.url), {
    method,
    headers: method === "GET" ? { ...headers } : { "content-type": "application/json", ...headers },
    ...(payload === undefined ? {} : { body: payload }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
}

/** Plain `node:http`, so a test can send a `Host` header or no `Content-Type` at all. */
export function rawRequest(
  serve: Serve,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  headers: Readonly<Record<string, string>>,
  body: string,
): Promise<{ readonly status: number; readonly text: string }> {
  const target = new URL(serve.url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        method,
        path,
        headers: { "content-length": String(Buffer.byteLength(body)), ...headers },
        timeout: 20_000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    outgoing.on("error", reject);
    outgoing.on("timeout", () => outgoing.destroy(new Error("no answer within 20 s")));
    outgoing.end(body);
  });
}

export const succeeded = (reply: { readonly status: number }): boolean =>
  reply.status >= 200 && reply.status < 300;

export const reviewPath = (id: string): string => `/review/${encodeURIComponent(id)}`;

/** The node hash SPEC §6.1 defines: sha1 of the node's file contents concatenated in order. */
export const sha1 = (...contents: string[]): string =>
  createHash("sha1").update(contents.join("")).digest("hex");

const OUTPUT = ".everypath";

/** The approval records under `.everypath/review/`, sorted by name. */
export async function reviewFiles(root: string): Promise<string[]> {
  const names = await readdir(join(root, OUTPUT, "review")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  return names.filter((name) => name.endsWith(".jsonl")).sort();
}

/** The approval the server's current graph shows for `id`, or undefined without one. */
export async function approvalOf(serve: Serve, id: string): Promise<Approval | undefined> {
  const graph = (await request(serve, "GET", "/graph.json")).json() as Graph;
  const review = graph.nodes.find((node) => node.id === id)?.review;
  return review !== undefined && "approval" in review ? review.approval : undefined;
}

export const readOutput = (root: string, ...path: string[]): Promise<string> =>
  readFile(join(root, OUTPUT, ...path), "utf8");

export function propertyOf(graph: Graph, id: string): PropertyResult {
  const found = graph.properties.find((property) => property.id === id);
  if (found === undefined) {
    throw new Error(`property ${id} is missing; have ${graph.properties.map((p) => p.id)}`);
  }
  return found;
}

/** `staleModel` is not in `PropertyResult` yet: absent, true or false as the result carries it. */
export function staleModelOf(result: PropertyResult): unknown {
  return "staleModel" in result ? result.staleModel : undefined;
}

export const hasNode = (graph: Graph, id: string): boolean =>
  graph.nodes.some((node) => node.id === id);

/**
 * TLC reports a violation of `no-unauth-home` (the 3-step counterexample of the example) and holds
 * everything else. `until` keeps every run waiting for that file.
 */
export async function violationRun(until?: string): Promise<FakeJavaScript> {
  const gate = until === undefined ? {} : { until };
  return {
    rules: [
      {
        when: "INVARIANT P1_no_unauth_home",
        reply: { output: forExample(await fixture("violation")), exit: 12, ...gate },
      },
    ],
    otherwise: { output: await fixture("ok"), ...gate },
  };
}
