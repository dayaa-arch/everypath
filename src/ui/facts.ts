import type {
  Drift,
  Graph,
  NodeProof,
  PropertyResult,
  StateName,
  StateNode,
} from "../core/types.js";
import { isLiveViolation } from "../core/verdict.js";
import type { DriftDecision, DriftFix, Selection } from "./state.js";

// Reads of the graph and the selection that state.ts, view.ts, prompt.ts and render.ts share. It
// imports no module of src/ui at run time: state.ts imports prompt.ts, so prompt.ts cannot import
// state.ts back.

/** The properties the node's `violations` name that are live violations, in file order. */
export function liveViolations(graph: Graph, node: StateNode): readonly PropertyResult[] {
  return node.violations.flatMap((id) =>
    graph.properties.filter((property) => property.id === id && isLiveViolation(property)),
  );
}

/** The drifts a node's code makes: the node is where both the call and `@state-next` live. */
export function driftsFrom(graph: Graph, id: StateName): readonly Drift[] {
  return graph.drift.filter((drift) => drift.from === id);
}

/** The side the person chose for this drift, or null before they choose. */
export function fixOf(
  decisions: readonly DriftDecision[],
  drift: Pick<Drift, "from" | "to">,
): DriftFix | null {
  return decisions.find((d) => d.from === drift.from && d.to === drift.to)?.fix ?? null;
}

/** An ISO time in the viewer's locale, or as it was written when it does not read as a time. */
export function formatTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString("ja-JP");
}

const PROOF_WORDS: Readonly<Record<NodeProof["result"], string>> = {
  passed: "成功",
  failed: "失敗",
  pending: "検証待ち",
};

/**
 * The panel's 証明 row: the result, the tool and when it ran, then what the tool said. A stale result
 * is shown as what it was and said to be old, since the node's files changed after the tool ran.
 */
export function proofSummary(node: StateNode): {
  readonly summary: string;
  readonly message: string | null;
} {
  const { proof, status } = node;
  const required = status.requireProof && status.proof !== "passed" ? "（証明必須）" : "";
  if (proof === undefined) return { summary: `なし${required}`, message: null };
  const ran = `${proof.tool}、${formatTime(proof.at)}`;
  const word = PROOF_WORDS[proof.result];
  const summary = proof.stale
    ? `古い結果（前回は${word}。その後ファイルが変わりました。${ran}）${required}`
    : `${word}（${ran}）${required}`;
  return { summary, message: proof.message === "" ? null : proof.message };
}

/** The selected node ids, in the order they were picked. */
export function selectedIds(selection: Selection): readonly StateName[] {
  switch (selection.kind) {
    case "none":
      return [];
    case "node":
      return [selection.id];
    case "many":
      return selection.ids;
    default: {
      const _exhaustive: never = selection;
      return _exhaustive;
    }
  }
}
