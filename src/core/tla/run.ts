import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "../json.js";
import { analyze } from "../scan.js";
import type { Counterexample, PropertyResult } from "../types.js";
import { commitTlc, OUTPUT_DIRECTORY, replaceFile, writeTlaModel } from "../workspace.js";
import { generateTla, modelKey, type TlaModel, TYPE_OK } from "./generate.js";
import { parseTlcOutput, type TlcReport } from "./parse.js";
import type { TlcRecord } from "./result.js";

export type InstallSource = { readonly url: string; readonly sha256: string };

/** SPEC §10.3. Pinned to v1.7.4: the hash is checked before the jar is renamed into place. */
const RELEASE: InstallSource = {
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
};
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** `check --tlc` without `--timeout`, and every run the server starts. */
const DEFAULT_TIMEOUT_MS = 120_000;

type TlcRun =
  | { readonly kind: "missing"; readonly what: "java" | "jar"; readonly jar: string }
  | { readonly kind: "exited"; readonly output: string }
  | { readonly kind: "timeout"; readonly output: string };

type Missing = Extract<TlcRun, { readonly kind: "missing" }>;

/** How a TLC run ended. Only `checked` has verdicts, and nothing is written until they are committed. */
export type TlcOutcome =
  /** R-03: the Japanese lines that say what is missing and how to install it. */
  | { readonly kind: "missing"; readonly guide: readonly string[] }
  /** No model could be generated, so TLC never ran. */
  | { readonly kind: "unmodeled"; readonly reason: string }
  | { readonly kind: "checked"; readonly record: TlcRecord };

/**
 * `$EVERYPATH_TLA_JAR`, else `~/.everypath/tla2tools.jar`. Where both `check --tlc` and `tla install`
 * look. Absolute, because TLC runs in another directory.
 */
function jarPath(): string {
  const configured = process.env.EVERYPATH_TLA_JAR;
  return configured ? resolve(configured) : join(homedir(), ".everypath", "tla2tools.jar");
}

/**
 * Analyzes without writing, generates the model and runs TLC in a directory of its own until every
 * invariant and leads-to has a verdict or the budget is spent. It writes nothing in the repository:
 * a run can take minutes, and only the caller knows when its record may land (`commitTlc`). `signal`
 * kills TLC and rejects with the abort reason.
 */
export async function runTlc(
  root: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  }: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<TlcOutcome> {
  const at = new Date();
  const { graph, properties } = await analyze(root, { now: at });
  const jar = jarPath();
  const absent = await missingTool(jar);
  if (absent !== null) return { kind: "missing", guide: installGuide(absent) };

  const generated = generateTla(graph, properties);
  if (!generated.ok) return { kind: "unmodeled", reason: generated.reason };
  const { model } = generated;
  const directory = await mkdtemp(join(tmpdir(), "everypath-tla-"));
  try {
    await writeFile(join(directory, "Model.tla"), model.tla);
    const outcome = await verify(directory, jar, model, timeoutMs, signal);
    if (outcome.kind === "missing") return { kind: "missing", guide: installGuide(outcome) };
    const record: TlcRecord = {
      version: 1,
      checkedAt: at.toISOString(),
      key: modelKey(model),
      tla: model.tla,
      cfg: everyCheck(model),
      names: model.names,
      properties: recorded(graph.properties, decisions(outcome.verdicts, model), at),
      typeOk: outcome.verdicts.get(TYPE_OK)?.counterexamples[0] ?? null,
      states: outcome.states,
      error: outcome.error,
    };
    return { kind: "checked", record };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** `everypath check --tlc`: the run, then its record, in sequence. The CLI scans after it. */
export async function checkTlc(
  root: string,
  options: { readonly timeoutMs?: number },
): Promise<TlcOutcome> {
  const outcome = await runTlc(root, options);
  if (outcome.kind === "checked") await commitTlc(root, outcome.record);
  return outcome;
}

/** R-03: without Java or the jar the quick check still decides, and this says how to get TLC. */
function installGuide({ what, jar }: Missing): string[] {
  const reason =
    what === "java"
      ? "java を実行できません（PATH に java が無いか、動きません。Java 11 以降が要ります）"
      : `${jar} に tla2tools.jar がありません`;
  return [
    `TLC を動かせません: ${reason}`,
    "  jar は everypath tla install で入ります（EVERYPATH_TLA_JAR、既定 ~/.everypath/tla2tools.jar）",
    "  簡易検査の結果だけで判定します",
  ];
}

/** `everypath tla export`. Model.tla and Model.cfg only: no graph.json, no TLC. */
export async function exportTla(root: string): Promise<
  | {
      readonly ok: true;
      readonly directory: string;
      readonly rejected: TlaModel["rejected"];
    }
  | { readonly ok: false; readonly reason: string }
> {
  const { graph, properties } = await analyze(root);
  const generated = generateTla(graph, properties);
  if (!generated.ok) return { ok: false, reason: generated.reason };
  await writeTlaModel(graph.root, { tla: generated.model.tla, cfg: everyCheck(generated.model) });
  return { ok: true, directory: `${OUTPUT_DIRECTORY}/tla`, rejected: generated.model.rejected };
}

/**
 * `everypath tla install`. `source` null is the pinned release. The jar is written beside its place
 * and renamed only after the hash matched, so a failed install leaves no jar and keeps the old one.
 */
export async function installTla(
  source: InstallSource | null,
): Promise<
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }
> {
  const { url, sha256 } = source ?? RELEASE;
  let bytes: Uint8Array;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      return {
        ok: false,
        reason: `ダウンロードできません: ${url} が ${response.status} を返しました`,
      };
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, reason: `ダウンロードできません: ${url}（${errorMessage(error)}）` };
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256.toLowerCase()) {
    return {
      ok: false,
      reason: `sha256 が一致しません（期待 ${sha256}、実際 ${actual}）。jar は置きませんでした`,
    };
  }
  const path = jarPath();
  await mkdir(dirname(path), { recursive: true });
  await replaceFile(path, bytes);
  return { ok: true, path };
}

/** The Model.cfg a person opens: every check at once. */
function everyCheck(model: TlaModel): string {
  return model.cfg([...model.invariants, ...model.temporal]);
}

/** The jar is a file and `java -version` succeeds. A macOS stub with no JDK behind it exits non-zero. */
async function missingTool(jar: string): Promise<Missing | null> {
  const isFile = await stat(jar).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!isFile) return { kind: "missing", what: "jar", jar };
  const works = await new Promise<boolean>((resolve) => {
    const child = spawn("java", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return works ? null : { kind: "missing", what: "java", jar };
}

/**
 * `java -XX:+UseParallelGC -jar <jar> -workers auto -deadlock -config Model.cfg -metadir <tmp> Model.tla`
 * in `directory`, stdout and stderr interleaved. Killed after `budgetMs` or by `signal`. `-deadlock` keeps a state
 * with no exit (ロック) from counting as an error. TLC writes nothing outside the metadir.
 */
async function runJava(
  directory: string,
  jar: string,
  budgetMs: number,
  signal: AbortSignal | undefined,
): Promise<TlcRun> {
  const metadir = await mkdtemp(join(tmpdir(), "everypath-tlc-"));
  try {
    return await new Promise<TlcRun>((resolve) => {
      const args = ["-XX:+UseParallelGC", "-jar", jar, "-workers", "auto", "-deadlock"];
      const child = spawn(
        "java",
        [...args, "-config", "Model.cfg", "-metadir", metadir, "Model.tla"],
        { cwd: directory, stdio: ["ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" },
      );
      let output = "";
      let timedOut = false;
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
        });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, budgetMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ kind: "missing", what: "java", jar });
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve({ kind: timedOut ? "timeout" : "exited", output });
      });
    });
  } finally {
    await rm(metadir, { recursive: true, force: true });
  }
}

type Verdict = Pick<PropertyResult, "result" | "counterexamples" | "statesExplored">;

const holds = (states: number | null): Verdict => ({
  result: "ok",
  counterexamples: [],
  statesExplored: states,
});

const refuted = (trace: Counterexample, states: number | null): Verdict => ({
  result: "violated",
  counterexamples: [trace],
  statesExplored: states,
});

const undecided = (states: number | null): Verdict => ({
  result: "error",
  counterexamples: [],
  statesExplored: states,
});

/** The open check a violation is about. A temporal violation names none, so it fits a run of one. */
function culprit(check: string | null, open: readonly string[]): string | undefined {
  if (check === null) return open.length === 1 ? open[0] : undefined;
  return open.includes(check) ? check : undefined;
}

type Verified =
  | Missing
  | {
      readonly kind: "done";
      /** By check name, `TypeOK` included. */
      readonly verdicts: ReadonlyMap<string, Verdict>;
      /** The last count TLC printed: every run explores the same reachable states. */
      readonly states: number | null;
      readonly error: string | null;
    };

/**
 * TLC stops at the first violated invariant and does not name a violated temporal property. So all
 * invariants run together and a violated one is recorded and dropped before the rest run again, and
 * each leads-to runs alone. Every pass of the loop settles at least one check, so it ends. One
 * deadline covers every run; once it passes, each check still open is an error.
 */
async function verify(
  directory: string,
  jar: string,
  model: TlaModel,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Verified> {
  const deadline = Date.now() + timeoutMs;
  const verdicts = new Map<string, Verdict>();
  let error: string | null = null;
  let states: number | null = null;

  const fail = (message: string): TlcReport => {
    error ??= message;
    return { kind: "error", message, distinctStates: states };
  };
  const once = async (checks: readonly string[]): Promise<TlcReport | Missing> => {
    const timeout = `タイムアウトしました（${timeoutMs / 1000} 秒）`;
    const left = deadline - Date.now();
    if (left <= 0) return fail(timeout);
    signal?.throwIfAborted();
    await writeFile(join(directory, "Model.cfg"), model.cfg(checks));
    const run = await runJava(directory, jar, left, signal);
    signal?.throwIfAborted();
    if (run.kind === "missing") return run;
    const report = parseTlcOutput(run.output, model.names);
    states = report.distinctStates ?? states;
    if (run.kind === "timeout") return fail(timeout);
    if (report.kind === "error") error ??= report.message;
    return report;
  };

  for (const round of [model.invariants, ...model.temporal.map((check) => [check])]) {
    let open: readonly string[] = round;
    while (open.length > 0) {
      const report = await once(open);
      if (report.kind === "missing") return report;
      const guilty = report.kind === "violated" ? culprit(report.check, open) : undefined;
      if (report.kind === "ok") {
        for (const check of open) verdicts.set(check, holds(report.distinctStates));
        open = [];
      } else if (report.kind === "violated" && guilty !== undefined) {
        verdicts.set(guilty, refuted(report.trace, report.distinctStates));
        open = open.filter((check) => check !== guilty);
      } else {
        if (report.kind === "violated") fail("TLC が想定外の性質の違反を報告しました");
        for (const check of open) verdicts.set(check, undecided(states));
        open = [];
      }
    }
  }
  return { kind: "done", verdicts, states, error };
}

/**
 * Each check's verdict under its property id. A definition the model left out never ran, so it gets
 * none: a stored verdict would outlive the definition it was about.
 */
function decisions(
  verdicts: ReadonlyMap<string, Verdict>,
  { names }: Pick<TlaModel, "names">,
): Map<string, Verdict> {
  const decided = new Map<string, Verdict>();
  for (const [check, id] of Object.entries(names.checks)) {
    const verdict = verdicts.get(check);
    if (check !== TYPE_OK && verdict !== undefined) decided.set(id, verdict);
  }
  return decided;
}

/**
 * The record's results: each property TLC decided, in file order. `checkedBy` follows from what the
 * quick check did, which `analyzed` still says because an earlier record never changes `checkedBy`:
 * a variable-free invariant it settled is `both`, one it left to TLC is `tlc`.
 */
function recorded(
  analyzed: readonly PropertyResult[],
  decided: ReadonlyMap<string, Verdict>,
  at: Date,
): PropertyResult[] {
  return analyzed.flatMap((result): PropertyResult[] => {
    const verdict = decided.get(result.id);
    if (verdict === undefined) return [];
    const { id, kind, description } = result;
    const checkedBy = result.checkedBy === "tlc" ? "tlc" : "both";
    return [{ id, kind, description, ...verdict, checkedBy, checkedAt: at.toISOString() }];
  });
}
