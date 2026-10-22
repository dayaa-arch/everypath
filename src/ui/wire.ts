import type { Graph, HistoryEntry } from "../core/types.js";

/**
 * Copies of what the server sends and stores, so no module under `src/ui` imports `src/server`
 * (which pulls in `node:http`). `test/ui-wire.check.ts` fails `npm run typecheck` when a copy and
 * its original stop being the same type.
 */

/** `.everypath/layout.json`: where the viewer drew each node, by node id. Same as `core/types.ts`. */
export type Layout = Readonly<Record<string, { readonly x: number; readonly y: number }>>;

export type GraphEvent = {
  readonly type: "graph";
  readonly graph: Graph;
  readonly diff: HistoryEntry | null;
  readonly reason: string;
};

export type TlcEvent = {
  readonly type: "tlc";
  readonly status: "running" | "done" | "error";
  readonly states: number | null;
  readonly message: string | null;
};

/** Every SSE `data:` line. Same as `ServerEvent` in `src/server/server.ts`. */
export type ServerEvent = GraphEvent | TlcEvent;
