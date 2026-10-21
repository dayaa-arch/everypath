#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "./core/json.js";
import { PROPERTIES_FILE } from "./core/properties.js";
import { scan } from "./core/scan.js";
import {
  checkTlc,
  exportTla,
  type InstallSource,
  installTla,
  type TlcCheck,
} from "./core/tla/run.js";
import type { Counterexample, Graph, PropertyResult, ScanWarning } from "./core/types.js";
import { serializeGraph } from "./core/workspace.js";

const USAGE = [
  "使い方: everypath scan [dir] [--json] [--quiet]",
  "        everypath check [dir] [--tlc [--timeout 秒]]",
  "        everypath tla export [dir]",
  "        everypath tla install",
].join("\n");
const USAGE_ERROR = 2;
const DEFAULT_TIMEOUT_SECONDS = 120;

type Label = "scan" | "check" | "tla export" | "tla install";

/** The options each command takes; `--help` goes with every one. */
const ACCEPTS: Readonly<Record<Label, readonly string[]>> = {
  scan: ["json", "quiet"],
  check: ["tlc", "timeout"],
  "tla export": [],
  "tla install": [],
};
const OPTIONS: ReadonlySet<string> = new Set(["help", ...Object.values(ACCEPTS).flat()]);

type Command =
  | { readonly kind: "help" }
  | {
      readonly kind: "scan";
      readonly directory: string;
      readonly json: boolean;
      readonly quiet: boolean;
    }
  | {
      readonly kind: "check";
      readonly directory: string;
      /** `null` without `--tlc`. */
      readonly tlc: { readonly timeoutMs: number } | null;
    }
  | { readonly kind: "tla-export"; readonly directory: string }
  | { readonly kind: "tla-install"; readonly source: InstallSource | null };

type Parsed =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly message: string };

type Values = Readonly<Record<string, string | boolean | undefined>>;

function usage(message: string): Parsed {
  return { ok: false, message };
}

/** An option the command does not take is a message, so `scan --tlc` is not silently a plain scan. */
function unaccepted(label: Label, values: Values): string | null {
  const refused = Object.keys(values).filter(
    (key) => key !== "help" && !ACCEPTS[label].includes(key),
  );
  return refused.length === 0
    ? null
    : `${label} は ${refused.map((key) => `--${key}`).join(" ")} を受け付けません`;
}

function parseTlc(values: Values): { readonly timeoutMs: number } | null | string {
  if (values.tlc !== true) {
    return values.timeout === undefined ? null : "--timeout は --tlc と一緒に使います";
  }
  const seconds = values.timeout ?? String(DEFAULT_TIMEOUT_SECONDS);
  if (typeof seconds !== "string" || !/^[1-9]\d*$/.test(seconds)) {
    return "--timeout は 1 以上の整数（秒）にしてください";
  }
  return { timeoutMs: Number(seconds) * 1000 };
}

/** Both variables or neither: a URL with no hash, or a hash with no URL, would install something unchecked or nothing. */
function parseInstallSource(env: NodeJS.ProcessEnv): InstallSource | null | string {
  const url = env.EVERYPATH_TLA_URL ?? "";
  const sha256 = env.EVERYPATH_TLA_SHA256 ?? "";
  if (url === "" && sha256 === "") return null;
  if (sha256 === "")
    return "EVERYPATH_TLA_URL を使うときは EVERYPATH_TLA_SHA256 も指定してください";
  if (url === "") return "EVERYPATH_TLA_SHA256 を使うときは EVERYPATH_TLA_URL も指定してください";
  if (!/^[0-9a-f]{64}$/i.test(sha256))
    return "EVERYPATH_TLA_SHA256 は 64 桁の 16 進数にしてください";
  return { url, sha256 };
}

/** The command line and the install variables are a boundary: whatever was typed becomes a `Command` or a message. */
function parseCommand(args: readonly string[], env: NodeJS.ProcessEnv): Parsed {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: "boolean" },
        quiet: { type: "boolean" },
        tlc: { type: "boolean" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const unknown = Object.keys(values).filter((key) => !OPTIONS.has(key));
    if (unknown.length > 0) {
      return usage(`未知のオプションです: ${unknown.map((key) => `--${key}`).join(" ")}`);
    }
    if (values.help) return { ok: true, command: { kind: "help" } };
    const [name, second, ...others] = positionals;
    if (name === undefined) return usage("コマンドがありません");
    const unknownCommand = usage(`未知のコマンドか引数です: ${positionals.join(" ")}`);

    if (name === "tla") {
      if (second === undefined) return usage("tla には export か install を指定してください");
      if (second === "export" && others.length <= 1) {
        const refused = unaccepted("tla export", values);
        if (refused !== null) return usage(refused);
        return { ok: true, command: { kind: "tla-export", directory: others[0] ?? "." } };
      }
      if (second === "install" && others.length === 0) {
        const refused = unaccepted("tla install", values);
        if (refused !== null) return usage(refused);
        const source = parseInstallSource(env);
        return typeof source === "string"
          ? usage(source)
          : { ok: true, command: { kind: "tla-install", source } };
      }
      return unknownCommand;
    }

    if ((name !== "scan" && name !== "check") || others.length > 0) return unknownCommand;
    const directory = second ?? ".";
    const refused = unaccepted(name, values);
    if (refused !== null) return usage(refused);
    if (name === "check") {
      const tlc = parseTlc(values);
      return typeof tlc === "string"
        ? usage(tlc)
        : { ok: true, command: { kind: "check", directory, tlc } };
    }
    return {
      ok: true,
      command: {
        kind: "scan",
        directory,
        json: values.json === true,
        quiet: values.quiet === true,
      },
    };
  } catch (error) {
    return usage(errorMessage(error));
  }
}

function describeWarning({ file, line, message }: ScanWarning): string {
  const place = file === null ? "" : line === null ? `${file}: ` : `${file}:${line}: `;
  return `  警告 ${place}${message}`;
}

function summarize(graph: Graph): string {
  const flows = graph.edges.filter((edge) => edge.type === "flow").length;
  const counts = `状態 ${graph.nodes.length}、遷移 ${flows}、依存 ${graph.edges.length - flows}、警告 ${graph.warnings.length}`;
  return `スキャン完了: ${counts}（.everypath/graph.json に書きました）`;
}

const STATUS_WORDS: Readonly<Record<PropertyResult["result"], string>> = {
  violated: "違反",
  ok: "成立",
  pending: "保留",
  error: "エラー",
};

/** `ログイン →(forgot) パスワードリセット`. An edge with no event is a bare arrow. */
function formatPath({ steps }: Counterexample): string {
  const [first, ...rest] = steps;
  return rest.reduce<string>(
    (text, { event, state }) => `${text} →${event === null ? "" : `(${event})`} ${state}`,
    first.state,
  );
}

/**
 * One numbered line per step with the variables: `2. →(reset_done) Home（authed=FALSE, retries=0）`.
 * A behavior that never ends says where it goes back to. Without variables there are no parentheses.
 */
function describeSteps({ steps, loopStart }: Counterexample): string[] {
  const lines = steps.map(({ state, event, vars }, index) => {
    const arrow = index === 0 ? "" : `→${event === null ? "" : `(${event})`} `;
    const values = Object.entries(vars).map(([name, value]) => `${name}=${value}`);
    return `  ${index + 1}. ${arrow}${state}${values.length === 0 ? "" : `（${values.join(", ")}）`}`;
  });
  return loopStart === null ? lines : [...lines, `  → ${loopStart + 1} に戻って繰り返す`];
}

function describeProperty({
  id,
  kind,
  description,
  result,
  checkedBy,
  counterexamples,
}: PropertyResult): string[] {
  const title = `${STATUS_WORDS[result]} ${id} [${kind}]${description === null ? "" : ` ${description}`}`;
  if (result === "pending") {
    const reason =
      checkedBy === "tlc"
        ? "TLC の検査待ちです（everypath check --tlc）"
        : `${kind} の簡易検査はまだありません`;
    return [title, `  ${reason}`];
  }
  const describe = (example: Counterexample): string[] =>
    checkedBy === "bfs" ? [`  ${formatPath(example)}`] : describeSteps(example);
  return [title, ...counterexamples.flatMap(describe)];
}

function summarizeChecks({ properties, warnings }: Graph): string {
  const counts = Object.entries(STATUS_WORDS).flatMap(([result, word]) => {
    const count = properties.filter((p) => p.result === result).length;
    return count > 0 ? [`${word} ${count}`] : [];
  });
  const rejected = warnings.filter((warning) => warning.file === PROPERTIES_FILE).length;
  const note = rejected > 0 ? `（${PROPERTIES_FILE} の警告 ${rejected} 件）` : "";
  return `性質 ${properties.length} 件: ${counts.join("、")}${note}`;
}

/** `extra` is what only TLC can say, printed before the count. */
function reportChecks(graph: Graph, extra: readonly string[]): string[] {
  if (graph.properties.length === 0) return [`性質がありません（${PROPERTIES_FILE}）`, ...extra];
  return [...graph.properties.flatMap(describeProperty), ...extra, summarizeChecks(graph)];
}

/** R-03: without Java or the jar the quick check still decides, and this says how to get TLC. */
function describeMissing({ what, jar }: Extract<TlcCheck, { readonly kind: "missing" }>): string[] {
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

function describeChecked({
  typeOk,
  error,
}: Extract<TlcCheck, { readonly kind: "checked" }>): string[] {
  return [
    ...(typeOk === null
      ? []
      : ["違反 TypeOK 変数が宣言した範囲を外れました", ...describeSteps(typeOk)]),
    ...(error === null ? [] : [`エラー TLC: ${error}`]),
  ];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function main(args: readonly string[]): Promise<number> {
  const parsed = parseCommand(args, process.env);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n${USAGE}\n`);
    return USAGE_ERROR;
  }
  const { command } = parsed;
  if (command.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (command.kind === "tla-install") return runInstall(command.source);

  const root = resolve(command.directory);
  if (!(await isDirectory(root))) {
    process.stderr.write(`ディレクトリが見つかりません: ${command.directory}\n`);
    return USAGE_ERROR;
  }
  switch (command.kind) {
    case "scan":
      return runScan(root, command);
    case "check":
      return runCheck(root, command.tlc);
    case "tla-export":
      return runExport(root);
  }
}

async function runScan(
  root: string,
  { json, quiet }: Extract<Command, { readonly kind: "scan" }>,
): Promise<number> {
  const graph = await scan(root);
  if (json) process.stdout.write(serializeGraph(graph));
  if (!quiet) {
    const lines = [summarize(graph), ...graph.warnings.map(describeWarning)];
    process.stderr.write(`${lines.join("\n")}\n`);
  }
  return 0;
}

/**
 * A property the file defines but the check could not read fails the run too, so CI never passes it
 * silently. So does any TLC error, which includes a property TLC could not decide, and a variable
 * out of its range. With `--tlc` but no Java or jar the quick check alone decides the exit code.
 */
async function runCheck(root: string, tlc: { readonly timeoutMs: number } | null): Promise<number> {
  const outcome = tlc === null ? null : await checkTlc(root, tlc);
  const graph = outcome?.graph ?? (await scan(root, { reason: "check" }));
  const stderr = graph.warnings.map(describeWarning);
  const extra = outcome?.kind === "checked" ? describeChecked(outcome) : [];
  if (outcome?.kind === "missing") stderr.push(...describeMissing(outcome));
  if (stderr.length > 0) process.stderr.write(`${stderr.join("\n")}\n`);
  process.stdout.write(`${reportChecks(graph, extra).join("\n")}\n`);

  const rejected = graph.warnings.some((warning) => warning.file === PROPERTIES_FILE);
  const violated = graph.properties.some((p) => p.result === "violated");
  const tlcFailed =
    outcome?.kind === "checked" && (outcome.typeOk !== null || outcome.error !== null);
  return rejected || violated || tlcFailed ? 1 : 0;
}

async function runExport(root: string): Promise<number> {
  const exported = await exportTla(root);
  if (!exported.ok) {
    process.stderr.write(`${exported.reason}\n`);
    return 1;
  }
  for (const { reason } of exported.rejected) process.stderr.write(`  警告 ${reason}\n`);
  process.stdout.write(`Model.tla と Model.cfg を ${exported.directory}/ に書きました\n`);
  return 0;
}

async function runInstall(source: InstallSource | null): Promise<number> {
  const installed = await installTla(source);
  if (!installed.ok) {
    process.stderr.write(`${installed.reason}\n`);
    return 1;
  }
  process.stdout.write(`tla2tools.jar を ${installed.path} に置きました\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`エラー: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
