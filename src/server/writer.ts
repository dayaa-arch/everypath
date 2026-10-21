import { scanWithHistory } from "../core/scan.js";
import type { TlcRecord } from "../core/tla/result.js";
import type { Graph, HistoryEntry, Layout, StateName } from "../core/types.js";
import { commitTlc, writeApproval, writeLayout } from "../core/workspace.js";

/**
 * Every write the server makes. Jobs run one at a time in submit order, so no two touch `.everypath/`
 * at once and `history.jsonl` never gets a line twice. A rescan that is still waiting absorbs any
 * rescan submitted after it, because it reads the disk only when it starts.
 */
export type Job =
  | { readonly kind: "rescan"; readonly reason: string }
  | {
      readonly kind: "approve";
      readonly id: StateName;
      readonly note: string;
      /** The hash the viewer showed. `null` approves the hash of the last graph. */
      readonly hash: string | null;
    }
  | { readonly kind: "revoke"; readonly id: StateName }
  | { readonly kind: "layout"; readonly body: Layout }
  | { readonly kind: "tlc-commit"; readonly run: TlcRecord };

/** `missing-node`: no node of that id in the last graph. `stale-hash`: the node changed since. */
export type JobResult = "done" | "missing-node" | "stale-hash";

/** A graph the writer wrote, its history line (`null` when no node or edge changed), and why. */
export type Published = {
  readonly graph: Graph;
  readonly diff: HistoryEntry | null;
  readonly reason: string;
};

export type Writer = {
  /** The last graph written: what `/graph.json` and the first event of `/events` show. */
  current(): Published;
  submit(job: Job): Promise<JobResult>;
  /** Refuses new jobs and waits for the submitted ones. */
  close(): Promise<void>;
};

/**
 * The only path from the server to the disk. Scans once before it resolves, so `current()` always
 * has a graph, and hands every later graph to `publish` in the order it was written. `reviewer` is the
 * `by` of each approval.
 */
export async function openWriter(
  root: string,
  reviewer: string,
  publish: (published: Published) => void,
): Promise<Writer> {
  const scanned = async (reason: string): Promise<Published> => {
    const { graph, history } = await scanWithHistory(root, { reason });
    return { graph, diff: history, reason };
  };
  let current = await scanned("serve");
  let tail: Promise<unknown> = Promise.resolve();
  let waitingRescan: Promise<JobResult> | null = null;
  let closed = false;

  const rescan = async (reason: string): Promise<JobResult> => {
    current = await scanned(reason);
    publish(current);
    return "done";
  };
  const nodeOf = (id: StateName) => current.graph.nodes.find((node) => node.id === id);

  async function perform(job: Job): Promise<JobResult> {
    switch (job.kind) {
      case "rescan":
        return rescan(job.reason);
      case "approve": {
        const node = nodeOf(job.id);
        if (node === undefined) return "missing-node";
        if (job.hash !== null && job.hash !== node.hash) return "stale-hash";
        const at = new Date().toISOString();
        await writeApproval(root, node.id, { hash: node.hash, at, by: reviewer, note: job.note });
        return rescan("approve");
      }
      case "revoke":
        if (nodeOf(job.id) === undefined) return "missing-node";
        await writeApproval(root, job.id, null);
        return rescan("revoke");
      case "layout":
        await writeLayout(root, job.body);
        return "done";
      case "tlc-commit":
        await commitTlc(root, job.run);
        return rescan("tlc");
    }
  }

  return {
    current: () => current,
    submit(job) {
      if (closed) return Promise.reject(new Error("サーバーを止めているので受け付けません"));
      if (job.kind === "rescan" && waitingRescan !== null) return waitingRescan;
      const result = tail.then(() => {
        if (job.kind === "rescan") waitingRescan = null;
        return perform(job);
      });
      tail = result.catch(() => undefined);
      if (job.kind === "rescan") waitingRescan = result;
      return result;
    },
    async close() {
      closed = true;
      await tail;
    },
  };
}
