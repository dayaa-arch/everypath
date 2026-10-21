import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { errorMessage } from "../core/json.js";
import { isScanInput } from "../core/workspace.js";

/** SPEC §11: the changes inside one window become one rescan. */
const WINDOW_MS = 250;
/** SPEC §11: where a tree cannot be watched. */
const POLL_MS = 1_500;

export type Watcher = { close(): void };

/** What `fs.watch` returns, as far as the watcher uses it. */
type Handle = { close(): void; on(event: "error", listener: (error: unknown) => void): unknown };

/** One `fs.watch` call. A test passes one that fails, which a real watcher does only under load. */
export type OpenWatch = (
  directory: string,
  recursive: boolean,
  listener: (filename: string | null) => void,
) => Handle;

export type WatchOptions = {
  readonly open?: OpenWatch;
  /** Where a watcher failure is said. Standard error by default. */
  readonly warn?: (message: string) => void;
};

const openFsWatch: OpenWatch = (directory, recursive, listener) =>
  watch(directory, { recursive }, (_event, filename) => listener(filename));

const toStderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * Calls `onChange` after a change to anything a scan reads (`isScanInput`). The first change opens a
 * 250 ms window and every change inside it joins the same call: a window, not a debounce, so a file
 * rewritten every 100 ms still reaches the viewer. Where `fs.watch` cannot watch a tree, or fails later
 * (Linux running out of inotify watches), it says so and a 1.5 s poll of sizes and mtimes takes over
 * for good, starting with one call for whatever changed before the poll took its first reading.
 */
export function watchRepository(
  root: string,
  onChange: () => void,
  { open = openFsWatch, warn = toStderr }: WatchOptions = {},
): Watcher {
  let watcher: Handle | null = null;
  let window: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let polling = false;
  let stopped = false;

  const pollFrom = (before: ReadonlyMap<string, string>): void => {
    poll = setTimeout(async () => {
      const after = await stamps(root);
      if (stopped) return;
      if (differs(before, after)) onChange();
      pollFrom(after);
    }, POLL_MS);
  };
  /** Once only: a watcher can fail more than once, and two poll loops would report every change twice. */
  const fallBack = async (error: unknown): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    watcher?.close();
    watcher = null;
    if (window !== null) clearTimeout(window);
    window = null;
    warn(
      `ファイルの監視が止まりました（${errorMessage(error)}）。${POLL_MS / 1000} 秒ごとの確認に切り替えます`,
    );
    const baseline = await stamps(root);
    if (stopped) return;
    onChange();
    pollFrom(baseline);
  };

  try {
    watcher = open(root, true, (filename) => {
      if (filename !== null && !isScanInput(filename.split(sep).join("/"))) return;
      window ??= setTimeout(() => {
        window = null;
        onChange();
      }, WINDOW_MS);
    });
    watcher.on("error", (error) => void fallBack(error));
  } catch (error) {
    void fallBack(error);
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
