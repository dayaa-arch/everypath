import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { CONFIG_FILE } from "./config.js";
import { errorMessage } from "./json.js";
import { analyze } from "./scan.js";
import type { ProofEntry, ProofTool, Prover, ScanWarning, StateName, StateNode } from "./types.js";
import { writeProofs } from "./workspace.js";

/** What a prover printed (stdout and stderr interleaved) and the code it exited with. */
export type ProofRun = { readonly output: string; readonly code: number };

/** What `everypath prove` writes of one run. `pending` is for other writers: a run always decides. */
export type Verdict = { readonly result: "passed" | "failed"; readonly message: string };

/** `everypath prove` without `--timeout`: per node. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Characters kept of a run's output. Every reader wants its start, where the errors are. */
const MAX_OUTPUT = 1_000_000;
const MAX_MESSAGE = 4_000;
const TAIL_LINES = 10;
/** The word of the command that becomes the node's files. */
const FILES = "{files}";

type ToolRow = {
  /** The node files `{files}` stands for: those with this extension, or every one for `null`. */
  readonly extension: string | null;
  readonly read: (run: ProofRun) => Verdict;
};

/**
 * Everything that differs between provers, by `proof.tool`. The command each runs by default is in
 * config.ts, because the config is read before any of this.
 */
const TOOLS: Readonly<Record<ProofTool, ToolRow>> = {
  dafny: { extension: ".dfy", read: readDafny },
  verus: { extension: ".rs", read: readVerus },
  command: { extension: null, read: readExit },
};

/** Whether a run of `tool` proved its files, and what it said about the obligations that failed. */
export function readProofOutput(tool: ProofTool, run: ProofRun): Verdict {
  return TOOLS[tool].read(run);
}

const linesOf = (output: string): string[] => output.split(/\r?\n/);

function clip(message: string): string {
  return message.length <= MAX_MESSAGE ? message : `${message.slice(0, MAX_MESSAGE)}…（省略）`;
}

/** A failure no line explains: why it ended, then the end of the output. */
function failedWith(why: string, output: string): Verdict {
  const tail = linesOf(output)
    .filter((line) => line.trim() !== "")
    .slice(-TAIL_LINES);
  return { result: "failed", message: clip([why, ...tail].join("\n")) };
}

const exitFailure = ({ output, code }: ProofRun): Verdict =>
  failedWith(`終了コード ${code}`, output);

function readExit(run: ProofRun): Verdict {
  return run.code === 0 ? { result: "passed", message: "" } : exitFailure(run);
}

/** A run passes only when it exits 0 and no line reports a failed obligation. */
function judged(run: ProofRun, failures: readonly string[], summary: string | undefined): Verdict {
  if (failures.length > 0) return { result: "failed", message: clip(failures.join("\n")) };
  if (run.code !== 0) return exitFailure(run);
  return { result: "passed", message: summary ?? "" };
}

/** `file(line,col): Error: …` and the `Related location` lines after it, as `dafny verify` prints them. */
const DAFNY_DIAGNOSTIC = /^.+\(\d+,\d+\): (?:Error|Related location): /;
const DAFNY_COUNT = /^\d+ resolution\/type errors detected in /;
const DAFNY_SUMMARY = /^Dafny program verifier finished with /;

function readDafny(run: ProofRun): Verdict {
  const lines = linesOf(run.output);
  const failures = lines.filter((line) => DAFNY_DIAGNOSTIC.test(line) || DAFNY_COUNT.test(line));
  return judged(
    run,
    failures,
    lines.find((line) => DAFNY_SUMMARY.test(line)),
  );
}

/** Verus prints rustc's diagnostics: a headline, `--> file:line:col`, quoted code and labelled markers. */
const VERUS_HEADLINE = /^error(?:\[\w+\])?: (.+)$/;
const VERUS_ABORTING = /^aborting due to /;
const VERUS_DIAGNOSTIC = /^(?:error|warning|note|help)(?:\[\w+\])?:/;
const VERUS_LOCATION = /^\s*--> (.+)$/;
/** `   |     ----- failed precondition`: a marker under one quoted line, with its label. */
const VERUS_LABEL = /^\s*\|\s*[-^]+\s+(\S.*)$/;
const VERUS_MARKER = /^\s*\|\s*[-^]+\s*$/;
/** `14 |     requires(b);`: a quoted line of code. */
const VERUS_CODE = /^\s*\d*\s*\|\s(.*\S.*)$/;
const VERUS_SUMMARY = /^verification results:: /;

type VerusError = { title: string; location: string | null; labels: string[] };

/**
 * One line per error: where and what, then each label with the code it points at, which for a
 * `failed precondition` or `failed this postcondition` is the obligation itself.
 */
function readVerus(run: ProofRun): Verdict {
  const errors: VerusError[] = [];
  let open: VerusError | null = null;
  let code: string | null = null;
  for (const line of linesOf(run.output)) {
    const headline = VERUS_HEADLINE.exec(line)?.[1];
    if (line.trim() === "" || VERUS_DIAGNOSTIC.test(line)) open = null;
    if (headline !== undefined && !VERUS_ABORTING.test(headline)) {
      open = { title: headline, location: null, labels: [] };
      code = null;
      errors.push(open);
      continue;
    }
    if (open === null) continue;
    const location = VERUS_LOCATION.exec(line)?.[1];
    const label = VERUS_LABEL.exec(line)?.[1];
    const quoted = VERUS_CODE.exec(line)?.[1];
    if (location !== undefined) open.location ??= location.trim();
    else if (label !== undefined) open.labels.push(code === null ? label : `${label}: ${code}`);
    else if (quoted !== undefined && !VERUS_MARKER.test(line)) code = quoted.trim();
  }
  const failures = errors.flatMap(({ title, location, labels }) => [
    location === null ? title : `${location}: ${title}`,
    ...labels.map((label) => `  ${label}`),
  ]);
  return judged(
    run,
    failures,
    linesOf(run.output).find((line) => VERUS_SUMMARY.test(line)),
  );
}

/** One node's run: written to proofs.json, or not run because `{files}` would be empty. */
export type NodeRun =
  | { readonly kind: "proved"; readonly id: StateName; readonly entry: ProofEntry }
  | { readonly kind: "skipped"; readonly id: StateName; readonly reason: string };

export type ProveOutcome =
  /** The config has no usable `proof`: nothing ran. `warnings` are the config's own. */
  | { readonly kind: "unconfigured"; readonly warnings: readonly ScanWarning[] }
  /** The prover could not be started: nothing was written. */
  | { readonly kind: "missing"; readonly program: string; readonly reason: string }
  | { readonly kind: "ran"; readonly prover: Prover; readonly runs: readonly NodeRun[] };

type Spawned =
  | { readonly kind: "exited"; readonly run: ProofRun }
  | { readonly kind: "killed"; readonly output: string; readonly signal: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "missing"; readonly reason: string };

/**
 * `everypath prove`. Analyzes without writing, runs the prover once per node that requires a proof,
 * then writes their entries into `.everypath/proofs.json`, the only file it writes in the repository
 * (R-01). Each run's working directory is a fresh temporary one, so what a prover writes there never
 * lands in the repository.
 */
export async function prove(
  root: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    report = () => {},
  }: {
    readonly timeoutMs?: number;
    /** Told of each node as soon as its run ends, before anything is written. */
    readonly report?: (run: NodeRun) => void;
  } = {},
): Promise<ProveOutcome> {
  const { graph } = await analyze(root);
  const { prover } = graph;
  if (prover === undefined) {
    return {
      kind: "unconfigured",
      warnings: graph.warnings.filter((warning) => warning.file === CONFIG_FILE),
    };
  }
  const [program = "", ...words] = prover.command.split(/\s+/).filter((word) => word !== "");
  const executable =
    program.includes("/") && !isAbsolute(program) ? resolve(graph.root, program) : program;
  const runs: NodeRun[] = [];
  const record = (run: NodeRun): void => {
    runs.push(run);
    report(run);
  };
  for (const node of graph.nodes.filter((candidate) => candidate.status.requireProof)) {
    const files = filesOf(prover.tool, node);
    if (words.includes(FILES) && files.length === 0) {
      const wanted = TOOLS[prover.tool].extension ?? "";
      record({ kind: "skipped", id: node.id, reason: `${wanted} のファイルがありません` });
      continue;
    }
    const args = words.flatMap((word) =>
      word === FILES ? files.map((file) => join(graph.root, file)) : [word],
    );
    const at = new Date().toISOString();
    const spawned = await runProver(executable, args, timeoutMs);
    if (spawned.kind === "missing") return { kind: "missing", program, reason: spawned.reason };
    const verdict = judge(prover.tool, spawned, graph.root, timeoutMs);
    record({
      kind: "proved",
      id: node.id,
      entry: {
        result: verdict.result,
        tool: prover.tool,
        message: verdict.message,
        at,
        hash: node.hash,
      },
    });
  }
  const entries = new Map(
    runs.flatMap((run) => (run.kind === "proved" ? [[run.id, run.entry]] : [])),
  );
  if (entries.size > 0) await writeProofs(graph.root, entries);
  return { kind: "ran", prover, runs };
}

function filesOf(tool: ProofTool, node: StateNode): readonly string[] {
  const { extension } = TOOLS[tool];
  return extension === null
    ? node.files
    : node.files.filter((file) => posix.extname(file) === extension);
}

/** The prover was handed absolute paths: its message shows them from the repository's root. */
function judge(
  tool: ProofTool,
  spawned: Exclude<Spawned, { kind: "missing" }>,
  root: string,
  timeoutMs: number,
): Verdict {
  const fromRoot = (output: string): string => output.replaceAll(`${root}${sep}`, "");
  switch (spawned.kind) {
    case "exited":
      return readProofOutput(tool, { ...spawned.run, output: fromRoot(spawned.run.output) });
    case "killed":
      return failedWith(`シグナル ${spawned.signal} で止まりました`, fromRoot(spawned.output));
    case "timeout":
      return { result: "failed", message: `${timeoutMs / 1000} 秒で終わらなかったので止めました` };
  }
}

/**
 * Runs one prover in a temporary directory with stdout and stderr interleaved. On POSIX it leads a
 * process group of its own, so a time-out, and a Ctrl+C or SIGTERM to `everypath prove`, stop what
 * it started too (Dafny starts Z3); otherwise the pipes would stay open until those finished.
 */
async function runProver(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<Spawned> {
  const directory = await mkdtemp(join(tmpdir(), "everypath-prove-"));
  const grouped = process.platform !== "win32";
  try {
    return await new Promise<Spawned>((settle) => {
      const child = spawn(executable, args, {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
        detached: grouped,
      });
      let output = "";
      let timedOut = false;
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8").on("data", (chunk: string) => {
          if (output.length < MAX_OUTPUT) output += chunk.slice(0, MAX_OUTPUT - output.length);
        });
      }
      const stop = (): void => {
        try {
          if (grouped && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const forward = (signal: NodeJS.Signals): void => {
        stop();
        release();
        process.kill(process.pid, signal);
      };
      const release = (): void => {
        clearTimeout(timer);
        process.off("SIGINT", forward);
        process.off("SIGTERM", forward);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      process.on("SIGINT", forward);
      process.on("SIGTERM", forward);
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (child.pid !== undefined) return;
        release();
        settle({ kind: "missing", reason: startFailure(error) });
      });
      child.on("close", (code, signal) => {
        release();
        if (timedOut) settle({ kind: "timeout" });
        else if (code === null) settle({ kind: "killed", output, signal: signal ?? "?" });
        else settle({ kind: "exited", run: { output, code } });
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function startFailure(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case "ENOENT":
      return "見つかりません（PATH にないか、パスが違います）";
    case "EACCES":
      return "実行できません（実行の権限を確かめてください）";
    default:
      return `起動できません（${errorMessage(error)}）`;
  }
}
