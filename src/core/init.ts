import { appendFile, constants, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_FILE } from "./config.js";
import { isMissing } from "./json.js";
import { PROPERTIES_FILE } from "./properties.js";

/** A file `init` hands out: a copy of a package file, or lines `.gitignore` must have. */
type InitFile = {
  readonly path: string;
  readonly source:
    | { readonly kind: "template"; readonly file: string }
    | { readonly kind: "gitignore"; readonly lines: readonly string[] };
};

export type InitAction = {
  readonly path: string;
  readonly kind: "created" | "skipped" | "appended";
};

/** Everything `init` writes, in the order it reports. `file` is relative to the package root. */
const INIT_FILES: readonly InitFile[] = [
  { path: CONFIG_FILE, source: { kind: "template", file: "templates/init/everypath.config.json" } },
  {
    path: PROPERTIES_FILE,
    source: { kind: "template", file: "templates/init/everypath.properties.json" },
  },
  {
    path: ".claude/skills/everypath/SKILL.md",
    source: { kind: "template", file: "skill/SKILL.md" },
  },
  {
    path: ".claude/settings.example.json",
    source: { kind: "template", file: "templates/init/settings.example.json" },
  },
  {
    path: ".gitignore",
    source: { kind: "gitignore", lines: [".everypath/*", "!.everypath/review.json"] },
  },
];

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function copyUnlessPresent(from: string, to: string): Promise<InitAction["kind"]> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL);
    return "created";
  } catch (error) {
    if (isExisting(error)) return "skipped";
    throw error;
  }
}

/** Git ignores the spaces at the end of a pattern, so a line counts with them trimmed. */
async function appendMissingLines(
  path: string,
  lines: readonly string[],
): Promise<InitAction["kind"]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await writeFile(path, `${lines.join("\n")}\n`, { flag: "wx" });
    return "created";
  }
  const present = new Set(content.split("\n").map((line) => line.trimEnd()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return "skipped";
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${separator}${missing.join("\n")}\n`);
  return "appended";
}

/**
 * Writes each file of `INIT_FILES` under `root` only where it is missing, so a second run changes no
 * byte. `packageRoot` holds `templates/` and `skill/`.
 */
export async function initRepository(
  root: string,
  packageRoot: string,
): Promise<readonly InitAction[]> {
  const actions: InitAction[] = [];
  for (const { path, source } of INIT_FILES) {
    const target = join(root, path);
    const kind =
      source.kind === "template"
        ? await copyUnlessPresent(join(packageRoot, source.file), target)
        : await appendMissingLines(target, source.lines);
    actions.push({ path, kind });
  }
  return actions;
}
