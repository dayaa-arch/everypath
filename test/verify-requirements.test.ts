import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "verify-requirements.ts");
const fixtures: string[] = [];

type Fixture = { packageJson?: unknown; uiHtml?: string };

async function makeRoot({ packageJson = { name: "fixture" }, uiHtml }: Fixture): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everypath-verify-"));
  fixtures.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
  if (uiHtml !== undefined) {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "ui.html"), uiHtml);
  }
  return root;
}

function verify(root: string, options: readonly string[] = []) {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, root, ...options], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

after(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("verify-requirements R-02", () => {
  it("passes when dependencies is absent", async () => {
    const root = await makeRoot({});
    const result = verify(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ok/);
  });

  it("passes when dependencies is empty", async () => {
    const root = await makeRoot({ packageJson: { name: "fixture", dependencies: {} } });
    assert.equal(verify(root).status, 0);
  });

  it("fails and names the dependency when one is declared", async () => {
    const root = await makeRoot({
      packageJson: { name: "fixture", dependencies: { "left-pad": "^1.0.0" } },
    });
    const result = verify(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /left-pad/);
  });

  it("fails when package.json is not valid JSON", async () => {
    const root = await makeRoot({});
    await writeFile(join(root, "package.json"), "{ not json");
    const result = verify(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package\.json/);
  });

  it("fails when ui.html loads a script from a CDN", async () => {
    const root = await makeRoot({
      uiHtml: '<html><script src="https://cdn.example.com/dagre.js"></script></html>',
    });
    const result = verify(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cdn\.example\.com/);
  });

  it("fails on a protocol-relative src", async () => {
    const root = await makeRoot({ uiHtml: '<img src="//cdn.example.com/a.png">' });
    const result = verify(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cdn\.example\.com/);
  });

  it("fails on a protocol-relative url()", async () => {
    const root = await makeRoot({
      uiHtml: "<style>a{background:url(//cdn.example.com/a.png)}</style>",
    });
    const result = verify(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cdn\.example\.com/);
  });

  it("passes when ui.html has no network references", async () => {
    const root = await makeRoot({
      uiHtml: "<html><style>a{color:red}</style><script>const x = 1 / 2; // half</script></html>",
    });
    const result = verify(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ok/);
  });

  it("skips the ui.html check when it is not built", async () => {
    const root = await makeRoot({});
    const result = verify(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /skip: dist\/ui\.html not built/);
  });
});

describe("verify-requirements R-05", () => {
  it("times ten saves against the real everypath serve and prints the slowest under 2,000 ms", () => {
    const result = verify(repoRoot, ["--only", "R-05"]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const slowest = /^ok: R-05 .*max (\d+) ms/m.exec(result.stdout);
    assert.ok(slowest, result.stdout);
    assert.ok(Number(slowest[1]) < 2_000, result.stdout);
  });

  it("skips in a directory that has no src/cli.ts to serve", async () => {
    const result = verify(await makeRoot({}), ["--only", "R-05"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skip: R-05 needs src\/cli\.ts/);
  });

  it("refuses an id that is not in the table", async () => {
    const result = verify(await makeRoot({}), ["--only", "R-99"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /R-99/);
  });
});
