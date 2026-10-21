import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeRepo, writeFiles } from "./helpers/repo.js";

/**
 * A structural test: R-01 holds because writes to disk have two homes, and the server's writes go
 * through the queue instead of calling the writers itself. This reads the imports of `src/**` and
 * fails when a file reaches around that.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The only files allowed to write: `.everypath/` output and the TLC run directory. */
const WRITERS: ReadonlySet<string> = new Set(["core/workspace.ts", "core/tla/run.ts"]);

const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;

const WRITE_FUNCTIONS: ReadonlySet<string> = new Set([
  ...["writeFile", "appendFile", "rename", "rm", "mkdir", "mkdtemp", "copyFile", "unlink"],
  ...["createWriteStream", "rmdir", "cp", "truncate", "symlink", "link"],
  ...["writeFileSync", "appendFileSync", "renameSync", "rmSync", "mkdirSync", "mkdtempSync"],
  ...["copyFileSync", "unlinkSync", "rmdirSync", "cpSync", "truncateSync", "symlinkSync"],
  ...["linkSync"],
  /** A namespace of all of the above. */
  "promises",
]);

/** What `src/server/` must reach the disk through instead of calling directly. */
const SERVER_FORBIDDEN: ReadonlySet<string> = new Set(["writeWorkspace", "replaceFile", "scan"]);
const SERVER_FORBIDDEN_MODULE = /(?:^|\/)(?:workspace|scan)\.js$/;

type Import = {
  readonly module: string;
  /** Imported names, before any `as`. Type-only names are left out. */
  readonly names: readonly string[];
  /** `import * as x`, `import x` or `export *`: every export of the module, writers included. */
  readonly whole: boolean;
  readonly dynamic: boolean;
};

const STATIC_IMPORT = /^[ \t]*(?:import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function importsOf(source: string): Import[] {
  const code = withoutComments(source);
  const found: Import[] = [];
  for (const [, typeOnly, clause = "", module = ""] of code.matchAll(STATIC_IMPORT)) {
    if (typeOnly !== undefined) continue;
    const braces = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    const names = braces
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !part.startsWith("type "))
      .map((part) => part.split(/\s+as\s+/)[0] ?? part);
    const outside = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, "")
      .trim();
    found.push({ module, names, whole: outside !== "", dynamic: false });
  }
  for (const [, module = ""] of code.matchAll(DYNAMIC_IMPORT)) {
    found.push({ module, names: [], whole: true, dynamic: true });
  }
  return found;
}

/** Root-relative `/` paths of every `.ts` file under `directory`, sorted. */
async function sourcesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:ts|mts|cts|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .map((path) => path.replaceAll("\\", "/"))
    .sort();
}

type Finding = { readonly file: string; readonly message: string };

function fsWrites(file: string, imports: readonly Import[]): Finding[] {
  return imports
    .filter(({ module }) => FS_MODULE.test(module))
    .flatMap(({ module, names, whole, dynamic }) => [
      ...(whole
        ? [
            {
              file,
              message: `${dynamic ? "loads" : "imports the whole of"} ${module}, which includes the write functions`,
            },
          ]
        : []),
      ...names
        .filter((name) => WRITE_FUNCTIONS.has(name))
        .map((name) => ({ file, message: `imports ${name} from ${module}` })),
    ]);
}

function serverReaches(file: string, imports: readonly Import[]): Finding[] {
  if (!file.startsWith("server/")) return [];
  return imports.flatMap(({ module, names, whole }) => [
    ...(whole && SERVER_FORBIDDEN_MODULE.test(module)
      ? [{ file, message: `imports the whole of ${module}, which includes the writers` }]
      : []),
    ...names
      .filter((name) => SERVER_FORBIDDEN.has(name))
      .map((name) => ({ file, message: `imports ${name} from ${module}` })),
  ]);
}

async function inspect(directory: string): Promise<{
  readonly writers: readonly string[];
  readonly violations: readonly string[];
}> {
  const writers = new Set<string>();
  const violations: string[] = [];
  for (const file of await sourcesIn(directory)) {
    const imports = importsOf(await readFile(join(directory, file), "utf8"));
    const writes = fsWrites(file, imports);
    if (writes.length > 0) writers.add(file);
    const outside = WRITERS.has(file) ? [] : writes;
    for (const finding of [...outside, ...serverReaches(file, imports)]) {
      violations.push(`src/${finding.file}: ${finding.message}`);
    }
  }
  return { writers: [...writers], violations };
}

describe("single writer", () => {
  it("lets only src/core/workspace.ts and src/core/tla/run.ts write, and keeps src/server/ off the writers", async () => {
    const { writers, violations } = await inspect(SRC);

    assert.deepEqual(violations, []);
    assert.ok(writers.includes("core/workspace.ts"), "the detector sees the real writer");
  });
});

describe("single writer: the check fails on a planted violation", () => {
  async function inspectTree(files: Record<string, string>) {
    return (await inspect(await makeRepo(files))).violations;
  }

  it("flags a write function imported outside the two writers", async () => {
    const violations = await inspectTree({
      "core/scan.ts": 'import { readFile, writeFile } from "node:fs/promises";\n',
      "core/other.ts": 'import { rename as mv } from "fs";\n',
      "core/multi.ts": 'import {\n  stat,\n  type Dirent,\n  rm,\n} from "node:fs";\n',
      "core/sync.ts": 'import { writeFileSync } from "node:fs";\n',
    });

    assert.deepEqual(violations, [
      "src/core/multi.ts: imports rm from node:fs",
      "src/core/other.ts: imports rename from fs",
      "src/core/scan.ts: imports writeFile from node:fs/promises",
      "src/core/sync.ts: imports writeFileSync from node:fs",
    ]);
  });

  it("flags a whole-module, promises or dynamic import, which can reach every writer", async () => {
    const violations = await inspectTree({
      "core/a.ts": 'import * as fs from "node:fs/promises";\n',
      "core/b.ts": 'import fs from "node:fs";\n',
      "core/c.ts": 'import { promises } from "node:fs";\n',
      "core/d.ts": 'const { writeFile } = await import("node:fs/promises");\n',
      "core/e.ts": 'const fs = require("node:fs");\n',
    });

    assert.equal(violations.length, 5, violations.join("\n"));
  });

  it("flags src/server/ files that import writeWorkspace, replaceFile or scan", async () => {
    const violations = await inspectTree({
      "server/a.ts": 'import { writeWorkspace } from "../core/workspace.js";\n',
      "server/b.ts": 'import { analyze, scan } from "../core/scan.js";\n',
      "server/c.ts": 'import { replaceFile as put } from "../core/workspace.js";\n',
      "server/d.ts": 'import * as workspace from "../core/workspace.js";\n',
    });

    assert.deepEqual(violations, [
      "src/server/a.ts: imports writeWorkspace from ../core/workspace.js",
      "src/server/b.ts: imports scan from ../core/scan.js",
      "src/server/c.ts: imports replaceFile from ../core/workspace.js",
      "src/server/d.ts: imports the whole of ../core/workspace.js, which includes the writers",
    ]);
  });

  it("accepts the two writers, read-only imports, type imports and mentions in comments", async () => {
    const violations = await inspectTree({
      "core/workspace.ts":
        'import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";\n',
      "core/tla/run.ts": 'import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";\n',
      "core/json.ts": 'import { readFile, readdir, stat, watch } from "node:fs/promises";\n',
      "server/watch.ts":
        'import { watch } from "node:fs";\nimport { analyze } from "../core/scan.js";\n',
      "server/types.ts":
        'import type { writeFile } from "node:fs/promises";\nimport type { scan } from "../core/scan.js";\n',
      "core/notes.ts":
        '// import { writeFile } from "node:fs/promises";\n/* import { rm } from "node:fs"; */\n',
    });

    assert.deepEqual(violations, []);
  });

  it("reads files in nested directories and ignores files that are not TypeScript", async () => {
    const tree = await makeRepo({});
    await writeFiles(tree, {
      "server/deep/er/x.ts": 'import { unlink } from "node:fs/promises";\n',
      "server/readme.md": 'import { unlink } from "node:fs/promises";\n',
    });

    assert.deepEqual((await inspect(tree)).violations, [
      "src/server/deep/er/x.ts: imports unlink from node:fs/promises",
    ]);
  });
});
