import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/core/config.js";
import { parseProperties } from "../src/core/properties.js";
import { makeRepo, readGraph, runCli, writeFiles } from "./helpers/repo.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The five files of `docs/specs/init.md` condition 2. */
const HANDED_OUT = [
  ".claude/settings.example.json",
  ".claude/skills/everypath/SKILL.md",
  ".gitignore",
  "everypath.config.json",
  "everypath.properties.json",
];

/** Every file and directory under `root`, root-relative with `/`, directories ending in `/`. */
async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .map((entry) => {
      const path = relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
      return entry.isDirectory() ? `${path}/` : path;
    })
    .sort();
}

/** The bytes of every file under `root`, as hex, keyed by path. */
async function bytesOf(root: string): Promise<Map<string, string>> {
  const files = (await tree(root)).filter((path) => !path.endsWith("/"));
  const pairs = await Promise.all(
    files.map(async (path) => [path, (await readFile(join(root, path))).toString("hex")] as const),
  );
  return new Map(pairs);
}

function init(root: string) {
  const result = runCli(["init", root]);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

/** The one stdout line that names `path`. */
function lineFor(stdout: string, path: string): string {
  const lines = stdout.split("\n").filter((line) => line.includes(path));
  assert.equal(lines.length, 1, `one line names ${path}:\n${stdout}`);
  return lines[0] ?? "";
}

function assertReported(stdout: string, expected: Readonly<Record<string, RegExp>>): void {
  const lines = stdout.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, HANDED_OUT.length, stdout);
  for (const [path, verb] of Object.entries(expected)) {
    assert.match(lineFor(stdout, path), verb);
  }
}

const CREATED = /作りました/;
const SKIPPED = /飛ばしました/;
const APPENDED = /足しました/;

const allAs = (verb: RegExp): Record<string, RegExp> =>
  Object.fromEntries(HANDED_OUT.map((path) => [path, verb]));

const IGNORE_LINES = ".everypath/*\n!.everypath/review.json\n";

describe("everypath init: an empty directory", () => {
  it("creates the five files and no other path", async () => {
    const root = await makeRepo({});

    const { stdout } = init(root);

    assert.deepEqual(await tree(root), [
      ".claude/",
      ".claude/settings.example.json",
      ".claude/skills/",
      ".claude/skills/everypath/",
      ".claude/skills/everypath/SKILL.md",
      ".gitignore",
      "everypath.config.json",
      "everypath.properties.json",
    ]);
    assertReported(stdout, allAs(CREATED));
    assert.equal(await readFile(join(root, ".gitignore"), "utf8"), IGNORE_LINES);
    assert.deepEqual(
      await readFile(join(root, ".claude/skills/everypath/SKILL.md")),
      await readFile(join(repoRoot, "skill/SKILL.md")),
    );
  });

  it("initializes the current directory by default", async () => {
    const root = await makeRepo({});

    const result = runCli(["init"], root);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      (await tree(root)).filter((path) => !path.endsWith("/")),
      HANDED_OUT,
    );
  });

  it("exits 2 for a missing directory and writes nothing", async () => {
    const root = await makeRepo({});

    assert.equal(runCli(["init", join(root, "missing")]).status, 2);
    assert.deepEqual(await tree(root), []);
  });
});

describe("everypath init: run again", () => {
  it("changes no byte on the second run and says it skipped each file", async () => {
    const root = await makeRepo({});
    init(root);
    const before = await bytesOf(root);

    const { stdout } = init(root);

    assert.deepEqual(await bytesOf(root), before);
    assertReported(stdout, allAs(SKIPPED));
  });

  it("keeps existing files as they are and creates only the missing ones", async () => {
    const mine = {
      "everypath.config.json": '{ "includeTests": true }\n',
      ".claude/skills/everypath/SKILL.md": "自分で書いたスキル\n",
      ".claude/settings.json": "{}\n",
    };
    const root = await makeRepo(mine);

    const { stdout } = init(root);

    for (const [path, content] of Object.entries(mine)) {
      assert.equal(await readFile(join(root, path), "utf8"), content, path);
    }
    assertReported(stdout, {
      "everypath.config.json": SKIPPED,
      ".claude/skills/everypath/SKILL.md": SKIPPED,
      "everypath.properties.json": CREATED,
      ".claude/settings.example.json": CREATED,
      ".gitignore": CREATED,
    });
  });

  it("appends both lines to a .gitignore that has neither and keeps its content", async () => {
    const root = await makeRepo({ ".gitignore": "node_modules/\ndist" });

    const { stdout } = init(root);

    assert.equal(
      await readFile(join(root, ".gitignore"), "utf8"),
      `node_modules/\ndist\n${IGNORE_LINES}`,
    );
    assert.match(lineFor(stdout, ".gitignore"), APPENDED);
  });

  it("appends only the line a .gitignore lacks", async () => {
    const root = await makeRepo({ ".gitignore": "node_modules/\n.everypath/*\n" });

    const { stdout } = init(root);

    assert.equal(
      await readFile(join(root, ".gitignore"), "utf8"),
      "node_modules/\n.everypath/*\n!.everypath/review.json\n",
    );
    assert.match(lineFor(stdout, ".gitignore"), APPENDED);
  });

  it("leaves a .gitignore that has both lines byte for byte", async () => {
    const original = "!.everypath/review.json\r\nnode_modules/\r\n.everypath/*";
    const root = await makeRepo({ ".gitignore": original });

    const { stdout } = init(root);

    assert.equal(await readFile(join(root, ".gitignore"), "utf8"), original);
    assert.match(lineFor(stdout, ".gitignore"), SKIPPED);
  });
});

describe("everypath init: the templates", () => {
  it("hands out properties and a config that parse with no warning", async () => {
    const root = await makeRepo({});
    init(root);

    const properties = JSON.parse(await readFile(join(root, "everypath.properties.json"), "utf8"));
    const config = JSON.parse(await readFile(join(root, "everypath.config.json"), "utf8"));

    assert.deepEqual(parseProperties(properties).warnings, []);
    assert.deepEqual(parseConfig(config).warnings, []);
  });

  it("leaves a repository that everypath check passes with no warning", async () => {
    const root = await makeRepo({});
    init(root);

    const result = runCli(["check", root]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /警告/);
  });

  it("hands out a settings example with the scan hook on PostToolUse", async () => {
    const root = await makeRepo({});
    init(root);

    const settings = JSON.parse(
      await readFile(join(root, ".claude/settings.example.json"), "utf8"),
    ) as { hooks?: { PostToolUse?: { hooks?: { type?: string; command?: string }[] }[] } };

    const commands = (settings.hooks?.PostToolUse ?? []).flatMap((entry) =>
      (entry.hooks ?? []).filter((hook) => hook.type === "command").map((hook) => hook.command),
    );
    assert.deepEqual(commands, ["npx everypath scan --quiet"]);
  });
});

type Fence = { readonly lang: string; readonly body: string };

function fencesOf(markdown: string): Fence[] {
  return [...markdown.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(([, lang = "", body = ""]) => ({
    lang,
    body,
  }));
}

const EXTENSIONS: Readonly<Record<string, string>> = { ts: "ts", js: "js", py: "py" };

/**
 * Writes each fenced block that holds an annotation into its own file, scans them together and
 * returns the graph. Each block that names a state must show up as a node with code behind it.
 */
async function scanFences(markdown: string) {
  const blocks = fencesOf(markdown).filter(({ body }) => body.includes("@state"));
  assert.ok(blocks.length > 0, "the document has an annotation example");
  const files = Object.fromEntries(
    blocks.map(({ lang, body }, index) => [
      `src/example${index}.${EXTENSIONS[lang] ?? "ts"}`,
      body,
    ]),
  );
  const root = await makeRepo({});
  await writeFiles(root, files);
  const result = runCli(["scan", root, "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
  const graph = await readGraph(root);
  const named = blocks.flatMap(({ body }) =>
    [...body.matchAll(/@state[ \t]+(\S+)/g)].map(([, name = ""]) => name),
  );
  for (const name of named) {
    const node = graph.nodes.find((n) => n.id === name);
    assert.ok(node !== undefined && !node.status.planned, `${name} is a node with code`);
  }
  return graph;
}

const read = (path: string) => readFile(join(repoRoot, path), "utf8");

describe("skill/SKILL.md", () => {
  it("is named everypath in its frontmatter and has a description", async () => {
    const skill = await read("skill/SKILL.md");

    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    assert.match(frontmatter, /^name: everypath$/m);
    assert.match(frontmatter, /^description: \S/m);
  });

  it("states the eleven rules of SPEC.md 14.1, each with its reason", async () => {
    const skill = await read("skill/SKILL.md");

    const items = skill.split(/^(?=\d+\. )/m).filter((part) => /^\d+\. /.test(part));
    assert.equal(items.length, 11, items.join("\n---\n"));
    for (const item of items) assert.match(item, /理由: \S/, item);
    const mentions = [
      "`@state-next`",
      "`if:`",
      "BOOLEAN",
      "計画",
      "everypath check --tlc",
      "everypath.properties.json",
      "@state-require proof",
      "@state-hidden",
      "@state-risk",
      "reviewed",
      ".everypath/",
    ];
    for (const mention of mentions) {
      assert.ok(
        items.some((item) => item.includes(mention)),
        `a rule mentions ${mention}`,
      );
    }
  });

  it("contains the example of SPEC.md 5.2", async () => {
    const [skill, spec] = await Promise.all([read("skill/SKILL.md"), read("SPEC.md")]);

    const section = spec.slice(spec.indexOf("### 5.2"));
    const example = fencesOf(section)[0]?.body ?? "";
    assert.match(example, /@state ログイン/);
    assert.ok(skill.includes(example), "SKILL.md contains the 5.2 example as written");
  });

  it("has examples that everypath scan reads with no warning", async () => {
    const graph = await scanFences(await read("skill/SKILL.md"));

    assert.deepEqual(graph.warnings, []);
  });
});

/** `everypath` as installed, through npx, or as the built file in a clone. */
const INVOCATION = /^(?:npx\s+everypath|everypath|node\s+dist\/cli\.js)\s+(.+)$/;

/** Each usage line of `--help`, keyed by its command words: `scan`, `tla install`. */
function usageLines(): Map<string, string> {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  const usage = new Map<string, string>();
  for (const line of help.stdout.split("\n")) {
    const words = /everypath\s+(.*)$/.exec(line)?.[1]?.split(/\s+/) ?? [];
    const end = words.findIndex((word) => !/^[a-z]/.test(word));
    const command = end === -1 ? words : words.slice(0, end);
    if (command.length > 0) usage.set(command.join(" "), line);
  }
  return usage;
}

type Invocation = { readonly command: string; readonly rest: readonly string[] };

describe("README.md", () => {
  async function invocations(): Promise<Invocation[]> {
    const usage = usageLines();
    const lines = fencesOf(await read("README.md")).flatMap(({ body }) => body.split("\n"));
    return lines.flatMap((line) => {
      const words = INVOCATION.exec(line.trim())?.[1]?.split(/\s+/);
      if (words === undefined) return [];
      const command = [...usage.keys()]
        .filter((key) => `${words.join(" ")} `.startsWith(`${key} `))
        .sort((a, b) => b.length - a.length)[0];
      assert.ok(command !== undefined, `README runs a command --help lists: ${line}`);
      return [{ command, rest: words.slice(command.split(" ").length) }];
    });
  }

  it("runs only commands and options that --help lists", async () => {
    const usage = usageLines();

    for (const { command, rest } of await invocations()) {
      for (const option of rest.filter((word) => word.startsWith("--"))) {
        assert.ok(usage.get(command)?.includes(option), `${command} takes ${option}`);
      }
    }
  });

  it("covers install, init, serve, check, check --tlc, tla install and the example", async () => {
    const readme = await read("README.md");
    const ran = await invocations();

    assert.match(readme, /npm install/);
    for (const command of ["init", "serve", "check", "tla install"]) {
      assert.ok(
        ran.some((run) => run.command === command),
        `README runs everypath ${command}`,
      );
    }
    assert.ok(ran.some(({ command, rest }) => command === "check" && rest.includes("--tlc")));
    assert.ok(
      ran.some(({ rest }) => rest.includes("example")),
      "README runs the example",
    );
  });

  it("has an annotation example that everypath scan reads with no warning", async () => {
    const graph = await scanFences(await read("README.md"));

    assert.deepEqual(graph.warnings, []);
  });
});
