import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { type OpenWatch, type Watcher, watchRepository } from "../src/server/watch.js";
import { makeRepo, ts } from "./helpers/repo.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/** Every watcher it opens fails at once, twice, as a watcher out of inotify watches can. */
function failingWatch(): OpenWatch {
  return () => {
    const handle = Object.assign(new EventEmitter(), { close: () => {} });
    setImmediate(() => {
      handle.emit("error", new Error("ENOSPC: System limit for number of file watchers reached"));
      handle.emit("error", new Error("ENOSPC: System limit for number of file watchers reached"));
    });
    return handle;
  };
}

async function watching(
  root: string,
  open: OpenWatch,
): Promise<{ changes(): number; warnings: string[]; watcher: Watcher }> {
  let changes = 0;
  const warnings: string[] = [];
  const watcher = watchRepository(root, () => changes++, {
    open,
    warn: (message) => warnings.push(message),
  });
  return { changes: () => changes, warnings, watcher };
}

describe("watch: a watcher that fails", () => {
  it("says so in Japanese, rescans once for what changed meanwhile, then polls with one loop", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A") });
    const { changes, warnings, watcher } = await watching(root, failingWatch());
    try {
      await delay(500);
      assert.equal(changes(), 1, "one rescan once the poll has its baseline");
      assert.equal(warnings.length, 1, warnings.join("\n"));
      assert.match(warnings[0] ?? "", JAPANESE);

      await writeFile(join(root, "src", "a.ts"), ts("@state A", "@state-next B"));
      await delay(3_500);

      assert.equal(changes(), 2, "one more rescan for one change");
    } finally {
      watcher.close();
    }
  });
});

type Recording = {
  readonly open: OpenWatch;
  /** Root-relative directory and whether recursively, in the order asked. */
  readonly opened: [string, boolean][];
  readonly closed: string[];
  /** What the system would say about `filename` changing inside `directory`. */
  fire(directory: string, filename: string): void;
};

function recordingWatch(root: string): Recording {
  const opened: [string, boolean][] = [];
  const closed: string[] = [];
  const listeners = new Map<string, (filename: string | null) => void>();
  return {
    opened,
    closed,
    open: (directory, recursive, listener) => {
      const name = relative(root, directory);
      opened.push([name, recursive]);
      listeners.set(name, listener);
      return Object.assign(new EventEmitter(), { close: () => closed.push(name) });
    },
    fire: (directory, filename) => listeners.get(directory)?.(filename),
  };
}

async function until(done: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`no ${what} within ${timeoutMs} ms`);
    await delay(20);
  }
}

describe("watch: which directories", () => {
  const tree = {
    "src/a.ts": ts("@state A"),
    "src/auth/login.ts": ts("@state ログイン"),
    "node_modules/pkg/index.js": "",
    ".git/objects/x": "",
    "generated/out/g.ts": "",
    "everypath.config.json": JSON.stringify({ ignore: ["generated/**"] }),
    ".everypath/review.json": "{}",
    ".everypath/tla/result.json": "{}",
    ".everypath/cache/x": "",
  };

  it("on Linux watches each directory the scan walks, without recursion, and none it skips", async () => {
    const root = await makeRepo(tree);
    const { open, opened } = recordingWatch(root);

    const watcher = watchRepository(root, () => {}, { platform: "linux", open, warn: () => {} });
    try {
      await until(() => opened.length >= 5, "five watchers");
      await delay(100);

      assert.deepEqual(opened.sort(), [
        ["", false],
        [".everypath", false],
        [".everypath/tla", false],
        ["src", false],
        ["src/auth", false],
      ]);
    } finally {
      watcher.close();
    }
  });

  it("on macOS and Windows watches the root once, recursively", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const root = await makeRepo(tree);
      const { open, opened } = recordingWatch(root);

      const watcher = watchRepository(root, () => {}, { platform, open, warn: () => {} });
      await delay(100);
      watcher.close();

      assert.deepEqual(opened, [["", true]], platform);
    }
  });

  it("on Linux watches a directory made after the start, and drops a removed one, before the rescan", async () => {
    const root = await makeRepo({ "src/a.ts": ts("@state A"), "src/old/b.ts": ts("@state B") });
    const { open, opened, closed, fire } = recordingWatch(root);
    const seenAtRescan: string[][] = [];
    const watcher = watchRepository(
      root,
      () =>
        seenAtRescan.push(
          opened.map(([directory]) => directory).filter((d) => !closed.includes(d)),
        ),
      { platform: "linux", open, warn: () => {} },
    );
    try {
      await until(() => opened.length >= 3, "watchers for the root, src and src/old");
      await mkdir(join(root, "src", "feature"));
      await rm(join(root, "src", "old"), { recursive: true });
      fire("src", "feature");
      fire("src", "old");
      await until(() => seenAtRescan.length >= 1, "a rescan");

      assert.deepEqual(seenAtRescan[0]?.sort(), ["", "src", "src/feature"]);
      assert.ok(opened.every(([, recursive]) => !recursive));
    } finally {
      watcher.close();
    }
  });
});
