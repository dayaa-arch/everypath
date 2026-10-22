import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { CONFIG_FILE, type Config, DEFAULT_CONFIG, parseConfig } from "./config.js";
import { parseEventName, parseStateName } from "./expr.js";
import { parseFindings, rootRelative } from "./findings.js";
import type { Manifest } from "./imports-common.js";
import {
  asInteger,
  asItems,
  asText,
  errorMessage,
  isMissing,
  isRecord,
  readJsonFile,
} from "./json.js";
import type { PromptKind } from "./prompts.js";
import { mergeProofs, PROOFS_FILE, parseProofs } from "./proofs.js";
import { NO_PROPERTIES, PROPERTIES_FILE, parseProperties } from "./properties.js";
import {
  blindFile,
  foldReview,
  LEGACY_REVIEW_FILE,
  parseRecordFile,
  planChange,
  RECORD_BYTE_LIMIT,
  REVIEW_DIRECTORY,
  REVIEW_GITIGNORE,
  type RecordFile,
  type ReviewChange,
  type ReviewState,
} from "./review.js";
import { parseStoredVerdicts, type StoredVerdicts, type TlcRecord } from "./tla/result.js";
import type {
  EdgeRef,
  Finding,
  Graph,
  HistoryEntry,
  Layout,
  ProofEntry,
  PropertiesFile,
  ScanWarning,
  StateName,
} from "./types.js";

/** Where the scanner reads and writes outside the sources. Nothing else on disk is ever written (R-01). */
export const OUTPUT_DIRECTORY = ".everypath";
const TLA_DIRECTORY = `${OUTPUT_DIRECTORY}/tla`;
const TLC_RESULT_FILE = `${TLA_DIRECTORY}/result.json`;
const SERVE_FILE = `${OUTPUT_DIRECTORY}/serve.json`;

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(
  "node_modules .git dist build out .next __pycache__ venv .venv coverage target vendor .everypath".split(
    " ",
  ),
);
/** `.dfy` is here so a Dafny proof can name its node with `@state` and join that node's files. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(
  ".js .jsx .ts .tsx .mjs .cjs .py .go .rb .rs .java .kt .dfy".split(" "),
);
/** Files that name a package for the import resolvers (`go.mod`, `Cargo.toml`). The walk reads them beside the sources. */
const MANIFEST_NAMES: ReadonlySet<string> = new Set(["go.mod", "Cargo.toml"]);
const FINDINGS_FILES: readonly string[] = [
  "everypath.findings.json",
  `${OUTPUT_DIRECTORY}/findings.json`,
  "semgrep.json",
  "bandit.json",
];
/** The files under `.everypath/` that a scan reads. Everything else there is output. */
const OUTPUT_INPUTS: ReadonlySet<string> = new Set([
  LEGACY_REVIEW_FILE,
  TLC_RESULT_FILE,
  PROOFS_FILE,
  ...FINDINGS_FILES.filter((file) => file.startsWith(`${OUTPUT_DIRECTORY}/`)),
]);

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
  /** The package manifests the walk met, sorted by path. */
  readonly manifests: readonly Manifest[];
  readonly findings: readonly Finding[];
  readonly findingsSource: string | null;
  /** The approval records of `.everypath/review/` and the legacy `review.json`, folded. */
  readonly review: ReviewState;
  readonly previous: Previous | null;
  /** TLC's last verdicts, from `result.json`. `null` before any TLC run. */
  readonly tlc: StoredVerdicts | null;
  /** The usable entries of `proofs.json`, by node id. */
  readonly proofs: ReadonlyMap<string, ProofEntry>;
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
  const manifests = await readManifests(root, walked.manifests);
  const [findings, review, previous, tlc, proofs] = await Promise.all([
    readFindings(root, configured.config),
    readReview(root),
    readPrevious(root),
    readTlcResult(root),
    readProofs(root),
  ]);
  return {
    root,
    config: configured.config,
    properties: properties.file,
    sources: sources.sources,
    manifests: manifests.manifests,
    findings: findings.list,
    findingsSource: findings.source,
    review: review.state,
    previous,
    tlc: tlc.stored,
    proofs: proofs.entries,
    warnings: [
      ...configured.warnings,
      ...properties.warnings,
      ...walked.warnings,
      ...sources.warnings,
      ...manifests.warnings,
      ...findings.warnings,
      ...review.warnings,
      ...tlc.warnings,
      ...proofs.warnings,
    ],
  };
}

export async function writeWorkspace(
  root: string,
  graph: Graph,
  entry: HistoryEntry | null,
): Promise<void> {
  const directory = await outputDirectory(root, OUTPUT_DIRECTORY);
  // History goes first: a crash between the two writes repeats a line on the next scan instead of losing one.
  if (entry !== null) await appendHistory(directory, `${JSON.stringify(entry)}\n`);
  await replaceFile(join(directory, "graph.json"), serializeGraph(graph));
}

/**
 * R-01 in a checkout that may be hostile: makes `directory` (`.everypath` or `.everypath/tla`) one
 * name at a time if it is absent, and refuses when any of them is a link or not a directory, since a
 * write through it would land outside the repository. Every writer here calls it first.
 */
async function outputDirectory(root: string, directory: string): Promise<string> {
  let path = root;
  let shown = "";
  for (const name of directory.split("/")) {
    path = join(path, name);
    shown = shown === "" ? name : `${shown}/${name}`;
    await mkdir(path).catch((error: unknown) => {
      if (codeOf(error) !== "EEXIST") throw error;
    });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `${shown} がリンクかディレクトリ以外のものなので、書き込みません。ディレクトリに置き換えてから実行し直してください`,
      );
    }
  }
  return path;
}

/** Appends one line to `history.jsonl` without following a link there, which would write outside. */
async function appendHistory(directory: string, line: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const file = await open(join(directory, "history.jsonl"), flags, 0o666).catch(
    (error: unknown) => {
      const code = codeOf(error);
      if (code !== "ELOOP" && code !== "EMLINK") throw error;
      throw new Error(`${OUTPUT_DIRECTORY}/history.jsonl がリンクなので、書き込みません`);
    },
  );
  try {
    await file.appendFile(line);
  } finally {
    await file.close();
  }
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/**
 * Adds the one record an approval or a revocation becomes, or nothing when it would change nothing
 * (`planChange`). The server's writer queue is its only caller. It never edits or removes a record,
 * nor the legacy `review.json`. It reads the records again first, so the change replaces what is on
 * disk now, a record that `git pull` brought a moment ago included.
 */
export async function writeReviewChange(
  root: string,
  change: ReviewChange,
): Promise<"written" | "unchanged"> {
  const planned = planChange((await readReview(root)).state, change);
  if (planned === null) return "unchanged";
  const directory = await outputDirectory(root, REVIEW_DIRECTORY);
  await keepReviewTracked(root);
  await replaceFile(join(directory, planned.name), planned.text);
  return "written";
}

/**
 * Appends the lines of `REVIEW_GITIGNORE` that `.everypath/.gitignore` lacks, keeping a person's own.
 * A nested `.gitignore` wins over the root one below it, so `!review/` tracks the records under the
 * two lines `init` has always written, and a repository needs no second `init`. The file is ignored
 * itself and never committed: this runs before every write, so a fresh clone has it again in time.
 */
async function keepReviewTracked(root: string): Promise<void> {
  const directory = await outputDirectory(root, OUTPUT_DIRECTORY);
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const file = await open(join(directory, ".gitignore"), flags, 0o666).catch((error: unknown) => {
    const code = codeOf(error);
    if (code !== "ELOOP" && code !== "EMLINK") throw error;
    throw new Error(`${REVIEW_GITIGNORE.path} がリンクなので、書き込みません`);
  });
  try {
    const content = await file.readFile("utf8");
    const present = new Set(content.split("\n").map((line) => line.trimEnd()));
    const missing = REVIEW_GITIGNORE.lines.filter((line) => !present.has(line));
    if (missing.length === 0) return;
    const separator = content === "" || content.endsWith("\n") ? "" : "\n";
    await file.appendFile(`${separator}${missing.join("\n")}\n`);
  } finally {
    await file.close();
  }
}

/**
 * Sets the entries of `updates` in `proofs.json` and keeps every other id as it was.
 * `everypath prove` is its only caller: the server reads the file and never writes it.
 * A file that is there but is not a JSON object is never overwritten.
 */
export async function writeProofs(
  root: string,
  updates: ReadonlyMap<string, ProofEntry>,
): Promise<void> {
  const file = await readJsonFile(join(root, PROOFS_FILE));
  if (file.kind === "invalid") {
    throw new Error(`${PROOFS_FILE} を読めないので書き換えません: ${file.reason}`);
  }
  const text = mergeProofs(file.kind === "ok" ? file.value : undefined, updates);
  if (text === null) throw new Error(`${PROOFS_FILE} がオブジェクトでないので書き換えません`);
  const directory = await outputDirectory(root, OUTPUT_DIRECTORY);
  await replaceFile(join(directory, "proofs.json"), text);
}

/** `.everypath/layout.json`, as the viewer sent it. */
export async function writeLayout(root: string, layout: Layout): Promise<void> {
  const directory = await outputDirectory(root, OUTPUT_DIRECTORY);
  await replaceFile(join(directory, "layout.json"), `${JSON.stringify(layout, null, 2)}\n`);
}

/** An output file the server hands out as it is, or `null` before anything wrote it. */
export async function readOutput(
  root: string,
  file: "layout.json" | "history.jsonl" | "tla/Model.tla" | `templates/${PromptKind}.md`,
): Promise<string | null> {
  try {
    return await readFile(join(root, OUTPUT_DIRECTORY, file), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Whether a change at `path` (root-relative, `/`) can change what a scan reads: the server's watcher
 * asks only this. Under `.everypath/` only the scan's inputs count, so `graph.json`, `history.jsonl`,
 * the layout and every temporary file never start a scan. An approval record in `review/` and
 * `tla/result.json` do, though the server writes them too: that rescan finds the graph it already
 * sent and writes nothing. So do the legacy `review.json`, the `review/` directory itself appearing
 * or going away, and `proofs.json`, which only `everypath prove` writes. `.gitignore` does not.
 * Elsewhere, outside the walk's ignored directories, a source file counts, and so does any JSON file
 * (the config, the properties, every findings file wherever `findings` points), a package manifest
 * (`go.mod`, `Cargo.toml`: they decide what an import resolves to) and any name without an extension,
 * which may be a directory moved or removed with its files. `isDirectory` asks whether
 * a poller should look inside.
 */
export function isScanInput(path: string, isDirectory = false): boolean {
  if (path === REVIEW_DIRECTORY) return true;
  if (posix.dirname(path) === REVIEW_DIRECTORY) return !isDirectory && path.endsWith(".jsonl");
  if (path === OUTPUT_DIRECTORY || path.startsWith(`${OUTPUT_DIRECTORY}/`)) {
    return isDirectory
      ? [...OUTPUT_INPUTS].some((input) => input.startsWith(`${path}/`))
      : OUTPUT_INPUTS.has(path);
  }
  if (path.split("/").some((name) => IGNORED_DIRECTORIES.has(name))) return false;
  const extension = posix.extname(path);
  return (
    isDirectory ||
    extension === "" ||
    extension === ".json" ||
    SOURCE_EXTENSIONS.has(extension) ||
    MANIFEST_NAMES.has(posix.basename(path))
  );
}

/** Model.tla and Model.cfg in `.everypath/tla/`, for a person to open. `tla export` writes only these. */
export async function writeTlaModel(
  root: string,
  { tla, cfg }: Pick<TlcRecord, "tla" | "cfg">,
): Promise<void> {
  const directory = await outputDirectory(root, TLA_DIRECTORY);
  await replaceFile(join(directory, "Model.tla"), tla);
  await replaceFile(join(directory, "Model.cfg"), cfg);
}

/**
 * A finished TLC run into `.everypath/tla/`: the model it checked, then `result.json`. The record goes
 * last because it is the scan input, so whoever sees it change finds the model beside it already.
 * `writeTlaModel` has just made sure the directory is real.
 */
export async function commitTlc(root: string, record: TlcRecord): Promise<void> {
  await writeTlaModel(root, record);
  await replaceFile(join(root, TLC_RESULT_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * `.everypath/serve.json`: the `everypath serve` that owns this directory's writes, found by the CLI
 * so it hands its own writes over. Output only: a scan never reads it.
 */
export type ServeRecord = { readonly version: 1; readonly pid: number; readonly port: number };

const MAX_PORT = 65_535;

function parseServeRecord(raw: unknown): ServeRecord | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  const pid = asInteger(raw.pid);
  const port = asInteger(raw.port);
  if (pid === null || pid <= 0 || port === null || port <= 0 || port > MAX_PORT) return null;
  return { version: 1, pid, port };
}

/** A missing or damaged file is no record. */
export async function readServeRecord(root: string): Promise<ServeRecord | null> {
  const file = await readJsonFile(join(root, SERVE_FILE));
  return file.kind === "ok" ? parseServeRecord(file.value) : null;
}

/** Signal 0 only asks: `EPERM` is a process of another user, which is alive. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

function serializeServeRecord(record: ServeRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Claims the directory for `record`, which names the server about to write it. A record that is
 * there already and names another running process is returned untouched: that server owns the
 * directory. One that is damaged or names a dead process (or this one) was left by a run that did
 * not clean up, so it is replaced. `null` means the claim is held.
 */
export async function writeServeRecord(
  root: string,
  record: ServeRecord,
): Promise<ServeRecord | null> {
  const path = join(await outputDirectory(root, OUTPUT_DIRECTORY), "serve.json");
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const created = await open(path, flags, 0o666).catch((error: unknown) => {
    if (codeOf(error) !== "EEXIST") throw error;
    return null;
  });
  if (created !== null) {
    try {
      await created.writeFile(serializeServeRecord(record));
    } finally {
      await created.close();
    }
    return null;
  }
  const held = await readServeRecord(root);
  if (held !== null && held.pid !== record.pid && isRunning(held.pid)) return held;
  await replaceFile(path, serializeServeRecord(record));
  return null;
}

/** Removes the record only while it is still this server's: a later server's is not ours to delete. */
export async function removeServeRecord(root: string, record: ServeRecord): Promise<void> {
  const held = await readServeRecord(root);
  if (held?.pid !== record.pid || held.port !== record.port) return;
  await rm(join(await outputDirectory(root, OUTPUT_DIRECTORY), "serve.json"), { force: true });
}

/** Writes beside `path` and renames onto it, so a reader sees the old file or the new one, never half. */
export async function replaceFile(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
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

/** Whether the source walk enters the directory at `path`, whose last name is `name`. */
function walksInto(name: string, path: string, config: Config): boolean {
  return !IGNORED_DIRECTORIES.has(name) && !isIgnored(path, true, config);
}

/**
 * The directories a watcher must watch one by one to see every change `isScanInput` accepts,
 * root-relative with `""` for the root: each one the source walk enters, by the same rule and the
 * same `config.ignore`, and the ones under `.everypath/` that hold a scan input. Never follows a link.
 */
export async function watchedDirectories(root: string): Promise<string[]> {
  const { config } = await readConfig(root);
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    found.push(directory);
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      const output = path === OUTPUT_DIRECTORY || path.startsWith(`${OUTPUT_DIRECTORY}/`);
      const enters = output ? isScanInput(path, true) : walksInto(entry.name, path, config);
      if (entry.isDirectory() && enters) await visit(path);
    }
  }
  await visit("");
  return found;
}

/** Source files and package manifests under `root`, root-relative with `/`, sorted. Symlinks are never followed. */
async function walk(root: string, config: Config) {
  const paths: string[] = [];
  const manifests: string[] = [];
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
        if (walksInto(entry.name, path, config)) await visit(path);
      } else if (entry.isFile() && !isIgnored(path, false, config)) {
        if (SOURCE_EXTENSIONS.has(posix.extname(entry.name))) paths.push(path);
        else if (MANIFEST_NAMES.has(entry.name)) manifests.push(path);
      }
    }
  }

  await visit("");
  return { paths: paths.sort(), manifests: manifests.sort(), warnings };
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

async function readManifests(root: string, paths: readonly string[]) {
  const manifests: Manifest[] = [];
  const warnings: ScanWarning[] = [];
  for (const path of paths) {
    try {
      manifests.push({ path, text: await readFile(join(root, path), "utf8") });
    } catch (error) {
      warnings.push(unreadable(path, errorMessage(error)));
    }
  }
  return { manifests, warnings };
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

/** The records of `.everypath/review/` and the legacy `review.json`, folded. Never throws on content. */
async function readReview(root: string) {
  const [files, legacy] = await Promise.all([readRecordFiles(root), readLegacyReview(root)]);
  const folded = foldReview({ files, legacy: legacy.text });
  return { state: folded.state, warnings: [...legacy.warnings, ...folded.warnings] };
}

/**
 * Records already read, by absolute directory, then by file name (graft 3 of decision 0004). A
 * record's name is the hash of its line and nothing rewrites one, so a name read once needs no second
 * read, and a serve process reads only the records that arrived since its last scan. Only records it
 * understood are kept: a file caught half-written by a checkout is read again on the next scan.
 */
const readRecords = new Map<string, ReadonlyMap<string, RecordFile>>();

/** Files opened at once, under the default limit of open files on macOS (256). */
const READ_BATCH = 128;

async function readRecordFiles(root: string): Promise<RecordFile[]> {
  const directory = join(root, REVIEW_DIRECTORY);
  const info = await lstat(directory).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (info === null) return [];
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return [blindFile(REVIEW_DIRECTORY, "リンクかディレクトリ以外のものなので読みません")];
  }
  const known = readRecords.get(directory);
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) =>
    entry.name.endsWith(".jsonl"),
  );
  const files = new Map<string, RecordFile>();
  for (let start = 0; start < entries.length; start += READ_BATCH) {
    const batch = entries.slice(start, start + READ_BATCH);
    await Promise.all(
      batch.map(async (entry) => {
        const cached = entry.isFile() ? known?.get(entry.name) : undefined;
        const file = cached ?? (await readRecordFile(directory, entry));
        if (file !== null) files.set(entry.name, file);
      }),
    );
  }
  readRecords.set(directory, new Map([...files].filter(([, file]) => file.kind === "read")));
  return [...files.values()];
}

/** `null` for a file that went away since the directory was listed: it is no record any more. */
async function readRecordFile(directory: string, entry: Dirent): Promise<RecordFile | null> {
  const file = `${REVIEW_DIRECTORY}/${entry.name}`;
  if (!entry.isFile()) return blindFile(file, "リンクかファイル以外のものなので読みません");
  let handle: FileHandle;
  try {
    handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return isMissing(error) ? null : blindFile(file, errorMessage(error));
  }
  try {
    const buffer = Buffer.alloc(RECORD_BYTE_LIMIT + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const { bytesRead: got } = await handle.read(buffer, bytesRead, buffer.length - bytesRead);
      if (got === 0) break;
      bytesRead += got;
    }
    if (bytesRead > RECORD_BYTE_LIMIT) {
      return blindFile(file, `${RECORD_BYTE_LIMIT / 1024} KiB を超えるので読みません`);
    }
    return parseRecordFile(entry.name, buffer.toString("utf8", 0, bytesRead));
  } catch (error) {
    return blindFile(file, errorMessage(error));
  } finally {
    await handle.close();
  }
}

async function readLegacyReview(root: string) {
  try {
    return { text: await readFile(join(root, LEGACY_REVIEW_FILE), "utf8"), warnings: [] };
  } catch (error) {
    if (isMissing(error)) return { text: null, warnings: [] };
    return { text: null, warnings: [unreadable(LEGACY_REVIEW_FILE, errorMessage(error))] };
  }
}

/** A missing file is no TLC run yet. A damaged one is a warning and counts as absent. */
async function readTlcResult(root: string) {
  const file = await readJsonFile(join(root, TLC_RESULT_FILE));
  if (file.kind === "missing") return { stored: null, warnings: [] };
  if (file.kind === "invalid") {
    return { stored: null, warnings: [unreadable(TLC_RESULT_FILE, file.reason)] };
  }
  const stored = parseStoredVerdicts(file.value);
  return stored === null
    ? {
        stored,
        warnings: [fileWarning(TLC_RESULT_FILE, `${TLC_RESULT_FILE} の形が違うので使いません`)],
      }
    : { stored, warnings: [] };
}

/** A missing file is no proof yet. A damaged one is a warning and counts as absent. */
async function readProofs(root: string) {
  const file = await readJsonFile(join(root, PROOFS_FILE));
  if (file.kind === "missing") return { entries: new Map<string, ProofEntry>(), warnings: [] };
  if (file.kind === "invalid") {
    return {
      entries: new Map<string, ProofEntry>(),
      warnings: [unreadable(PROOFS_FILE, file.reason)],
    };
  }
  return parseProofs(file.value);
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
