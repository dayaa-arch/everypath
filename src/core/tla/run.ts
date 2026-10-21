import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { errorMessage } from "../json.js";
import { PROPERTIES_FILE, violationsOf } from "../properties.js";
import { analyze } from "../scan.js";
import type { Counterexample, Graph, PropertyResult, ScanWarning } from "../types.js";
import { OUTPUT_DIRECTORY, replaceFile, writeWorkspace } from "../workspace.js";
import { generateTla, type TlaModel, type TlaNames, TYPE_OK } from "./generate.js";
import { parseTlcOutput, type TlcReport } from "./parse.js";

/** SPEC §10.3. Pinned to v1.7.4: the hash is checked before the jar is renamed into place. */
const RELEASE: InstallSource = {
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
};
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type InstallSource = { readonly url: string; readonly sha256: string };

/** What happened to one `java` process. */
type TlcRun =
  | { readonly kind: "missing"; readonly what: "java" | "jar"; readonly jar: string }
  | { readonly kind: "exited"; readonly output: string }
  | { readonly kind: "timeout"; readonly output: string };

type Missing = Extract<TlcRun, { readonly kind: "missing" }>;

/** `.everypath/tla/result.json`: what TLC decided, and the table that reads its identifiers. */
type ResultFile = {
  readonly version: 1;
  readonly checkedAt: string;
  readonly names: TlaNames;
  readonly properties: PropertyResult[];
  readonly typeOk: Counterexample | null;
  readonly error: string | null;
};

/** What `check --tlc` leaves for the CLI. `graph` is what was written to graph.json. */
export type TlcCheck =
  | {
      readonly kind: "missing";
      readonly what: "java" | "jar";
      readonly jar: string;
      readonly graph: Graph;
    }
  | {
      readonly kind: "checked";
      readonly graph: Graph;
      /** The variables left their declared ranges. */
      readonly typeOk: Counterexample | null;
      /** The first TLC error, timeout or generation failure. Any non-null value fails the check. */
      readonly error: string | null;
    };

/** `$EVERYPATH_TLA_JAR`, else `~/.everypath/tla2tools.jar`. Where both `check --tlc` and `tla install` look. */
function jarPath(): string {
  const configured = process.env.EVERYPATH_TLA_JAR;
  return configured ? configured : join(homedir(), ".everypath", "tla2tools.jar");
}

/**
 * `everypath check --tlc`. Analyzes without writing, generates the model, runs TLC until every
 * invariant and leads-to has a verdict or the budget is spent, merges, and writes `result.json`
 * and then `graph.json`. Without Java or the jar it writes the quick check's graph and says so (R-03).
 */
export async function checkTlc(
  root: string,
  { timeoutMs }: { readonly timeoutMs: number },
): Promise<TlcCheck> {
  const at = new Date();
  const { graph, properties, history } = await analyze(root, { now: at, reason: "check" });
  const jar = jarPath();
  const unavailable = async (absent: Missing): Promise<TlcCheck> => {
    await writeWorkspace(graph.root, graph, history);
    return { ...absent, graph };
  };

  const absent = await missingTool(jar);
  if (absent !== null) return unavailable(absent);

  const generated = generateTla(graph, properties);
  if (!generated.ok) {
    const stuck = graph.properties.filter((p) => p.checkedBy === "tlc" && p.result === "pending");
    const merged = merge(graph, new Map(stuck.map((p) => [p.id, undecided(null)])), [], at);
    await writeWorkspace(graph.root, merged, history);
    return { kind: "checked", graph: merged, typeOk: null, error: generated.reason };
  }

  const { model } = generated;
  const directory = join(graph.root, OUTPUT_DIRECTORY, "tla");
  await writeModel(directory, model);
  const outcome = await verify(directory, jar, model, timeoutMs);
  await writeModel(directory, model);
  if (outcome.kind === "missing") return unavailable(outcome);

  const merged = merge(graph, decisions(outcome.verdicts, model), rejectionWarnings(model), at);
  const typeOk = outcome.verdicts.get(TYPE_OK)?.counterexamples[0] ?? null;
  const stored: ResultFile = {
    version: 1,
    checkedAt: at.toISOString(),
    names: model.names,
    properties: merged.properties.filter((p) => p.checkedBy !== "bfs"),
    typeOk,
    error: outcome.error,
  };
  await replaceFile(join(directory, "result.json"), `${JSON.stringify(stored, null, 2)}\n`);
  await writeWorkspace(graph.root, merged, history);
  return { kind: "checked", graph: merged, typeOk, error: outcome.error };
}

/** `everypath tla export`. Model.tla and Model.cfg only: no graph.json, no TLC. */
export async function exportTla(root: string): Promise<
  | {
      readonly ok: true;
      /** Root-relative, for the message. */
      readonly directory: string;
      readonly rejected: TlaModel["rejected"];
    }
  | { readonly ok: false; readonly reason: string }
> {
  const { graph, properties } = await analyze(root);
  const generated = generateTla(graph, properties);
  if (!generated.ok) return { ok: false, reason: generated.reason };
  await writeModel(join(graph.root, OUTPUT_DIRECTORY, "tla"), generated.model);
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

/** Model.tla and a Model.cfg over every check: what `tla export` writes and `check --tlc` leaves behind. */
async function writeModel(directory: string, model: TlaModel): Promise<void> {
  await mkdir(directory, { recursive: true });
  await replaceFile(join(directory, "Model.tla"), model.tla);
  await replaceFile(
    join(directory, "Model.cfg"),
    model.cfg([...model.invariants, ...model.temporal]),
  );
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
 * in `directory`, stdout and stderr interleaved. Killed after `budgetMs`. `-deadlock` keeps a state
 * with no exit (ロック) from counting as an error. TLC writes nothing outside the metadir.
 */
async function runTlc(directory: string, jar: string, budgetMs: number): Promise<TlcRun> {
  const metadir = await mkdtemp(join(tmpdir(), "everypath-tlc-"));
  try {
    return await new Promise<TlcRun>((resolve) => {
      const args = ["-XX:+UseParallelGC", "-jar", jar, "-workers", "auto", "-deadlock"];
      const child = spawn(
        "java",
        [...args, "-config", "Model.cfg", "-metadir", metadir, "Model.tla"],
        { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
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
    await replaceFile(join(directory, "Model.cfg"), model.cfg(checks));
    const run = await runTlc(directory, jar, left);
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
  return { kind: "done", verdicts, error };
}

/** Each check's verdict under its property id. A rejected definition never ran, so it is an error. */
function decisions(
  verdicts: ReadonlyMap<string, Verdict>,
  { names, rejected }: Pick<TlaModel, "names" | "rejected">,
): Map<string, Verdict> {
  const decided = new Map<string, Verdict>();
  for (const [check, id] of Object.entries(names.checks)) {
    const verdict = verdicts.get(check);
    if (check !== TYPE_OK && verdict !== undefined) decided.set(id, verdict);
  }
  for (const { id } of rejected) decided.set(id, undecided(null));
  return decided;
}

/**
 * Replaces the results TLC decided by id and keeps file order. `checkedBy` follows from what the quick
 * check already did: a variable-free invariant it settled becomes `both`, one it left pending is `tlc`.
 * `warnings` go after the scan's own, one per rejected definition: a properties-file warning already
 * fails the check.
 */
function merge(
  graph: Graph,
  decided: ReadonlyMap<string, Verdict>,
  warnings: readonly ScanWarning[],
  at: Date,
): Graph {
  const properties = graph.properties.map((result): PropertyResult => {
    const verdict = decided.get(result.id);
    if (verdict === undefined) return result;
    const checkedBy = result.checkedBy === "bfs" ? "both" : "tlc";
    return { ...result, ...verdict, checkedBy, checkedAt: at.toISOString() };
  });
  const violations = violationsOf(properties);
  return {
    ...graph,
    properties,
    nodes: graph.nodes.map((node) => ({ ...node, violations: violations.get(node.id) ?? [] })),
    warnings: [...graph.warnings, ...warnings],
  };
}

function rejectionWarnings({ rejected }: Pick<TlaModel, "rejected">): ScanWarning[] {
  return rejected.map(({ reason }) => ({
    file: PROPERTIES_FILE,
    line: null,
    message: reason,
    detail: null,
  }));
}
