import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseStateName } from "../src/core/expr.js";
import type { ReviewChange } from "../src/core/review.js";
import { analyze } from "../src/core/scan.js";
import type { Graph, StateName } from "../src/core/types.js";
import { writeReviewChange } from "../src/core/workspace.js";
import { makeRepo, node, runCli, ts } from "./helpers/repo.js";

// docs/specs/team-review.md conditions 2, 3, 5, 6 and 11, through the real git binary: what two
// branches that approve on their own make after `git merge` and `git merge-tree --write-tree`.

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const AT1 = "2026-10-22T01:00:00.000Z";
const AT2 = "2026-10-22T02:00:00.000Z";
const AT3 = "2026-10-22T03:00:00.000Z";
/** The two lines `everypath init` puts in `.gitignore` (decision 0003). */
const INIT_IGNORE = ".everypath/*\n!.everypath/review.json\n";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "tester",
  GIT_AUTHOR_EMAIL: "tester@example.com",
  GIT_COMMITTER_NAME: "tester",
  GIT_COMMITTER_EMAIL: "tester@example.com",
};

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitOk(root: string, ...args: string[]): string {
  const result = git(root, ...args);
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

async function gitRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await makeRepo({ ".gitignore": INIT_IGNORE, ...files });
  gitOk(root, "init", "-q", "-b", "main");
  commitAll(root, "base");
  return root;
}

function commitAll(root: string, message: string): void {
  gitOk(root, "add", "-A");
  gitOk(root, "commit", "-q", "--allow-empty", "-m", message);
}

function state(id: string): StateName {
  const parsed = parseStateName(id);
  assert.ok(parsed.ok, id);
  return parsed.value;
}

async function graphOf(root: string): Promise<Graph> {
  return (await analyze(root)).graph;
}

async function hashOf(root: string, id: string): Promise<string> {
  return node(await graphOf(root), id).hash;
}

/** On a new branch from `from`: `act`, then commit everything. */
async function onBranch(root: string, branch: string, from: string, act: () => Promise<unknown>) {
  gitOk(root, "checkout", "-q", "-b", branch, from);
  await act();
  commitAll(root, branch);
}

const approve = async (root: string, id: string, by: string, at: string, note = "") =>
  writeReviewChange(root, {
    kind: "approve",
    node: state(id),
    hash: await hashOf(root, id),
    by,
    at,
    note,
  } satisfies ReviewChange);

const revoke = (root: string, id: string, by: string, at: string) =>
  writeReviewChange(root, { kind: "revoke", node: state(id), by, at } satisfies ReviewChange);

/** Both merge paths: the server-side `merge-tree`, which reads no `.gitattributes`, then `merge`. */
function mergeClean(root: string, ours: string, theirs: string): void {
  gitOk(root, "merge-tree", "--write-tree", ours, theirs);
  gitOk(root, "checkout", "-q", ours);
  gitOk(root, "merge", "--no-edit", "-q", theirs);
  assert.equal(gitOk(root, "diff", "--name-only", "--diff-filter=U"), "", "no unmerged path");
}

function conflictOf(graph: Graph, id: string) {
  const review = node(graph, id).review;
  assert.ok(review !== undefined && "conflict" in review, `${id} is a conflict`);
  return review.conflict;
}

describe("review merge: two branches approve different nodes", () => {
  it("merge with no conflict on both merge paths, and both stay approved by their approvers", async () => {
    const root = await gitRepo({ "src/a.ts": ts("@state A"), "src/b.ts": ts("@state B") });

    await onBranch(root, "alice", "main", () => approve(root, "A", "alice", AT1));
    await onBranch(root, "bob", "main", () => approve(root, "B", "bob", AT2));
    mergeClean(root, "alice", "bob");

    const graph = await graphOf(root);
    for (const [id, by] of [
      ["A", "alice"],
      ["B", "bob"],
    ] as const) {
      const merged = node(graph, id);
      assert.equal(merged.status.reviewed, true, id);
      assert.ok(merged.review !== undefined && "approval" in merged.review, id);
      assert.equal(merged.review.approval.by, by);
    }
  });

  it("tracks the new record under the two init lines alone", async () => {
    const root = await gitRepo({ "src/a.ts": ts("@state A") });

    await approve(root, "A", "alice", AT1);

    const status = gitOk(root, "status", "--porcelain", "-uall");
    const added = status.split("\n").filter((line) => line.startsWith("?? .everypath/"));
    assert.equal(added.length, 1, status);
    assert.match(added[0] ?? "", /^\?\? \.everypath\/review\/[0-9a-f]{16}\.jsonl$/);
    const path = (added[0] ?? "").slice(3);
    assert.equal(git(root, "check-ignore", "-q", path).status, 1, "not ignored");
  });
});

describe("review merge: two branches disagree about one node", () => {
  const files = {
    "src/a/one.ts": ts("@state A"),
    "src/a/two.ts": ts("@state A"),
    "src/b.ts": ts("@state B"),
  };

  it("approvals of two texts merge cleanly into a conflict that no side wins, warned by scan and check", async () => {
    const root = await gitRepo(files);

    await onBranch(root, "alice", "main", async () => {
      await writeFile(join(root, "src/a/one.ts"), ts("@state A", "@state-desc alice"));
      await approve(root, "A", "alice", AT1);
    });
    const aliceHash = await hashOf(root, "A");
    await onBranch(root, "bob", "main", async () => {
      await writeFile(join(root, "src/a/two.ts"), ts("@state A", "@state-desc bob"));
      await approve(root, "A", "bob", AT2);
    });
    const bobHash = await hashOf(root, "A");
    mergeClean(root, "alice", "bob");

    const graph = await graphOf(root);
    const a = node(graph, "A");
    assert.deepEqual(
      { reviewed: a.status.reviewed, changed: a.status.changedSinceReview },
      { reviewed: false, changed: false },
    );
    assert.deepEqual(conflictOf(graph, "A"), [
      { kind: "approve", hash: bobHash, at: AT2, by: "bob", note: "" },
      { kind: "approve", hash: aliceHash, at: AT1, by: "alice", note: "" },
    ]);
    const warned = graph.warnings.filter((w) => w.message.includes("承認が食い違っています"));
    assert.equal(warned.length, 1);
    for (const command of ["scan", "check"]) {
      const result = runCli([command, root]);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.match(
        result.stderr,
        /A: 承認が食い違っています（.*alice.*bob|A: 承認が食い違っています（.*bob.*alice/,
      );
    }

    await approve(root, "A", "carol", AT3);
    const resolved = await graphOf(root);
    assert.equal(node(resolved, "A").status.reviewed, true);
    assert.equal(
      resolved.warnings.filter((w) => w.message.includes("承認が食い違っています")).length,
      0,
    );
  });

  it("an approval and a revocation of one node merge cleanly into a conflict, ended by a revoke", async () => {
    const root = await gitRepo(files);
    await approve(root, "A", "base", AT1);
    commitAll(root, "approve A");

    await onBranch(root, "alice", "main", () => revoke(root, "A", "alice", AT2));
    await onBranch(root, "bob", "main", () => approve(root, "A", "bob", AT3, "見直した"));
    mergeClean(root, "alice", "bob");

    const graph = await graphOf(root);
    assert.equal(node(graph, "A").status.reviewed, false);
    assert.deepEqual(conflictOf(graph, "A"), [
      { kind: "approve", hash: await hashOf(root, "A"), at: AT3, by: "bob", note: "見直した" },
      { kind: "revoke", at: AT2, by: "alice" },
    ]);

    await revoke(root, "A", "carol", AT3);
    assert.equal("review" in node(await graphOf(root), "A"), false);
  });
});

describe("review merge: the legacy review.json on a team that mixes versions", () => {
  const legacy = (approvals: Record<string, { hash: string; by: string; at: string }>) =>
    `${JSON.stringify(
      {
        version: 1,
        approvals: Object.fromEntries(
          Object.entries(approvals)
            .sort(([x], [y]) => (x < y ? -1 : 1))
            .map(([id, entry]) => [id, { ...entry, note: "" }]),
        ),
      },
      null,
      2,
    )}\n`;
  const A = ts("@state A");
  const B = ts("@state B");
  const C = ts("@state C");

  it("keeps a legacy approval revoked by a new everypath while an old one edits the file", async () => {
    const before = {
      A: { hash: sha1(A), by: "old", at: AT1 },
      B: { hash: sha1(B), by: "old", at: AT1 },
    };
    const root = await gitRepo({
      "src/a.ts": A,
      "src/b.ts": B,
      "src/c.ts": C,
      ".everypath/review.json": legacy(before),
    });
    const file = join(root, ".everypath/review.json");

    await onBranch(root, "new", "main", () => revoke(root, "A", "new", AT2));
    await onBranch(root, "old", "main", () =>
      writeFile(file, legacy({ ...before, C: { hash: sha1(C), by: "old", at: AT2 } })),
    );
    mergeClean(root, "new", "old");

    const merged = await graphOf(root);
    assert.equal("review" in node(merged, "A"), false, "A stays revoked");
    assert.equal(node(merged, "B").status.reviewed, true);
    assert.equal(node(merged, "C").status.reviewed, true);
    assert.deepEqual(
      merged.warnings.filter((w) => w.file === ".everypath/review.json"),
      [],
    );

    await writeFile(file, legacy({ ...before, A: { hash: sha1(A), by: "old", at: AT3 } }));
    const reapproved = await graphOf(root);
    assert.deepEqual(
      conflictOf(reapproved, "A").map((mark) => mark.kind),
      ["approve", "revoke"],
    );
    assert.equal(
      reapproved.warnings.filter((w) => w.file === ".everypath/review.json").length,
      1,
      "the mix of versions is warned",
    );
  });

  for (const style of ["merge", "diff3"]) {
    it(`reads both sides of a ${style}-style conflict that two old versions left in review.json`, async () => {
      const root = await gitRepo({
        "src/a.ts": A,
        "src/b.ts": B,
        ".everypath/review.json": legacy({
          A: { hash: "0".repeat(40), by: "base", at: AT1 },
          B: { hash: sha1(B), by: "base", at: AT1 },
        }),
      });
      const file = join(root, ".everypath/review.json");
      const rewrite = (by: string, at: string) =>
        writeFile(
          file,
          legacy({
            A: { hash: sha1(`${A}${by}`), by, at },
            B: { hash: sha1(B), by: "base", at: AT1 },
          }),
        );
      await onBranch(root, "alice", "main", () => rewrite("alice", AT2));
      await onBranch(root, "bob", "main", () => rewrite("bob", AT3));
      gitOk(root, "checkout", "-q", "alice");

      const merge = git(root, "-c", `merge.conflictStyle=${style}`, "merge", "--no-edit", "bob");

      assert.equal(merge.status, 1, "the old format conflicts in git");
      assert.match(await readFile(file, "utf8"), /^<<<<<<< /m);
      const scanned = runCli(["scan", root, "--json"]);
      assert.equal(scanned.status, 0, scanned.stderr);
      const graph = JSON.parse(scanned.stdout) as Graph;
      assert.equal(graph.warnings.filter((w) => w.file === ".everypath/review.json").length, 1);
      assert.deepEqual(
        conflictOf(graph, "A").map((mark) => (mark.kind === "approve" ? mark.by : mark.kind)),
        ["bob", "alice"],
      );
      assert.equal(node(graph, "B").status.reviewed, true);
    });
  }
});
