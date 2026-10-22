#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorMessage } from "./core/json.js";
import { PROPERTIES_FILE } from "./core/properties.js";
import { scan } from "./core/scan.js";
import { rejectionWarnings } from "./core/tla/result.js";
import {
  checkTlc,
  exportTla,
  type InstallSource,
  installTla,
  summarizeTlc,
  type TlcSummary,
} from "./core/tla/run.js";
import type { Counterexample, Graph, PropertyResult, ScanWarning } from "./core/types.js";
import { serializeGraph } from "./core/workspace.js";
import { startServer } from "./server/server.js";

const USAGE = [
  "使い方: everypath scan [dir] [--json] [--quiet]",
  "        everypath check [dir] [--tlc [--timeout 秒]]",
  "        everypath tla export [dir]",
  "        everypath tla install",
  "        everypath serve [dir] [--port 4747] [--open]",
].join("\n");
const USAGE_ERROR = 2;
const DEFAULT_PORT = 4747;
/** `dist/ui.html` of this package, from `src/cli.ts` and from the built `dist/cli.js` alike. */
const UI_PATH = fileURLToPath(new URL("../dist/ui.html", import.meta.url));

type Label = "scan" | "check" | "tla export" | "tla install" | "serve";

/** The options each command takes; `--help` goes with every one. */
const ACCEPTS: Readonly<Record<Label, readonly string[]>> = {
  scan: ["json", "quiet"],
  check: ["tlc", "timeout"],
  "tla export": [],
  "tla install": [],
  serve: ["port", "open"],
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
      /** `timeoutMs` is absent without `--timeout`: the run's own default applies. */
      readonly tlc: { readonly timeoutMs?: number } | null;
    }
  | {
      readonly kind: "serve";
      readonly directory: string;
      /** 0 asks the system for a free port. */
      readonly port: number;
      readonly open: boolean;
    }
  | { readonly kind: "tla-export"; readonly directory: string }
  | { readonly kind: "tla-install"; readonly source: InstallSource | null };

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

type Values = Readonly<Record<string, string | boolean | undefined>>;

function refuse(message: string): Result<never> {
  return { ok: false, message };
}

function accept<T>(value: T): Result<T> {
  return { ok: true, value };
}

function unknownCommand(positionals: readonly string[]): Result<never> {
  return refuse(`未知のコマンドか引数です: ${positionals.join(" ")}`);
}

/** An option the command does not take is a message, so `scan --tlc` is not silently a plain scan. */
function unaccepted(label: Label, values: Values): Result<never> | null {
  const refused = Object.keys(values).filter(
    (key) => key !== "help" && !ACCEPTS[label].includes(key),
  );
  return refused.length === 0
    ? null
    : refuse(`${label} は ${refused.map((key) => `--${key}`).join(" ")} を受け付けません`);
}

function parseScan(positionals: readonly string[], values: Values): Result<Command> {
  const [, directory = ".", ...extra] = positionals;
  if (extra.length > 0) return unknownCommand(positionals);
  return (
    unaccepted("scan", values) ??
    accept({
      kind: "scan",
      directory,
      json: values.json === true,
      quiet: values.quiet === true,
    })
  );
}

function parseCheck(positionals: readonly string[], values: Values): Result<Command> {
  const [, directory = ".", ...extra] = positionals;
  if (extra.length > 0) return unknownCommand(positionals);
  const refused = unaccepted("check", values);
  if (refused !== null) return refused;
  if (values.tlc !== true) {
    return values.timeout === undefined
      ? accept({ kind: "check", directory, tlc: null })
      : refuse("--timeout は --tlc と一緒に使います");
  }
  const seconds = values.timeout;
  if (seconds === undefined) return accept({ kind: "check", directory, tlc: {} });
  if (typeof seconds !== "string" || !/^[1-9]\d*$/.test(seconds)) {
    return refuse("--timeout は 1 以上の整数（秒）にしてください");
  }
  return accept({ kind: "check", directory, tlc: { timeoutMs: Number(seconds) * 1000 } });
}

function parseServe(positionals: readonly string[], values: Values): Result<Command> {
  const [, directory = ".", ...extra] = positionals;
  if (extra.length > 0) return unknownCommand(positionals);
  const refused = unaccepted("serve", values);
  if (refused !== null) return refused;
  const port = values.port ?? String(DEFAULT_PORT);
  if (typeof port !== "string" || !/^\d+$/.test(port) || Number(port) > 65_535) {
    return refuse("--port は 0 から 65535 の整数にしてください");
  }
  return accept({ kind: "serve", directory, port: Number(port), open: values.open === true });
}

/** Both variables or neither: a URL with no hash, or a hash with no URL, would install something unchecked or nothing. */
function parseInstallSource(env: NodeJS.ProcessEnv): Result<InstallSource | null> {
  const url = env.EVERYPATH_TLA_URL ?? "";
  const sha256 = env.EVERYPATH_TLA_SHA256 ?? "";
  if (url === "" && sha256 === "") return accept(null);
  if (sha256 === "") {
    return refuse("EVERYPATH_TLA_URL を使うときは EVERYPATH_TLA_SHA256 も指定してください");
  }
  if (url === "") {
    return refuse("EVERYPATH_TLA_SHA256 を使うときは EVERYPATH_TLA_URL も指定してください");
  }
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    return refuse("EVERYPATH_TLA_SHA256 は 64 桁の 16 進数にしてください");
  }
  return accept({ url, sha256 });
}

function parseTla(
  positionals: readonly string[],
  values: Values,
  env: NodeJS.ProcessEnv,
): Result<Command> {
  const [, subcommand, ...rest] = positionals;
  switch (subcommand) {
    case undefined:
      return refuse("tla には export か install を指定してください");
    case "export":
      if (rest.length > 1) return unknownCommand(positionals);
      return (
        unaccepted("tla export", values) ??
        accept({ kind: "tla-export", directory: rest[0] ?? "." })
      );
    case "install": {
      if (rest.length > 0) return unknownCommand(positionals);
      const refused = unaccepted("tla install", values);
      if (refused !== null) return refused;
      const source = parseInstallSource(env);
      return source.ok ? accept({ kind: "tla-install", source: source.value }) : source;
    }
    default:
      return unknownCommand(positionals);
  }
}

/** The command line and the install variables are a boundary: whatever was typed becomes a `Command` or a message. */
function parseCommand(args: readonly string[], env: NodeJS.ProcessEnv): Result<Command> {
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
        port: { type: "string" },
        open: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    const unknown = Object.keys(values).filter((key) => !OPTIONS.has(key));
    if (unknown.length > 0) {
      return refuse(`未知のオプションです: ${unknown.map((key) => `--${key}`).join(" ")}`);
    }
    if (values.help) return accept({ kind: "help" });
    switch (positionals[0]) {
      case undefined:
        return refuse("コマンドがありません");
      case "scan":
        return parseScan(positionals, values);
      case "check":
        return parseCheck(positionals, values);
      case "tla":
        return parseTla(positionals, values, env);
      case "serve":
        return parseServe(positionals, values);
      default:
        return unknownCommand(positionals);
    }
  } catch (error) {
    return refuse(errorMessage(error));
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

const STALE = "古いモデルに対する結果";

function describeProperty({
  id,
  kind,
  description,
  result,
  checkedBy,
  counterexamples,
  staleModel,
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
  const stale = staleModel
    ? [
        `  ${STALE}です。TLC の実行後にモデルが変わったため、終了コードに数えません（everypath check --tlc で検査し直せます）`,
      ]
    : [];
  return [title, ...stale, ...counterexamples.flatMap(describe)];
}

function summarizeChecks(
  properties: Graph["properties"],
  warnings: readonly ScanWarning[],
): string {
  const counts = Object.entries(STATUS_WORDS).flatMap(([result, word]) => {
    const count = properties.filter((p) => p.result === result).length;
    return count > 0 ? [`${word} ${count}`] : [];
  });
  const rejected = warnings.filter((warning) => warning.file === PROPERTIES_FILE).length;
  const stale = properties.filter((p) => p.staleModel).length;
  const notes = [
    ...(rejected > 0 ? [`${PROPERTIES_FILE} の警告 ${rejected} 件`] : []),
    ...(stale > 0 ? [`${STALE} ${stale} 件`] : []),
  ];
  const note = notes.length > 0 ? `（${notes.join("、")}）` : "";
  return `性質 ${properties.length} 件: ${counts.join("、")}${note}`;
}

/** `extra` is what only TLC can say, printed before the count. */
function reportChecks(
  { properties }: Graph,
  warnings: readonly ScanWarning[],
  extra: readonly string[],
): string[] {
  if (properties.length === 0) return [`性質がありません（${PROPERTIES_FILE}）`, ...extra];
  return [...properties.flatMap(describeProperty), ...extra, summarizeChecks(properties, warnings)];
}

/** What only TLC can say: a variable out of its range, and its error. `null` when TLC did not fail. */
function tlcFailure(summary: TlcSummary | null): string[] | null {
  if (summary === null || summary.kind === "missing") return null;
  if (summary.kind === "unmodeled") return [`エラー TLC: ${summary.reason}`];
  const { typeOk, error } = summary;
  if (typeOk === null && error === null) return null;
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
  const command = parsed.value;
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
    case "serve":
      return runServe(root, command);
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
 * silently. Under `--tlc` so does a definition the model left out, and any TLC error, which includes
 * a property TLC could not decide, and a variable out of its range. With `--tlc` but no Java or jar
 * the quick check alone decides the exit code. The scan reads TLC's record, so a plain check also
 * counts the last run's violations, unless the model has changed since.
 */
async function runCheck(
  root: string,
  tlc: { readonly timeoutMs?: number } | null,
): Promise<number> {
  const summary = tlc === null ? null : summarizeTlc(await checkTlc(root, tlc));
  const graph = await scan(root, { reason: "check" });
  const warnings = [
    ...graph.warnings,
    ...(summary?.kind === "checked" ? rejectionWarnings(summary.rejected) : []),
  ];
  const stderr = warnings.map(describeWarning);
  const failure = tlcFailure(summary);
  if (summary?.kind === "missing") stderr.push(...summary.guide);
  if (stderr.length > 0) process.stderr.write(`${stderr.join("\n")}\n`);
  process.stdout.write(`${reportChecks(graph, warnings, failure ?? []).join("\n")}\n`);

  const rejected = warnings.some((warning) => warning.file === PROPERTIES_FILE);
  const violated = graph.properties.some((p) => p.result === "violated" && !p.staleModel);
  return rejected || violated || failure !== null ? 1 : 0;
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

/** One line on stdout, the URL, then serves until SIGINT or SIGTERM. */
async function runServe(
  root: string,
  { port, open }: Extract<Command, { readonly kind: "serve" }>,
): Promise<number> {
  const server = await startServer({ root, port, uiPath: UI_PATH });
  process.stdout.write(`${server.url}\n`);
  if (open) openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await server.close();
  return 0;
}

/** `--open`. A missing opener leaves the printed URL to click. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
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
