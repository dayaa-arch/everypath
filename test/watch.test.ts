import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
