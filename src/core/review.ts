import { createHash } from "node:crypto";
import { parseStateName } from "./expr.js";
import { asText, errorMessage, isRecord } from "./json.js";
import type { Approval, NodeReview, ReviewMark, ScanWarning, StateName } from "./types.js";

// Approvals as a set of immutable records (decision 0004). Each approval or revocation is one file
// `.everypath/review/<id>.jsonl` that names the records its author saw and replaces (`supersedes`).
// A record is live when no other record supersedes it. Two branches that write without seeing each
// other only add different files, so git always merges them, and their records both stay live:
// a disagreement is a value this module computes, never a merge failure. Pure: no disk, no clock.

/** One approval or revocation per file. Files are created once and never edited or removed. */
export const REVIEW_DIRECTORY = ".everypath/review";
/** The single file of approvals before 0004. Read forever, never written again. */
export const LEGACY_REVIEW_FILE = ".everypath/review.json";
/** A record over this size is not read. A note of 2,000 characters fits many times over. */
export const RECORD_BYTE_LIMIT = 32 * 1024;
/**
 * What `.everypath/.gitignore` holds so git tracks the records under the root's `.everypath/*`
 * (decision 0003's two lines): `init` writes it, and so does every record write.
 */
export const REVIEW_GITIGNORE = {
  path: ".everypath/.gitignore",
  lines: ["!review/", "review/*.tmp"],
} as const;

/** The name of a record is the first 16 hex of the sha256 of its one line. */
const RECORD_NAME = /^([0-9a-f]{16})\.jsonl$/;
const RECORD_ID = /^[0-9a-f]{16}$/;

type RecordBase = {
  /** The file name without `.jsonl`. */
  readonly id: string;
  readonly node: StateName;
  /** The live records of the node its author saw, which it replaces. An id with no file names nothing. */
  readonly supersedes: readonly string[];
};
export type ApproveRecord = RecordBase & { readonly kind: "approve" } & Approval;
export type RevokeRecord = RecordBase & {
  readonly kind: "revoke";
  readonly at: string;
  readonly by: string;
};
/**
 * A record whose node this version reads but whose content it does not: a newer everypath wrote it
 * (`v` other than 1, a `kind` this version does not know) or a field has the wrong type. It replaces
 * what it names and stays live, and a live one keeps its node from being reviewed, so a decision this
 * version cannot read is never overridden unseen. Every version keeps `node` and `supersedes`.
 */
export type OpaqueRecord = RecordBase & { readonly kind: "opaque"; readonly file: string };
export type LiveRecord = ApproveRecord | RevokeRecord | OpaqueRecord;

/** One file of `.everypath/review/` as the reader made it out. */
export type RecordFile =
  | { readonly kind: "read"; readonly record: ApproveRecord | RevokeRecord }
  | { readonly kind: "opaque"; readonly record: OpaqueRecord; readonly reason: string }
  /** Not even its node can be read, so it may have replaced any approval: it blocks them all. */
  | { readonly kind: "blind"; readonly file: string; readonly reason: string };

/** What the records say. Ask `verdictOf`; do not walk it. */
export type ReviewState = {
  /** By node, the records no other record supersedes. */
  readonly live: ReadonlyMap<StateName, readonly LiveRecord[]>;
  /** Root-relative files whose node cannot be read, sorted. */
  readonly blind: readonly string[];
};

/** A person's act, as the server builds it. `planChange` decides what it replaces. */
export type ReviewChange =
  | ({ readonly kind: "approve"; readonly node: StateName } & Approval)
  | {
      readonly kind: "revoke";
      readonly node: StateName;
      readonly at: string;
      readonly by: string;
    };

/** The file a change becomes: `<id>.jsonl` and its one line. */
export type PlannedRecord = { readonly name: string; readonly text: string };

const warning = (file: string, message: string): ScanWarning => ({
  file,
  line: null,
  message,
  detail: null,
});

/** One line, keys in a fixed order, so equal records have equal ids on every machine. */
function encode(change: ReviewChange, supersedes: readonly string[]) {
  const { kind, node, at, by } = change;
  const line = JSON.stringify(
    change.kind === "approve"
      ? { v: 1, kind, node, hash: change.hash, by, at, note: change.note, supersedes }
      : { v: 1, kind, node, by, at, supersedes },
  );
  return { id: createHash("sha256").update(line).digest("hex").slice(0, 16), line };
}

function idsOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.flatMap((item) =>
    typeof item === "string" && RECORD_ID.test(item) ? [item] : [],
  );
  return ids.length === value.length ? ids : null;
}

function understand(
  raw: Record<string, unknown>,
  base: RecordBase,
): ApproveRecord | RevokeRecord | null {
  const at = asText(raw.at);
  const by = asText(raw.by);
  if (raw.v !== 1 || at === null || by === null) return null;
  if (raw.kind === "revoke") return { ...base, kind: "revoke", at, by };
  const hash = asText(raw.hash);
  const note = asText(raw.note);
  if (raw.kind !== "approve" || hash === null || note === null) return null;
  return { ...base, kind: "approve", hash, at, by, note };
}

/** A record file as read: `name` is its directory entry, `text` all of it. Never throws. */
export function parseRecordFile(name: string, text: string): RecordFile {
  const file = `${REVIEW_DIRECTORY}/${name}`;
  const id = RECORD_NAME.exec(name)?.[1];
  if (id === undefined) return blindFile(file, "名前が「16 桁の 16 進数.jsonl」ではありません");
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    return blindFile(file, `JSON として読めません（${errorMessage(error)}）`);
  }
  const node = isRecord(raw) ? parseStateName(asText(raw.node) ?? "") : null;
  if (!isRecord(raw) || node === null || !node.ok) {
    return blindFile(file, "node に状態の名前がありません");
  }
  const supersedes = idsOf(raw.supersedes);
  const base = { id, node: node.value, supersedes: supersedes ?? [] };
  const record = supersedes === null ? null : understand(raw, base);
  if (record !== null) return { kind: "read", record };
  return {
    kind: "opaque",
    record: { ...base, kind: "opaque", file },
    reason: "この版の everypath では読めない記録です（新しい版が書いたか、形が違います）",
  };
}

/** A file the reader refused or could not read at all: a link, a directory, too large. */
export function blindFile(file: string, reason: string): RecordFile {
  return { kind: "blind", file, reason };
}

/**
 * `[ours, theirs]` of a file git left with conflict markers, each side the file as that side wrote
 * it (diff3's base section belongs to neither). `null` when there are no well-formed markers.
 */
function conflictSides(text: string): readonly [string, string] | null {
  const sides: [string[], string[]] = [[], []];
  let place: "both" | "ours" | "base" | "theirs" = "both";
  let marked = false;
  for (const line of text.split("\n")) {
    const bare = line.trimEnd();
    if (bare.startsWith("<<<<<<<") && place === "both") {
      place = "ours";
      marked = true;
    } else if (bare.startsWith("|||||||") && place === "ours") place = "base";
    else if (bare === "=======" && (place === "ours" || place === "base")) place = "theirs";
    else if (bare.startsWith(">>>>>>>") && place === "theirs") place = "both";
    else {
      if (place === "both" || place === "ours") sides[0].push(line);
      if (place === "both" || place === "theirs") sides[1].push(line);
    }
  }
  return marked && place === "both" ? [sides[0].join("\n"), sides[1].join("\n")] : null;
}

/**
 * The legacy file's entries as records: the approval `planChange` would write for each, replacing
 * nothing, so a revocation written today names it by the same id on every machine. Both sides of
 * git's conflict markers are read. An entry is read as the old reader read it: a string `hash`.
 */
function legacyRecords(text: string) {
  const warnings: ScanWarning[] = [];
  const documents: unknown[] = [];
  try {
    documents.push(JSON.parse(text));
  } catch (error) {
    const sides = conflictSides(text);
    if (sides === null) {
      const reason = errorMessage(error);
      warnings.push(warning(LEGACY_REVIEW_FILE, `${LEGACY_REVIEW_FILE} を読めません: ${reason}`));
    } else {
      const unread = sides.filter((side) => {
        try {
          documents.push(JSON.parse(side));
          return false;
        } catch {
          return true;
        }
      }).length;
      warnings.push(
        warning(
          LEGACY_REVIEW_FILE,
          `${LEGACY_REVIEW_FILE} に git の衝突の印が残っています。両側の承認を読みました${unread === 0 ? "" : `（${unread} 側は JSON として読めないので使いません）`}。食い違う状態は承認し直すか取り消してください`,
        ),
      );
    }
  }
  const records = new Map<string, ApproveRecord>();
  for (const document of documents) {
    const approvals = isRecord(document) && isRecord(document.approvals) ? document.approvals : {};
    for (const [key, entry] of Object.entries(approvals)) {
      if (!isRecord(entry)) continue;
      const node = parseStateName(key);
      const hash = asText(entry.hash);
      if (!node.ok || hash === null) continue;
      const approval = {
        hash,
        at: asText(entry.at) ?? "",
        by: asText(entry.by) ?? "",
        note: asText(entry.note) ?? "",
      };
      const { id } = encode({ kind: "approve", node: node.value, ...approval }, []);
      records.set(id, { id, node: node.value, supersedes: [], kind: "approve", ...approval });
    }
  }
  return { records: [...records.values()], warnings };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** By node, so a graph is a function of the files and not of the order they were listed. */
function grouped(records: Iterable<LiveRecord>): Map<StateName, LiveRecord[]> {
  const live = new Map<StateName, LiveRecord[]>();
  for (const record of records) live.set(record.node, [...(live.get(record.node) ?? []), record]);
  for (const list of live.values()) list.sort((a, b) => compareText(a.id, b.id));
  return live;
}

/**
 * Every record and the legacy file folded into what is live. Never throws: each file it cannot use
 * is one warning naming it. Also warns about a node whose live legacy approval sits beside records of
 * `.everypath/review/`: an old everypath approved it after a new one wrote (graft 1). A legacy entry
 * loses to a new record only when that record supersedes it by id.
 */
export function foldReview(input: {
  readonly files: readonly RecordFile[];
  readonly legacy: string | null;
}): { readonly state: ReviewState; readonly warnings: readonly ScanWarning[] } {
  const warnings: ScanWarning[] = [];
  const records = new Map<string, LiveRecord>();
  const blind: string[] = [];
  for (const file of input.files) {
    if (file.kind === "blind") {
      blind.push(file.file);
      warnings.push(
        warning(
          file.file,
          `${file.file} を読めないので、承認のある状態をすべて食い違いとして扱います（${file.reason}）。git で元に戻すか消してください`,
        ),
      );
      continue;
    }
    records.set(file.record.id, file.record);
    if (file.kind === "opaque") {
      const { file: path, node } = file.record;
      warnings.push(warning(path, `${path}: ${file.reason}。「${node}」は承認済みにしません`));
    }
  }
  const newNodes = new Set([...records.values()].map((record) => record.node));
  const legacy = input.legacy === null ? null : legacyRecords(input.legacy);
  const fromLegacy = new Set<string>();
  for (const record of legacy?.records ?? []) {
    if (records.has(record.id)) continue;
    records.set(record.id, record);
    fromLegacy.add(record.id);
  }
  warnings.push(...(legacy?.warnings ?? []));

  const superseded = new Set([...records.values()].flatMap((record) => record.supersedes));
  const live = grouped([...records.values()].filter((record) => !superseded.has(record.id)));
  const mixed = [...live]
    .filter(([node, list]) => newNodes.has(node) && list.some((r) => fromLegacy.has(r.id)))
    .map(([node]) => node)
    .sort(compareText);
  for (const node of mixed) {
    warnings.push(
      warning(
        LEGACY_REVIEW_FILE,
        `${node}: 旧形式の ${LEGACY_REVIEW_FILE} の承認と ${REVIEW_DIRECTORY}/ の記録が並んでいます。古い everypath で承認していないか確かめ、承認し直すか取り消してください`,
      ),
    );
  }
  return { state: { live, blind: blind.sort(compareText) }, warnings };
}

/** Newest `at` first (a time that does not parse is oldest), then id: one order on every machine. */
function newestFirst(a: LiveRecord & { readonly at: string }, b: typeof a): number {
  const time = (at: string): number => {
    const parsed = Date.parse(at);
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  const [ta, tb] = [time(a.at), time(b.at)];
  return ta === tb ? compareText(a.id, b.id) : tb > ta ? 1 : -1;
}

function markOf(record: ApproveRecord | RevokeRecord): ReviewMark {
  const { kind, at, by } = record;
  return kind === "approve"
    ? { kind, hash: record.hash, at, by, note: record.note }
    : { kind, at, by };
}

/**
 * One node's review against its current `hash`, the only place it is decided. With no live approval
 * the node is not reviewed and gets no `review`. When every live record is an approval of one hash
 * and no file is blind, the newest is the `approval`. Anything else is a `conflict`, never reviewed.
 */
export function verdictOf(
  state: ReviewState,
  node: StateName,
  hash: string,
): {
  readonly reviewed: boolean;
  readonly changedSinceReview: boolean;
  readonly review?: NodeReview;
} {
  const live = state.live.get(node) ?? [];
  const timeline = live
    .filter((record): record is ApproveRecord | RevokeRecord => record.kind !== "opaque")
    .sort(newestFirst);
  const newest = timeline.find((record): record is ApproveRecord => record.kind === "approve");
  if (newest === undefined) return { reviewed: false, changedSinceReview: false };
  const unreadable = [
    ...live.flatMap((record) => (record.kind === "opaque" ? [record.file] : [])),
    ...state.blind,
  ].sort(compareText);
  const [first, second, ...rest]: ReviewMark[] = [
    ...timeline.map(markOf),
    ...unreadable.map((file) => ({ kind: "unreadable" as const, file })),
  ];
  const agreed = timeline.every((r) => r.kind === "approve" && r.hash === newest.hash);
  if (first === undefined || second === undefined || (agreed && unreadable.length === 0)) {
    const { hash: approved, at, by, note } = newest;
    const reviewed = approved === hash;
    return {
      reviewed,
      changedSinceReview: !reviewed,
      review: { approval: { hash: approved, at, by, note } },
    };
  }
  return {
    reviewed: false,
    changedSinceReview: false,
    review: { conflict: [first, second, ...rest] },
  };
}

/**
 * The record a change becomes, or `null` when it would change nothing. It replaces every live record
 * of the node and nothing else, so two changes made without seeing each other both stay live. A
 * blind file is never replaced: its node is unknown. Nothing to revoke, or the same person approving
 * the same text with the same note again, writes nothing.
 */
export function planChange(state: ReviewState, change: ReviewChange): PlannedRecord | null {
  const live = state.live.get(change.node) ?? [];
  if (change.kind === "revoke" && live.every((record) => record.kind === "revoke")) return null;
  if (change.kind === "approve") {
    const { reviewed, review } = verdictOf(state, change.node, change.hash);
    const shown = review !== undefined && "approval" in review ? review.approval : null;
    if (reviewed && shown?.by === change.by && shown.note === change.note) return null;
  }
  const { id, line } = encode(
    change,
    live.map((record) => record.id),
  );
  return { name: `${id}.jsonl`, text: `${line}\n` };
}

const who = (by: string): string => (by === "" ? "承認者不明" : by);

function describeMark(mark: ReviewMark): string {
  switch (mark.kind) {
    case "approve":
      return `${who(mark.by)} が版 ${mark.hash.slice(0, 7)} を承認`;
    case "revoke":
      return `${who(mark.by)} が取り消し`;
    case "unreadable":
      return `読めない記録 ${mark.file}`;
    default: {
      const _exhaustive: never = mark;
      return _exhaustive;
    }
  }
}

/** The warning `scan` and `check` print for a node in conflict. Derived from `review`, one source. */
export function conflictWarnings(id: StateName, review: NodeReview | undefined): ScanWarning[] {
  if (review === undefined || !("conflict" in review)) return [];
  const parts = review.conflict.map(describeMark).join("、");
  return [
    warning(
      REVIEW_DIRECTORY,
      `${id}: 承認が食い違っています（${parts}）。ビューアで内容を確かめ、承認し直すか取り消してください`,
    ),
  ];
}
