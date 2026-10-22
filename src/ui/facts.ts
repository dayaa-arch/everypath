import type {
  Drift,
  Graph,
  NodeProof,
  PropertyResult,
  ReviewMark,
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

/** What the panel says about a node's approval, and which of the two buttons it offers. */
export type ReviewSummary = {
  /** The red line above the rows, or null when nothing needs a look. */
  readonly alert: string | null;
  /** `<dt>`/`<dd>` pairs, in order. */
  readonly rows: readonly (readonly [label: string, text: string])[];
  readonly approve: boolean;
  readonly revoke: boolean;
};

const who = (by: string): string => (by === "" ? "承認者不明" : by);

function describeMark(mark: ReviewMark, hash: string): string {
  switch (mark.kind) {
    case "approve": {
      const version = `版 ${mark.hash.slice(0, 7)}（${mark.hash === hash ? "今の内容" : "別の内容"}）`;
      const note = mark.note === "" ? "" : `「${mark.note}」`;
      return `${who(mark.by)} が${version}を承認・${formatTime(mark.at)}${note}`;
    }
    case "revoke":
      return `${who(mark.by)} が取り消し・${formatTime(mark.at)}`;
    case "unreadable":
      return `読めない記録 ${mark.file}`;
    default: {
      const _exhaustive: never = mark;
      return _exhaustive;
    }
  }
}

/**
 * The panel's approval rows (SPEC §12.2): who approved and when, the time of the last approval once
 * the files changed, and every live record of a conflict with its approver, time and version.
 */
export function reviewSummary(node: StateNode): ReviewSummary {
  const { review, status } = node;
  const buttons = { approve: !status.reviewed, revoke: review !== undefined };
  if (review === undefined) return { alert: null, rows: [["承認", "未承認"]], ...buttons };
  if ("approval" in review) {
    const { by, at, note } = review.approval;
    return {
      alert: status.reviewed ? null : "承認時からの変更あり（hash 不一致）",
      rows: [
        ["承認", status.reviewed ? "承認済み" : "承認後に変更あり"],
        ["承認者", who(by)],
        [status.reviewed ? "承認日時" : "前回承認日時", formatTime(at)],
        ...(note === "" ? [] : [["メモ", note] as const]),
      ],
      ...buttons,
    };
  }
  return {
    alert: "承認が食い違っています。内容を確かめて、承認し直すか取り消してください",
    rows: [
      ["承認", `食い違い（記録 ${review.conflict.length} 件）`],
      ...review.conflict.map((mark) => ["記録", describeMark(mark, node.hash)] as const),
    ],
    ...buttons,
  };
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
