import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { CONFIG_FILE, type Config, DEFAULT_CONFIG, parseConfig } from "./config.js";
import { parseEventName, parseStateName } from "./expr.js";
import { parseFindings, rootRelative } from "./findings.js";
import { asItems, asText, errorMessage, isRecord, readJsonFile } from "./json.js";
import { NO_PROPERTIES, PROPERTIES_FILE, parseProperties } from "./properties.js";
import type {
  EdgeRef,
  Finding,
  Graph,
  HistoryEntry,
  PropertiesFile,
  ScanWarning,
  StateName,
} from "./types.js";

/** Where the scanner reads and writes outside the sources. Nothing else on disk is ever written (R-01). */
export const OUTPUT_DIRECTORY = ".everypath";

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(
  "node_modules .git dist build out .next __pycache__ venv .venv coverage target vendor .everypath".split(
    " ",
  ),
);
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(
  ".js .jsx .ts .tsx .mjs .cjs .py .go .rb .rs .java .kt".split(" "),
);
const FINDINGS_FILES: readonly string[] = [
  "everypath.findings.json",
  `${OUTPUT_DIRECTORY}/findings.json`,
  "semgrep.json",
  "bandit.json",
];

export type Source = { readonly path: string; readonly bytes: Buffer };

/** The last `graph.json`, reduced to what the next scan compares against. */
export type Previous = {
  readonly nodes: ReadonlyMap<StateName, { readonly hash: string; readonly lastChangedAt: string }>;
  readonly edges: readonly EdgeRef[];
};

/** Everything a scan reads from disk, parsed at this boundary. The rest of the scan never touches the disk. */
export type Workspace = {
  /** Absolute. */
  readonly root: string;
  readonly config: Config;
  readonly properties: PropertiesFile;
  /** Root-relative `/` paths, sorted. */
  readonly sources: readonly Source[];
  readonly findings: readonly Finding[];
  readonly findingsSource: string | null;
  /** Approved hash by node id, from `review.json`. */
  readonly approvals: ReadonlyMap<string, string>;
  readonly previous: Previous | null;
  /** Inputs that could not be used. Each is a warning, never an error. */
  readonly warnings: readonly ScanWarning[];
};

function fileWarning(file: string, message: string): ScanWarning {
  return { file, line: null, message, detail: null };
}

function unreadable(file: string, reason: string): ScanWarning {
  return fileWarning(file, `${file} を読めません: ${reason}`);
}

export async function readWorkspace(root: string): Promise<Workspace> {
  const configured = await readConfig(root);
  const properties = await readProperties(root);
  const walked = await walk(root, configured.config);
  const sources = await readSources(root, walked.paths);
  const [findings, review, previous] = await Promise.all([
    readFindings(root, configured.config),
    readApprovals(root),
    readPrevious(root),
  ]);
  return {
    root,
    config: configured.config,
    properties: properties.file,
    sources: sources.sources,
    findings: findings.list,
    findingsSource: findings.source,
    approvals: review.approvals,
    previous,
    warnings: [
      ...configured.warnings,
      ...properties.warnings,
      ...walked.warnings,
      ...sources.warnings,
      ...findings.warnings,
      ...review.warnings,
    ],
  };
}

/** The graph is renamed into place so a reader never sees half of it. */
export async function writeWorkspace(
  root: string,
  graph: Graph,
  entry: HistoryEntry | null,
): Promise<void> {
  const directory = join(root, OUTPUT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  // History goes first: a crash between the two writes repeats a line on the next scan instead of losing one.
  if (entry !== null) {
    await appendFile(join(directory, "history.jsonl"), `${JSON.stringify(entry)}\n`);
  }
  const target = join(directory, "graph.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serializeGraph(graph));
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The exact text of `graph.json`. The CLI prints the same text under `--json`. */
export function serializeGraph(graph: Graph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

async function readConfig(root: string) {
  const file = await readJsonFile(join(root, CONFIG_FILE));
  switch (file.kind) {
    case "missing":
      return { config: DEFAULT_CONFIG, warnings: [] };
    case "invalid":
      return { config: DEFAULT_CONFIG, warnings: [unreadable(CONFIG_FILE, file.reason)] };
    case "ok":
      return parseConfig(file.value);
  }
}

async function readProperties(root: string) {
  const file = await readJsonFile(join(root, PROPERTIES_FILE));
  switch (file.kind) {
    case "missing":
      return { file: NO_PROPERTIES, warnings: [] };
    case "invalid":
      return { file: NO_PROPERTIES, warnings: [unreadable(PROPERTIES_FILE, file.reason)] };
    case "ok":
      return parseProperties(file.value);
  }
}

function isIgnored(path: string, isDirectory: boolean, config: Config): boolean {
  // A directory is also tried with a trailing `/`, so `generated/**` prunes `generated` itself.
  return config.ignore.some(
    (pattern) => pattern.test(path) || (isDirectory && pattern.test(`${path}/`)),
  );
}

/** Source files under `root`, root-relative with `/`, sorted. Symlinks are never followed. */
async function walk(root: string, config: Config) {
  const paths: string[] = [];
  const warnings: ScanWarning[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(
      (error: unknown) => {
        if (directory === "") throw error;
        warnings.push(unreadable(directory, errorMessage(error)));
        return [];
      },
    );
    for (const entry of entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !isIgnored(path, true, config)) {
          await visit(path);
        }
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(posix.extname(entry.name)) &&
        !isIgnored(path, false, config)
      ) {
        paths.push(path);
      }
    }
  }

  await visit("");
  return { paths: paths.sort(), warnings };
}

async function readSources(root: string, paths: readonly string[]) {
  const sources: Source[] = [];
  const warnings: ScanWarning[] = [];
  for (const path of paths) {
    try {
      sources.push({ path, bytes: await readFile(join(root, path)) });
    } catch (error) {
      warnings.push(unreadable(path, errorMessage(error)));
    }
  }
  return { sources, warnings };
}

/** The first findings file that exists wins, `config.findings` before the defaults. */
async function readFindings(root: string, config: Config) {
  const configured = config.findings;
  const candidates = configured === null ? FINDINGS_FILES : [configured, ...FINDINGS_FILES];
  const warnings: ScanWarning[] = [];
  const unusable = (warning: ScanWarning) => ({
    source: null,
    list: [],
    warnings: [...warnings, warning],
  });

  for (const candidate of candidates) {
    const source = rootRelative(candidate, root) ?? candidate;
    const file = await readJsonFile(resolve(root, candidate));
    if (file.kind === "missing") {
      if (candidate === configured) {
        warnings.push(fileWarning(CONFIG_FILE, `findings に指定した ${source} がありません`));
      }
      continue;
    }
    if (file.kind === "invalid") return unusable(unreadable(source, file.reason));
    const parsed = parseFindings(file.value, root);
    if (parsed === null) {
      return unusable(fileWarning(source, `${source} に results 配列がありません`));
    }
    if (parsed.skipped > 0) {
      warnings.push(
        fileWarning(
          source,
          `${source} の ${parsed.skipped} 件はルート内のファイルを特定できず読み飛ばしました`,
        ),
      );
    }
    return { source, list: parsed.findings, warnings };
  }
  return { source: null, list: [], warnings };
}

async function readApprovals(root: string) {
  const path = `${OUTPUT_DIRECTORY}/review.json`;
  const file = await readJsonFile(join(root, path));
  const approvals = new Map<string, string>();
  if (file.kind === "invalid") return { approvals, warnings: [unreadable(path, file.reason)] };
  if (file.kind === "ok" && isRecord(file.value) && isRecord(file.value.approvals)) {
    for (const [id, approval] of Object.entries(file.value.approvals)) {
      const hash = isRecord(approval) ? asText(approval.hash) : null;
      if (hash !== null) approvals.set(id, hash);
    }
  }
  return { approvals, warnings: [] };
}

/** A missing or damaged `graph.json` counts as absent: the scan then treats every node as new. */
async function readPrevious(root: string): Promise<Previous | null> {
  const file = await readJsonFile(join(root, OUTPUT_DIRECTORY, "graph.json"));
  if (file.kind !== "ok" || !isRecord(file.value)) return null;

  const nodes = new Map<StateName, { hash: string; lastChangedAt: string }>();
  for (const node of asItems(file.value.nodes)) {
    if (!isRecord(node)) continue;
    const id = parseStateName(asText(node.id) ?? "");
    const hash = asText(node.hash);
    const lastChangedAt = asText(node.lastChangedAt);
    if (id.ok && hash !== null && lastChangedAt !== null) {
      nodes.set(id.value, { hash, lastChangedAt });
    }
  }

  const edges: EdgeRef[] = [];
  for (const edge of asItems(file.value.edges)) {
    if (!isRecord(edge) || (edge.type !== "flow" && edge.type !== "dep")) continue;
    const from = parseStateName(asText(edge.from) ?? "");
    const to = parseStateName(asText(edge.to) ?? "");
    const event = edge.event == null ? null : parseEventName(asText(edge.event) ?? "");
    if (from.ok && to.ok && (event === null || event.ok)) {
      edges.push({ type: edge.type, from: from.value, to: to.value, event: event?.value ?? null });
    }
  }
  return { nodes, edges };
}
