import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { isScanInput } from "../core/workspace.js";

/** SPEC §11: the changes inside one window become one rescan. */
const WINDOW_MS = 250;
/** SPEC §11: where a tree cannot be watched. */
const POLL_MS = 1_500;

export type Watcher = { close(): void };

/**
 * Calls `onChange` after a change to anything a scan reads (`isScanInput`). The first change opens a
 * 250 ms window and every change inside it joins the same call: a window, not a debounce, so a file
 * rewritten every 100 ms still reaches the viewer. Where `fs.watch` cannot watch a tree, or fails later
 * (Linux running out of inotify watches), a 1.5 s poll of sizes and mtimes takes over for good.
 */
export function watchRepository(root: string, onChange: () => void): Watcher {
  let watcher: FSWatcher | null = null;
  let window: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let stopped = false;

  const pollFrom = (before: ReadonlyMap<string, string>): void => {
    poll = setTimeout(async () => {
      const after = await stamps(root);
      if (stopped) return;
      if (differs(before, after)) onChange();
      pollFrom(after);
    }, POLL_MS);
  };
  const fallBack = async (): Promise<void> => {
    watcher?.close();
    watcher = null;
    const first = await stamps(root);
    if (!stopped) pollFrom(first);
  };

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename !== null && !isScanInput(filename.split(sep).join("/"))) return;
      window ??= setTimeout(() => {
        window = null;
        onChange();
      }, WINDOW_MS);
    });
    watcher.on("error", () => void fallBack());
  } catch {
    void fallBack();
  }

  return {
    close() {
      stopped = true;
      watcher?.close();
      if (window !== null) clearTimeout(window);
      if (poll !== null) clearTimeout(poll);
    },
  };
}

/** `mtime:size` of every scan input under `root`. Never throws: what cannot be read is left out. */
async function stamps(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isScanInput(path, true)) await visit(path);
      } else if (entry.isFile() && isScanInput(path)) {
        const info = await stat(join(root, path)).catch(() => null);
        if (info !== null) found.set(path, `${info.mtimeMs}:${info.size}`);
      }
    }
  }
  await visit("");
  return found;
}

function differs(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): boolean {
  return (
    before.size !== after.size || [...after].some(([path, stamp]) => before.get(path) !== stamp)
  );
}
