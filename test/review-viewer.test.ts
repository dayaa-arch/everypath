import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { parseStateName } from "../src/core/expr.js";
import {
  conflictWarnings,
  foldReview,
  parseRecordFile,
  planChange,
  type ReviewChange,
} from "../src/core/review.js";
import { analyze } from "../src/core/scan.js";
import type { Graph } from "../src/core/types.js";
import { reviewSummary } from "../src/ui/facts.js";
import { toneOf } from "../src/ui/view.js";
import { makeRepo, node, ts } from "./helpers/repo.js";

// docs/specs/team-review.md condition 4: what the panel says about who approved a node and when,
// and how a node in conflict is drawn.

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const AT1 = "2026-10-22T01:00:00.000Z";
const AT2 = "2026-10-22T02:00:00.000Z";
const AT3 = "2026-10-22T03:00:00.000Z";
const time = (iso: string): string => new Date(iso).toLocaleString("ja-JP");

const SOURCES = {
  approved: ts("@state 承認済み"),
  changed: ts("@state 変更後"),
  conflict: ts("@state 食い違い", "@state-tested"),
  none: ts("@state 未承認"),
  nameless: ts("@state 名無し"),
  proven: ts("@state 証明済み", "@state-tested", "@state-require proof"),
};

type Written = { readonly name: string; readonly text: string };

/** A record as written on its own branch, by someone who saw only the records `seen`. */
function record(change: ReviewChange, ...seen: readonly Written[]): Written {
  const read = seen.map(({ name, text }) => parseRecordFile(name, text));
  const planned = planChange(foldReview({ files: read, legacy: null }).state, change);
  assert.ok(planned !== null);
  return planned;
}

const placed = (...records: readonly Written[]): Record<string, string> =>
  Object.fromEntries(records.map(({ name, text }) => [`.everypath/review/${name}`, text]));

function approve(id: string, hash: string, by: string, at: string, note = ""): ReviewChange {
  const parsed = parseStateName(id);
  assert.ok(parsed.ok);
  return { kind: "approve", node: parsed.value, hash, by, at, note };
}

function revoke(id: string, by: string, at: string): ReviewChange {
  const parsed = parseStateName(id);
  assert.ok(parsed.ok);
  return { kind: "revoke", node: parsed.value, by, at };
}

async function panelGraph(): Promise<Graph> {
  const base = record(approve("食い違い", "1".repeat(40), "base", AT1));
  const root = await makeRepo({
    "everypath.config.json": JSON.stringify({ proof: { tool: "dafny" } }),
    "src/approved.ts": SOURCES.approved,
    "src/changed.ts": SOURCES.changed,
    "src/conflict.ts": SOURCES.conflict,
    "src/none.ts": SOURCES.none,
    "src/nameless.ts": SOURCES.nameless,
    "src/proven.ts": SOURCES.proven,
    ".everypath/proofs.json": JSON.stringify({
      証明済み: {
        result: "passed",
        tool: "dafny",
        message: "",
        at: AT1,
        hash: sha1(SOURCES.proven),
      },
    }),
    ...placed(
      record(approve("承認済み", sha1(SOURCES.approved), "taro", AT1, "仕様確認済み")),
      record(approve("変更後", sha1("before the edit"), "hanako", AT2)),
      base,
      record(approve("食い違い", sha1(SOURCES.conflict), "taro", AT1), base),
      record(approve("食い違い", sha1("another text"), "hanako", AT2), base),
      record(revoke("食い違い", "jiro", AT3), base),
      record(approve("名無し", sha1(SOURCES.nameless), "", AT1)),
      record(approve("証明済み", sha1(SOURCES.proven), "taro", AT1)),
      record(approve("証明済み", sha1("another proof"), "hanako", AT2)),
    ),
  });
  return (await analyze(root)).graph;
}

const textOf = (rows: readonly (readonly [string, string])[], label: string): string[] =>
  rows.filter(([dt]) => dt === label).map(([, dd]) => dd);

describe("viewer: who approved a node and when", () => {
  it("shows the approver, the time and the note of an approved node, and only the revoke button", async () => {
    const summary = reviewSummary(node(await panelGraph(), "承認済み"));

    assert.equal(summary.alert, null);
    assert.deepEqual(textOf(summary.rows, "承認者"), ["taro"]);
    assert.deepEqual(textOf(summary.rows, "承認日時"), [time(AT1)]);
    assert.deepEqual(textOf(summary.rows, "メモ"), ["仕様確認済み"]);
    assert.deepEqual(
      { approve: summary.approve, revoke: summary.revoke },
      {
        approve: false,
        revoke: true,
      },
    );
  });

  it("says a changed node changed since, with the approver and 前回承認日時, and both buttons", async () => {
    const summary = reviewSummary(node(await panelGraph(), "変更後"));

    assert.equal(summary.alert, "承認時からの変更あり（hash 不一致）");
    assert.deepEqual(textOf(summary.rows, "承認者"), ["hanako"]);
    assert.deepEqual(textOf(summary.rows, "前回承認日時"), [time(AT2)]);
    assert.deepEqual(
      { approve: summary.approve, revoke: summary.revoke },
      {
        approve: true,
        revoke: true,
      },
    );
  });

  it("lists each record of a conflict with its approver, time and version, newest first", async () => {
    const graph = await panelGraph();
    const summary = reviewSummary(node(graph, "食い違い"));

    assert.match(summary.alert ?? "", /承認が食い違っています/);
    const records = textOf(summary.rows, "記録");
    assert.equal(records.length, 3, JSON.stringify(summary.rows));
    const [revoked, other, current] = records;
    for (const [text, parts] of [
      [revoked, ["jiro", "取り消し", time(AT3)]],
      [other, ["hanako", sha1("another text").slice(0, 7), "別の内容", time(AT2)]],
      [current, ["taro", sha1(SOURCES.conflict).slice(0, 7), "今の内容", time(AT1)]],
    ] as const) {
      for (const part of parts) assert.ok(text?.includes(part), `${part} in ${text}`);
    }
    assert.deepEqual(
      { approve: summary.approve, revoke: summary.revoke },
      {
        approve: true,
        revoke: true,
      },
    );
  });

  it("says a node without an approval is not approved, with only the approve button", async () => {
    const summary = reviewSummary(node(await panelGraph(), "未承認"));

    assert.equal(summary.alert, null);
    assert.deepEqual(textOf(summary.rows, "承認"), ["未承認"]);
    assert.deepEqual(
      { approve: summary.approve, revoke: summary.revoke },
      {
        approve: true,
        revoke: false,
      },
    );
  });

  it("names an empty approver 承認者不明", async () => {
    const summary = reviewSummary(node(await panelGraph(), "名無し"));

    assert.deepEqual(textOf(summary.rows, "承認者"), ["承認者不明"]);
  });
});

describe("viewer: the color of a conflict", () => {
  it("draws a node in conflict unreviewed, even with a passed proof", async () => {
    const graph = await panelGraph();

    assert.equal(toneOf(node(graph, "食い違い"), graph.properties), "unreviewed");
    assert.equal(node(graph, "証明済み").status.proof, "passed");
    assert.equal(toneOf(node(graph, "証明済み"), graph.properties), "unreviewed");
  });
});

describe("an unreadable record points at the file, not at approving again", () => {
  it("tells the reader to restore or delete the file in the panel and in scan's warning", async () => {
    const graph = await panelGraph();
    const approved = node(graph, "承認済み");
    const file = ".everypath/review/0123456789abcdef.jsonl";
    const review = {
      conflict: [
        { kind: "approve", hash: approved.hash, at: AT1, by: "taro", note: "" },
        { kind: "unreadable", file },
      ],
    } as const;

    const summary = reviewSummary({ ...approved, review });
    const [warned] = conflictWarnings(approved.id, review);

    for (const text of [summary.alert ?? "", warned?.message ?? ""]) {
      assert.ok(text.includes(file), text);
      assert.match(text, /git で元に戻すか消して/);
      assert.doesNotMatch(text, /承認し直すか取り消して/);
    }
  });
});
