import { asText, isRecord } from "./json.js";
import type { NodeProof, NodeStatus, ProofEntry, ScanWarning } from "./types.js";

/** `.everypath/proofs.json`: one entry per node id. `everypath prove` writes it, the scan reads it. */
export const PROOFS_FILE = ".everypath/proofs.json";

const RESULTS: readonly ProofEntry["result"][] = ["passed", "failed", "pending"];

const resultOf = (raw: unknown): ProofEntry["result"] | null =>
  RESULTS.find((result) => result === raw) ?? null;

function entryOf(raw: unknown): ProofEntry | null {
  if (!isRecord(raw)) return null;
  const result = resultOf(raw.result);
  const tool = asText(raw.tool);
  const message = asText(raw.message);
  const at = asText(raw.at);
  const hash = asText(raw.hash);
  if (result === null || tool === null || tool.trim() === "" || message === null) return null;
  if (at === null || Number.isNaN(Date.parse(at)) || hash === null || hash === "") return null;
  return { result, tool, message, at, hash };
}

/**
 * The file is a boundary: an entry of the wrong shape is a warning naming its id and is left out,
 * and the others are used. An id no node has is kept, since a node may come back.
 */
export function parseProofs(raw: unknown): {
  readonly entries: ReadonlyMap<string, ProofEntry>;
  readonly warnings: readonly ScanWarning[];
} {
  const warn = (message: string): ScanWarning => ({
    file: PROOFS_FILE,
    line: null,
    message,
    detail: null,
  });
  if (!isRecord(raw)) {
    return {
      entries: new Map(),
      warnings: [
        warn(`${PROOFS_FILE} は「状態の名前: 結果」のオブジェクトにしてください。使いません`),
      ],
    };
  }
  const entries = new Map<string, ProofEntry>();
  const warnings: ScanWarning[] = [];
  for (const [id, value] of Object.entries(raw)) {
    const entry = entryOf(value);
    if (entry === null) {
      warnings.push(
        warn(
          `${PROOFS_FILE} の「${id}」は result（passed、failed、pending）、tool、message、at（日時）、hash を持つオブジェクトにしてください。この項目は使いません`,
        ),
      );
    } else {
      entries.set(id, entry);
    }
  }
  return { entries, warnings };
}

/**
 * A node's proof from its entry and its current hash, as the approval is matched: an entry made from
 * other file contents is stale. A stale result is kept to be shown but counts as `pending`, so an old
 * pass never paints the node blue and an old failure never paints it red.
 */
export function proofOf(
  entry: ProofEntry | undefined,
  hash: string,
): { readonly status: NodeStatus["proof"]; readonly proof: NodeProof | null } {
  if (entry === undefined) return { status: "none", proof: null };
  const { hash: proved, ...shown } = entry;
  const stale = proved !== hash;
  return { status: stale ? "pending" : entry.result, proof: { ...shown, stale } };
}

/**
 * The text of proofs.json with `updates` set and every other key kept as it was, sorted by id so the
 * diff of a run shows only the nodes it ran. `existing` is the parsed file, `undefined` when absent.
 */
export function mergeProofs(
  existing: unknown,
  updates: ReadonlyMap<string, ProofEntry>,
): string | null {
  if (existing !== undefined && !isRecord(existing)) return null;
  const merged = new Map(Object.entries(existing ?? {}));
  for (const [id, entry] of updates) merged.set(id, entry);
  const sorted = [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
}
