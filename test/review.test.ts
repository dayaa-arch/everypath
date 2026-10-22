import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseStateName } from "../src/core/expr.js";
import { foldReview, parseRecordFile, planChange, type ReviewChange } from "../src/core/review.js";
import { analyze } from "../src/core/scan.js";
import type { Graph, ScanWarning, StateName } from "../src/core/types.js";
import { serializeGraph, writeReviewChange } from "../src/core/workspace.js";
import { makeRepo, node, runCli, ts, writeFiles } from "./helpers/repo.js";

// docs/specs/team-review.md conditions 5 to 9: what a scan makes of `.everypath/review/` and the
// legacy `.everypath/review.json`, and what a write adds.

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

const A = ts("@state A");
const B = ts("@state B");
const C = ts("@state C");
const AT1 = "2026-10-22T01:00:00.000Z";
const AT2 = "2026-10-22T02:00:00.000Z";
const AT3 = "2026-10-22T03:00:00.000Z";
const NOW = new Date("2026-10-22T09:00:00.000Z");
const REVIEW = ".everypath/review";

function state(id: string): StateName {
  const parsed = parseStateName(id);
  assert.ok(parsed.ok, id);
  return parsed.value;
}

const approve = (id: string, hash: string, by: string, at = AT1, note = ""): ReviewChange => ({
  kind: "approve",
  node: state(id),
  hash,
  by,
  at,
  note,
});
const revoke = (id: string, by: string, at = AT2): ReviewChange => ({
  kind: "revoke",
  node: state(id),
  by,
  at,
});

type Written = { readonly path: string; readonly text: string };

/**
 * A record written as on another branch, whose author saw only the records `seen` and none written
 * beside it. Path to content.
 */
function concurrent(change: ReviewChange, ...seen: readonly Written[]): Written {
  const read = seen.map(({ path, text }) => parseRecordFile(path.slice(REVIEW.length + 1), text));
  const planned = planChange(foldReview({ files: read, legacy: null }).state, change);
  assert.ok(planned !== null, "the change writes a record");
  return { path: `${REVIEW}/${planned.name}`, text: planned.text };
}

function files(...records: readonly { readonly path: string; readonly text: string }[]) {
  return Object.fromEntries(records.map(({ path, text }) => [path, text]));
}

async function graphOf(root: string): Promise<Graph> {
  return (await analyze(root, { now: NOW })).graph;
}

async function records(root: string): Promise<string[]> {
  const names = await readdir(join(root, REVIEW)).catch(() => []);
  return names.filter((name) => name.endsWith(".jsonl")).sort();
}

const warningsAbout = (graph: Graph, file: string): ScanWarning[] =>
  graph.warnings.filter((warning) => warning.file === file);

const legacy = (approvals: Record<string, { hash: string; by: string; at: string }>) =>
  `${JSON.stringify(
    {
      version: 1,
      approvals: Object.fromEntries(
        Object.entries(approvals).map(([id, entry]) => [id, { ...entry, note: "" }]),
      ),
    },
    null,
    2,
  )}\n`;

describe("review: a write adds one record and never edits one", () => {
  it("approve writes one line named by its sha256, and revoke one more that names it", async () => {
    const root = await makeRepo({ "src/a.ts": A });

    assert.equal(
      await writeReviewChange(root, approve("A", sha1(A), "taro", AT1, "仕様確認済み")),
      "written",
    );
    const [first, ...others] = await records(root);
    assert.ok(first !== undefined && others.length === 0, "exactly one record");
    assert.match(first, /^[0-9a-f]{16}\.jsonl$/);
    const text = await readFile(join(root, REVIEW, first), "utf8");
    assert.ok(text.endsWith("\n") && !text.slice(0, -1).includes("\n"), "one line");
    const line = text.slice(0, -1);
    assert.equal(sha256(line).slice(0, 16), first.slice(0, 16));
    assert.deepEqual(Object.keys(JSON.parse(line)), [
      ...["v", "kind", "node", "hash", "by", "at", "note", "supersedes"],
    ]);
    const approved = node(await graphOf(root), "A");
    assert.equal(approved.status.reviewed, true);
    assert.deepEqual(approved.review, {
      approval: { hash: sha1(A), at: AT1, by: "taro", note: "仕様確認済み" },
    });

    assert.equal(await writeReviewChange(root, revoke("A", "hanako", AT2)), "written");
    const after = await records(root);
    assert.equal(after.length, 2);
    assert.equal(await readFile(join(root, REVIEW, first), "utf8"), text, "the first is untouched");
    const second = after.find((name) => name !== first) ?? "";
    const revocation = JSON.parse(await readFile(join(root, REVIEW, second), "utf8"));
    assert.deepEqual(Object.keys(revocation), ["v", "kind", "node", "by", "at", "supersedes"]);
    assert.deepEqual(revocation.supersedes, [first.slice(0, 16)]);
    const revoked = node(await graphOf(root), "A");
    assert.equal(revoked.status.reviewed, false);
    assert.equal(revoked.status.changedSinceReview, false);
    assert.equal("review" in revoked, false);
  });

  it("writes nothing to revoke a node with no approval, or to repeat the same approval", async () => {
    const root = await makeRepo({ "src/a.ts": A, "src/b.ts": B });

    assert.equal(await writeReviewChange(root, revoke("B", "taro")), "unchanged");
    assert.deepEqual(await records(root), []);
    await writeReviewChange(root, approve("A", sha1(A), "taro", AT1, "ok"));
    assert.equal(
      await writeReviewChange(root, approve("A", sha1(A), "taro", AT2, "ok")),
      "unchanged",
    );
    assert.equal((await records(root)).length, 1);
    assert.equal(
      await writeReviewChange(root, approve("A", sha1(A), "taro", AT3, "見直した")),
      "written",
    );

    const review = node(await graphOf(root), "A").review;
    assert.deepEqual(review, {
      approval: { hash: sha1(A), at: AT3, by: "taro", note: "見直した" },
    });
  });

  it("keeps .everypath/.gitignore with !review/ and review/*.tmp, a person's lines included", async () => {
    const root = await makeRepo({
      "src/a.ts": A,
      "src/b.ts": B,
      ".everypath/.gitignore": "# mine\nscratch/\n",
    });

    await writeReviewChange(root, approve("A", sha1(A), "taro"));
    const kept = await readFile(join(root, ".everypath/.gitignore"), "utf8");
    await writeReviewChange(root, approve("B", sha1(B), "taro"));

    assert.equal(kept, "# mine\nscratch/\n!review/\nreview/*.tmp\n");
    assert.equal(await readFile(join(root, ".everypath/.gitignore"), "utf8"), kept);
  });

  it("refuses in Japanese to write through a link at .everypath/review, and writes nothing outside", async () => {
    const outside = await makeRepo({});
    const root = await makeRepo({ "src/a.ts": A });
    await mkdir(join(root, ".everypath"), { recursive: true });
    await symlink(outside, join(root, REVIEW));

    await assert.rejects(writeReviewChange(root, approve("A", sha1(A), "taro")), (error: Error) =>
      JAPANESE.test(error.message),
    );
    assert.deepEqual(await readdir(outside), []);
  });
});

describe("review: the legacy review.json is read and never written", () => {
  it("gives the flags and stats it gave before, and review.approval from its entries", async () => {
    const root = await makeRepo({
      "src/a.ts": A,
      "src/b.ts": B,
      "src/c.ts": C,
      ".everypath/review.json": legacy({
        A: { hash: sha1(A), by: "taro", at: AT1 },
        B: { hash: "deadbeef", by: "hanako", at: AT2 },
      }),
    });

    const graph = await graphOf(root);

    const flags = (id: string) => {
      const { reviewed, changedSinceReview } = node(graph, id).status;
      return { reviewed, changedSinceReview };
    };
    assert.deepEqual(flags("A"), { reviewed: true, changedSinceReview: false });
    assert.deepEqual(flags("B"), { reviewed: false, changedSinceReview: true });
    assert.deepEqual(flags("C"), { reviewed: false, changedSinceReview: false });
    assert.equal(graph.stats.unreviewed, 2);
    assert.deepEqual(node(graph, "A").review, {
      approval: { hash: sha1(A), at: AT1, by: "taro", note: "" },
    });
    assert.deepEqual(node(graph, "B").review, {
      approval: { hash: "deadbeef", at: AT2, by: "hanako", note: "" },
    });
    assert.equal("review" in node(graph, "C"), false);
    assert.deepEqual(graph.warnings, []);
  });

  it("keeps its bytes through approve and revoke, and a revoked legacy approval is gone", async () => {
    const text = legacy({ A: { hash: sha1(A), by: "taro", at: AT1 } });
    const root = await makeRepo({ "src/a.ts": A, "src/b.ts": B, ".everypath/review.json": text });

    await writeReviewChange(root, revoke("A", "hanako"));
    await writeReviewChange(root, approve("B", sha1(B), "hanako"));

    assert.equal(await readFile(join(root, ".everypath/review.json"), "utf8"), text);
    const graph = await graphOf(root);
    assert.equal("review" in node(graph, "A"), false);
    assert.equal(node(graph, "A").status.reviewed, false);
    assert.equal(node(graph, "B").status.reviewed, true);
    assert.equal((await records(root)).length, 2);
  });

  const ours = `    "A": { "hash": "${"a".repeat(40)}", "at": "${AT1}", "by": "taro", "note": "" }`;
  const theirs = `    "A": { "hash": "${"b".repeat(40)}", "at": "${AT2}", "by": "hanako", "note": "" }`;
  const base = `    "A": { "hash": "${"0".repeat(40)}", "at": "${AT1}", "by": "base", "note": "" },`;
  const shared = `    "B": { "hash": "${sha1(B)}", "at": "${AT1}", "by": "taro", "note": "" }`;
  const marked = (middle: readonly string[]) =>
    ["{", '  "version": 1,', '  "approvals": {', ...middle, `${shared}`, "  }", "}", ""].join("\n");
  const styles = {
    merge: marked(["<<<<<<< HEAD", `${ours},`, "=======", `${theirs},`, ">>>>>>> other"]),
    diff3: marked([
      "<<<<<<< HEAD",
      `${ours},`,
      "||||||| base",
      base,
      "=======",
      `${theirs},`,
      ">>>>>>> other",
    ]),
  };
  for (const [style, text] of Object.entries(styles)) {
    it(`reads both sides of ${style}-style conflict markers with one warning, and shows the disagreement`, async () => {
      const root = await makeRepo({ "src/a.ts": A, "src/b.ts": B, ".everypath/review.json": text });

      const graph = await graphOf(root);

      assert.equal(warningsAbout(graph, ".everypath/review.json").length, 1, style);
      const a = node(graph, "A");
      assert.equal(a.status.reviewed, false);
      assert.ok(a.review !== undefined && "conflict" in a.review, "A is a conflict");
      assert.deepEqual(
        a.review.conflict.map((mark) => (mark.kind === "approve" ? mark.by : mark.kind)),
        ["hanako", "taro"],
        "both sides, newest first, and never the base",
      );
      assert.deepEqual(node(graph, "B").review, {
        approval: { hash: sha1(B), at: AT1, by: "taro", note: "" },
      });
      assert.equal(runCli(["scan", root]).status, 0);
    });
  }

  it("is one warning when it is not JSON and has no markers, and approving still works", async () => {
    const root = await makeRepo({ "src/a.ts": A, ".everypath/review.json": "{ not json" });

    assert.equal(warningsAbout(await graphOf(root), ".everypath/review.json").length, 1);
    assert.equal(await writeReviewChange(root, approve("A", sha1(A), "taro")), "written");
    assert.equal(node(await graphOf(root), "A").status.reviewed, true);
  });
});

describe("review: an old and a new everypath on one team (graft 1)", () => {
  it("keeps a revoked legacy approval revoked when the old file is rewritten, and warns once it is approved again", async () => {
    const root = await makeRepo({
      "src/a.ts": A,
      "src/b.ts": B,
      "src/c.ts": C,
      ".everypath/review.json": legacy({
        A: { hash: sha1(A), by: "old", at: AT1 },
        B: { hash: sha1(B), by: "old", at: AT1 },
      }),
    });
    await writeReviewChange(root, revoke("A", "new", AT2));
    const entry = (hash: string, at: string) => ({ hash, at, by: "old", note: "" });
    const rewrite = (approvals: Record<string, unknown>) =>
      writeFile(
        join(root, ".everypath/review.json"),
        JSON.stringify({ approvals, version: 1 }, null, 4),
      );

    await rewrite({
      C: entry(sha1(C), AT1),
      B: entry(sha1(B), AT1),
      A: entry(sha1(A), AT1),
    });
    const rewritten = await graphOf(root);
    assert.equal("review" in node(rewritten, "A"), false, "the revocation still names it");
    assert.equal(node(rewritten, "B").status.reviewed, true);
    assert.equal(node(rewritten, "C").status.reviewed, true);
    assert.deepEqual(warningsAbout(rewritten, ".everypath/review.json"), []);

    await rewrite({ A: entry(sha1(A), AT3), B: entry(sha1(B), AT1) });
    const reapproved = await graphOf(root);
    const a = node(reapproved, "A");
    assert.equal(a.status.reviewed, false);
    assert.ok(a.review !== undefined && "conflict" in a.review);
    assert.deepEqual(
      a.review.conflict.map((mark) => mark.kind),
      ["approve", "revoke"],
    );
    const mixed = warningsAbout(reapproved, ".everypath/review.json");
    assert.equal(mixed.length, 1, JSON.stringify(reapproved.warnings));
    assert.match(mixed[0]?.message ?? "", /^A: /);
  });
});

describe("review: records this version cannot read close the node (graft 2)", () => {
  /** A hand-made record line under its own sha256 name. */
  function raw(body: Record<string, unknown>): { readonly path: string; readonly text: string } {
    const line = JSON.stringify(body);
    return { path: `${REVIEW}/${sha256(line).slice(0, 16)}.jsonl`, text: `${line}\n` };
  }
  const id = (record: { readonly path: string }) => record.path.slice(REVIEW.length + 1, -6);

  it("lets a newer record replace what it names, and never counts it as an approval", async () => {
    const first = concurrent(approve("A", sha1(A), "taro"));
    const newer = raw({
      v: 2,
      kind: "revoke",
      node: "A",
      by: "x",
      at: AT2,
      supersedes: [id(first)],
      reason: "a field this version does not know",
    });
    const beside = concurrent(approve("B", sha1(B), "taro"));
    const unknown = raw({ v: 1, kind: "endorse", node: "B", by: "x", at: AT2, supersedes: [] });
    const root = await makeRepo({
      "src/a.ts": A,
      "src/b.ts": B,
      ...files(first, newer, beside, unknown),
    });

    const graph = await graphOf(root);

    const a = node(graph, "A");
    assert.equal(a.status.reviewed, false);
    assert.equal("review" in a, false, "the approval it replaced stays replaced");
    const b = node(graph, "B");
    assert.equal(b.status.reviewed, false);
    assert.deepEqual(b.review, {
      conflict: [
        { kind: "approve", hash: sha1(B), at: AT1, by: "taro", note: "" },
        { kind: "unreadable", file: unknown.path },
      ],
    });
    assert.equal(warningsAbout(graph, newer.path).length, 1);
    assert.equal(warningsAbout(graph, unknown.path).length, 1);
  });

  it("blocks every approved node for a record whose node it cannot read, so a broken revocation reopens nothing", async () => {
    const approved = concurrent(approve("A", sha1(A), "taro", AT1));
    const other = concurrent(approve("B", sha1(B), "taro", AT1));
    // The revocation of A, cut short: its node and what it replaced are lost with it.
    const broken = { path: `${REVIEW}/${"f".repeat(16)}.jsonl`, text: '{"v":1,"kind":"rev' };
    const root = await makeRepo({
      "src/a.ts": A,
      "src/b.ts": B,
      "src/c.ts": C,
      ...files(approved, other, broken),
    });

    const graph = await graphOf(root);

    for (const id of ["A", "B"]) {
      const review = node(graph, id).review;
      assert.equal(node(graph, id).status.reviewed, false, id);
      assert.ok(review !== undefined && "conflict" in review, id);
      assert.deepEqual(review.conflict.at(-1), { kind: "unreadable", file: broken.path }, id);
    }
    assert.equal("review" in node(graph, "C"), false);
    assert.equal(warningsAbout(graph, broken.path).length, 1);
    assert.equal(runCli(["scan", root]).status, 0);
  });

  const blinds: readonly {
    readonly what: string;
    readonly file: string;
    readonly make: (root: string, outside: string) => Promise<void>;
  }[] = [
    {
      what: "a record that is not JSON",
      file: `${REVIEW}/${"1".repeat(16)}.jsonl`,
      make: (root) => writeFiles(root, { [`${REVIEW}/${"1".repeat(16)}.jsonl`]: "<<<<<<< HEAD\n" }),
    },
    {
      what: "a .jsonl whose name is not a record id",
      file: `${REVIEW}/copy.jsonl`,
      make: (root) =>
        writeFiles(root, { [`${REVIEW}/copy.jsonl`]: concurrent(approve("B", sha1(B), "x")).text }),
    },
    {
      what: "a record that is a link",
      file: `${REVIEW}/${"2".repeat(16)}.jsonl`,
      make: async (root, outside) => {
        await mkdir(join(root, REVIEW), { recursive: true });
        await symlink(join(outside, "x.jsonl"), join(root, REVIEW, `${"2".repeat(16)}.jsonl`));
      },
    },
    {
      what: "a record over 32 KiB",
      file: `${REVIEW}/${"3".repeat(16)}.jsonl`,
      make: (root) =>
        writeFiles(root, {
          [`${REVIEW}/${"3".repeat(16)}.jsonl`]: `${JSON.stringify({ v: 1, kind: "revoke", node: "B", by: "x".repeat(40_000), at: AT2, supersedes: [] })}\n`,
        }),
    },
    {
      what: "a .everypath/review that is a file",
      file: REVIEW,
      make: (root) => writeFiles(root, { [REVIEW]: "not a directory\n" }),
    },
  ];
  for (const { what, file, make } of blinds) {
    it(`blocks the legacy approval of B for ${what}, with one warning`, async () => {
      const outside = await makeRepo({ "x.jsonl": concurrent(approve("B", sha1(B), "x")).text });
      const root = await makeRepo({
        "src/b.ts": B,
        ".everypath/review.json": legacy({ B: { hash: sha1(B), by: "taro", at: AT1 } }),
      });
      await make(root, outside);

      const graph = await graphOf(root);

      const b = node(graph, "B");
      assert.equal(b.status.reviewed, false);
      assert.deepEqual(b.review, {
        conflict: [
          { kind: "approve", hash: sha1(B), at: AT1, by: "taro", note: "" },
          { kind: "unreadable", file },
        ],
      });
      const unread = warningsAbout(graph, file).filter((w) => !w.message.includes("食い違って"));
      assert.equal(unread.length, 1, JSON.stringify(graph.warnings));
    });
  }

  it("ignores names that are not records: temporary files, dotfiles, other extensions", async () => {
    const root = await makeRepo({
      "src/b.ts": B,
      ...files(concurrent(approve("B", sha1(B), "taro"))),
      [`${REVIEW}/${"4".repeat(16)}.jsonl.0f1e2d3c.tmp`]: "half",
      [`${REVIEW}/.DS_Store`]: "\0",
      [`${REVIEW}/README.md`]: "メモ\n",
    });

    const graph = await graphOf(root);

    assert.equal(node(graph, "B").status.reviewed, true);
    assert.deepEqual(graph.warnings, []);
  });
});

describe("review: agreeing, disagreeing and resolving", () => {
  it("shows the newest of two approvals of the same text, written on two branches", async () => {
    const root = await makeRepo({
      "src/a.ts": A,
      ...files(
        concurrent(approve("A", sha1(A), "taro", AT1)),
        concurrent(approve("A", sha1(A), "hanako", AT2)),
      ),
    });

    const a = node(await graphOf(root), "A");

    assert.equal(a.status.reviewed, true);
    assert.deepEqual(a.review, { approval: { hash: sha1(A), at: AT2, by: "hanako", note: "" } });
  });

  it("ends a conflict by approving the current text, or by revoking", async () => {
    const base = concurrent(approve("A", "1".repeat(40), "base", AT1));
    const root = await makeRepo({
      "src/a.ts": A,
      ...files(
        base,
        concurrent(approve("A", "0".repeat(40), "taro", AT1), base),
        concurrent(approve("A", sha1(A), "hanako", AT2), base),
        concurrent(revoke("A", "jiro", AT3), base),
      ),
    });
    const before = node(await graphOf(root), "A");
    assert.ok(before.review !== undefined && "conflict" in before.review);
    assert.equal(before.review.conflict.length, 3);

    await writeReviewChange(root, approve("A", sha1(A), "saburo", AT3));
    const approved = node(await graphOf(root), "A");
    assert.equal(approved.status.reviewed, true);
    assert.deepEqual(approved.review, {
      approval: { hash: sha1(A), at: AT3, by: "saburo", note: "" },
    });

    await writeReviewChange(root, revoke("A", "saburo", AT3));
    assert.equal("review" in node(await graphOf(root), "A"), false);
  });

  it("warns once per conflicting node, naming who approved which version", async () => {
    const root = await makeRepo({
      "src/a.ts": A,
      ...files(
        concurrent(approve("A", "0".repeat(40), "taro", AT1)),
        concurrent(approve("A", sha1(A), "hanako", AT2)),
      ),
    });

    const graph = await graphOf(root);

    const conflicts = graph.warnings.filter((w) => w.message.includes("承認が食い違っています"));
    assert.equal(conflicts.length, 1);
    const message = conflicts[0]?.message ?? "";
    assert.match(message, /^A: /);
    for (const part of ["taro", "hanako", "0000000", sha1(A).slice(0, 7)]) {
      assert.ok(message.includes(part), `${part} in ${message}`);
    }
  });
});

describe("review: graph.json without approvals (condition 9)", () => {
  it("is the same with no record, an empty review.json and an empty review/, and has no review key", async () => {
    const sources = { "src/a.ts": A, "src/b.ts": B };
    const variants = [
      sources,
      { ...sources, ".everypath/review.json": JSON.stringify({ version: 1, approvals: {} }) },
      { ...sources, [`${REVIEW}/.gitkeep`]: "" },
    ];
    const texts: string[] = [];
    for (const variant of variants) {
      const graph = await graphOf(await makeRepo(variant));
      assert.ok(
        graph.nodes.every((n) => !("review" in n)),
        "no node has a review key",
      );
      texts.push(serializeGraph({ ...graph, root: "" }));
    }

    assert.equal(texts[1], texts[0]);
    assert.equal(texts[2], texts[0]);
  });
});

describe("review: reading again in the same process (graft 3)", () => {
  it("does not read a record it has read before, and reads a new one", async () => {
    const first = concurrent(approve("A", sha1(A), "taro"));
    const root = await makeRepo({ "src/a.ts": A, "src/b.ts": B, ...files(first) });
    assert.equal(node(await graphOf(root), "A").status.reviewed, true);

    await writeFile(join(root, first.path), "overwritten by hand\n");
    await writeFiles(root, files(concurrent(approve("B", sha1(B), "taro"))));
    const again = await graphOf(root);

    assert.equal(node(again, "A").status.reviewed, true, "the record was not read again");
    assert.equal(node(again, "B").status.reviewed, true, "the new record was read");
    const fresh = runCli(["scan", root, "--json"]);
    const graph = JSON.parse(fresh.stdout) as Graph;
    assert.equal(node(graph, "A").status.reviewed, false, "another process reads it afresh");
  });
});
