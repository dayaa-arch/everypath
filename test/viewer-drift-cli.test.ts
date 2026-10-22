import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROPERTIES_FILE } from "../src/core/properties.js";
import { runCli } from "./helpers/repo.js";
import { exampleRepo, type FakeJavaScript, fakeJava, fixture } from "./helpers/tlc.js";

async function addProperty(root: string, definition: unknown): Promise<void> {
  const path = join(root, PROPERTIES_FILE);
  const file = JSON.parse(await readFile(path, "utf8"));
  file.properties.push(definition);
  await writeFile(path, JSON.stringify(file));
}

const NO_LOCK = { id: "no-lock", kind: "never-reach", target: ["ロック"] };

/** example/ plus `no-lock`, whose quick-check path ログイン → ロック takes `login_fail` with `retries==3` ignored. */
async function exampleWithNoLock(): Promise<string> {
  const root = await exampleRepo();
  await addProperty(root, NO_LOCK);
  return root;
}

async function checkTlc(root: string, script: FakeJavaScript) {
  const java = await fakeJava(script);
  return runCli(["check", "--tlc", root], root, java.env);
}

const allOk = async (): Promise<FakeJavaScript> => ({
  rules: [],
  otherwise: { output: await fixture("ok") },
});

const lineOf = (stdout: string, start: string): string | undefined =>
  stdout.split("\n").find((line) => line.startsWith(start));

describe("scan's summary counts (docs/specs/viewer-drift.md condition 7)", () => {
  it("counts dep edges as 依存 and the drift as 乖離", async () => {
    const root = await exampleRepo();
    const clean = runCli(["scan", root]);
    await appendFile(
      join(root, "src", "home.ts"),
      '\nexport const toReset = (router: { push(path: string): void }) => router.push("/reset");\n',
    );

    const drifted = runCli(["scan", root]);

    assert.match(clean.stderr, /、依存 5、乖離 0、警告 0（/);
    assert.match(drifted.stderr, /、依存 5、乖離 1、警告 0（/);
  });
});

describe("check and TLC's verdict on a quick-check violation (condition 7)", () => {
  it("prints the path as open only with guards ignored and exits 0 when TLC says ok on this model", async () => {
    const root = await exampleWithNoLock();

    const checked = await checkTlc(root, await allOk());
    const plain = runCli(["check", root]);

    assert.equal(checked.status, 0, checked.stdout);
    for (const result of [checked, plain]) {
      assert.ok(lineOf(result.stdout, "成立 no-lock [never-reach]"), result.stdout);
      assert.ok(
        result.stdout.includes("  ガードを無視したときだけの経路: ログイン →(login_fail) ロック"),
        result.stdout,
      );
      assert.match(result.stdout, /^ {2}TLC: 成立（47 状態）/m);
      assert.match(
        lineOf(result.stdout, "性質 ") ?? "",
        /ガードを無視したときだけの経路 1 件/,
        result.stdout,
      );
    }
  });

  it("lets only a TLC run in this check clear the exit code, never a stored result.json", async () => {
    const root = await exampleWithNoLock();
    await checkTlc(root, await allOk());

    const plain = runCli(["check", root]);

    assert.equal(plain.status, 1, plain.stdout);
    assert.match(plain.stderr, /この実行では TLC を走らせていないので終了コードに数えます/);
  });

  it("keeps counting it when the model has changed since TLC said ok", async () => {
    const root = await exampleWithNoLock();
    await checkTlc(root, await allOk());
    await addProperty(root, { id: "later", kind: "invariant", expr: "retries <= 2" });

    const plain = runCli(["check", root]);

    assert.equal(plain.status, 1, plain.stdout);
    assert.ok(lineOf(plain.stdout, "違反 no-lock [never-reach]"), plain.stdout);
    assert.ok(plain.stdout.includes("  ログイン →(login_fail) ロック"), plain.stdout);
    assert.match(plain.stdout, /^ {2}TLC: 成立（古いモデルに対する結果/m);
    assert.doesNotMatch(plain.stdout, /ガードを無視したときだけの経路/);
  });

  it("prints TLC's own trace with the values and exits 1 when TLC finds the violation too", async () => {
    const root = await exampleWithNoLock();
    const neverReach = await readFile(
      new URL("./fixtures/tlc-output-never-reach.txt", import.meta.url),
      "utf8",
    );

    const checked = await checkTlc(root, {
      rules: [{ when: "INVARIANT P4_no_lock", reply: { output: neverReach, exit: 12 } }],
      otherwise: { output: await fixture("ok") },
    });

    assert.equal(checked.status, 1, checked.stdout);
    assert.ok(lineOf(checked.stdout, "違反 no-lock [never-reach]"), checked.stdout);
    assert.match(checked.stdout, /^ {2}TLC: 違反（62 状態）$/m);
    assert.match(checked.stdout, /^ {2}7\. →\(login_fail\) ロック（authed=FALSE, retries=3）$/m);
  });

  it("says TLC could not decide it and keeps exit 1", async () => {
    const root = await exampleWithNoLock();

    const checked = await checkTlc(root, {
      rules: [],
      otherwise: { output: await fixture("parse-error"), exit: 150 },
    });

    assert.equal(checked.status, 1, checked.stdout);
    assert.ok(lineOf(checked.stdout, "違反 no-lock [never-reach]"), checked.stdout);
    assert.match(checked.stdout, /^ {2}TLC: エラー/m);
  });
});
