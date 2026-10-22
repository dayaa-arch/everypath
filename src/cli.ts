#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type InitAction, initRepository, linesHidingReview } from "./core/init.js";
import { errorMessage } from "./core/json.js";
import { toMermaid } from "./core/mermaid.js";
import { PROPERTIES_FILE } from "./core/properties.js";
import { analyze, scan } from "./core/scan.js";
import { rejectionWarnings } from "./core/tla/result.js";
import {
  checkTlc,
  exportTla,
  type InstallSource,
  installTla,
  summarizeTlc,
  type TlcSummary,
} from "./core/tla/run.js";
import type {
  Counterexample,
  Graph,
  PropertyResult,
  ScanWarning,
  TlcVerdict,
} from "./core/types.js";
import { isGuardOnly, isLiveViolation } from "./core/verdict.js";
import { serializeGraph } from "./core/workspace.js";
import {
  findServer,
  type Handoff,
  handOffScan,
  handOffTlc,
  type Route,
  type ServedGraph,
} from "./server/client.js";
import { startServer } from "./server/server.js";

const USAGE = [
  "使い方: everypath init [dir]",
  "        everypath scan [dir] [--json] [--quiet]",
  "        everypath check [dir] [--tlc [--timeout 秒]]",
  "        everypath export [dir] --mermaid",
  "        everypath tla export [dir]",
  "        everypath tla install",
  "        everypath serve [dir] [--port 4747] [--open]",
].join("\n");
const USAGE_ERROR = 2;
const DEFAULT_PORT = 4747;
/** `dist/ui.html` of this package, from `src/cli.ts` and from the built `dist/cli.js` alike. */
const UI_PATH = fileURLToPath(new URL("../dist/ui.html", import.meta.url));
/** `templates/prompts/` of this package, found the same way. */
const PROMPTS_DIR = fileURLToPath(new URL("../templates/prompts/", import.meta.url));

type Label = "init" | "scan" | "check" | "export" | "tla export" | "tla install" | "serve";

/** The options each command takes; `--help` goes with every one. */
const ACCEPTS: Readonly<Record<Label, readonly string[]>> = {
  init: [],
  scan: ["json", "quiet"],
  check: ["tlc", "timeout"],
  export: ["mermaid"],
  "tla export": [],
  "tla install": [],
  serve: ["port", "open"],
};
const OPTIONS: ReadonlySet<string> = new Set(["help", ...Object.values(ACCEPTS).flat()]);

type Command =
  | { readonly kind: "help" }
  | { readonly kind: "init"; readonly directory: string }
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
  | { readonly kind: "export"; readonly directory: string }
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

function parseInit(positionals: readonly string[], values: Values): Result<Command> {
  const [, directory = ".", ...extra] = positionals;
  if (extra.length > 0) return unknownCommand(positionals);
  return unaccepted("init", values) ?? accept({ kind: "init", directory });
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

function parseExport(positionals: readonly string[], values: Values): Result<Command> {
  const [, directory = ".", ...extra] = positionals;
  if (extra.length > 0) return unknownCommand(positionals);
  const refused = unaccepted("export", values);
  if (refused !== null) return refused;
  return values.mermaid === true
    ? accept({ kind: "export", directory })
    : refuse("export には --mermaid を指定してください");
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
        mermaid: { type: "boolean" },
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
      case "init":
        return parseInit(positionals, values);
      case "scan":
        return parseScan(positionals, values);
      case "check":
        return parseCheck(positionals, values);
      case "export":
        return parseExport(positionals, values);
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

function summarize(graph: Graph, by: Scanned["by"]): string {
  const count = (type: Graph["edges"][number]["type"]): number =>
    graph.edges.filter((edge) => edge.type === type).length;
  const counts = `状態 ${graph.nodes.length}、遷移 ${count("flow")}、依存 ${count("dep")}、乖離 ${graph.drift.length}、警告 ${graph.warnings.length}`;
  const wrote = by === "cli" ? "" : "起動中の everypath serve が ";
  return `スキャン完了: ${counts}（${wrote}.everypath/graph.json に書きました）`;
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
const GUARD_ONLY = "ガードを無視したときだけの経路";

/** A path TLC cleared on this model is counted as TLC decided it. */
function wordOf(property: PropertyResult): string {
  return STATUS_WORDS[isGuardOnly(property) ? "ok" : property.result];
}

function describeProperty(property: PropertyResult): string[] {
  const { id, kind, description, result, checkedBy, counterexamples, staleModel, tlc } = property;
  const title = `${wordOf(property)} ${id} [${kind}]${description === null ? "" : ` ${description}`}`;
  if (result === "pending") return [title, "  TLC の検査待ちです（everypath check --tlc）"];
  if (isGuardOnly(property)) {
    const paths = counterexamples.map((example) => `  ${GUARD_ONLY}: ${formatPath(example)}`);
    return [title, ...paths, ...describeTlc(tlc)];
  }
  const describe = (example: Counterexample): string[] =>
    checkedBy === "bfs" ? [`  ${formatPath(example)}`] : describeSteps(example);
  const stale = staleModel
    ? [
        `  ${STALE}です。TLC の実行後にモデルが変わったため、終了コードに数えません（everypath check --tlc で検査し直せます）`,
      ]
    : [];
  return [title, ...stale, ...counterexamples.flatMap(describe), ...describeTlc(tlc)];
}

/** What TLC said beside a violation the quick check found. Only a verdict on this model counts. */
function describeTlc(tlc: TlcVerdict | undefined): string[] {
  if (tlc === undefined) return [];
  const states = tlc.statesExplored === null ? [] : [`${tlc.statesExplored} 状態`];
  if (tlc.staleModel) {
    const about = [STALE, ...states].join("、");
    return [`  TLC: ${STATUS_WORDS[tlc.result]}（${about}。終了コードは簡易検査のまま数えます）`];
  }
  const counted = states.length === 0 ? "" : `（${states.join("")}）`;
  switch (tlc.result) {
    case "ok":
      return [
        `  TLC: 成立${counted}。ガードどおりに動くとこの経路は通れないので、終了コードに数えません`,
      ];
    case "violated":
      return [`  TLC: 違反${counted}`, ...tlc.counterexamples.flatMap(describeSteps)];
    case "error":
      return ["  TLC: エラー（判定できませんでした）"];
  }
}

function summarizeChecks(
  properties: Graph["properties"],
  warnings: readonly ScanWarning[],
): string {
  const counts = Object.values(STATUS_WORDS).flatMap((word) => {
    const count = properties.filter((p) => wordOf(p) === word).length;
    return count > 0 ? [`${word} ${count}`] : [];
  });
  const rejected = warnings.filter((warning) => warning.file === PROPERTIES_FILE).length;
  const stale = properties.filter((p) => p.staleModel).length;
  const guardOnly = properties.filter(isGuardOnly).length;
  const notes = [
    ...(rejected > 0 ? [`${PROPERTIES_FILE} の警告 ${rejected} 件`] : []),
    ...(stale > 0 ? [`${STALE} ${stale} 件`] : []),
    ...(guardOnly > 0 ? [`${GUARD_ONLY} ${guardOnly} 件`] : []),
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
    case "init":
      return runInit(root);
    case "scan":
      return runScan(root, command);
    case "check":
      return runCheck(root, command.tlc);
    case "export":
      return runMermaid(root);
    case "tla-export":
      return runExport(root);
    case "serve":
      return runServe(root, command);
  }
}

/** A graph of this run, and who wrote `graph.json` for it: this process, or the running serve. */
type Scanned =
  | { readonly by: "cli"; readonly graph: Graph }
  | ({ readonly by: "serve" } & ServedGraph);

const graphText = (scanned: Scanned): string =>
  scanned.by === "serve" ? scanned.text : serializeGraph(scanned.graph);

/** A hand-off's answer, or `null` when nothing listened there and the CLI writes itself. */
function answered<T>(handed: Handoff<T>): Result<T> | null {
  switch (handed.kind) {
    case "answered":
      return accept(handed.value);
    case "failed":
      return refuse(handed.message);
    case "refused":
      return null;
  }
}

/**
 * With a running serve its queue is the only writer, so the scan is handed over and nothing is
 * written here. A serve that answers with an error is an error: writing around it would race it.
 */
async function scanVia(root: string, route: Route, reason: string): Promise<Result<Scanned>> {
  if (route.kind === "server") {
    const handed = answered(await handOffScan(route.url));
    if (handed !== null) return handed.ok ? accept({ by: "serve", ...handed.value }) : handed;
  }
  return accept({ by: "cli", graph: await scan(root, { reason }) });
}

/** TLC runs in the serve's environment when one is running, so its Java and jar are the ones used. */
async function checkTlcVia(
  root: string,
  route: Route,
  options: { readonly timeoutMs?: number },
): Promise<Result<TlcSummary>> {
  if (route.kind === "server") {
    const handed = answered(await handOffTlc(route.url, options));
    if (handed !== null) return handed;
  }
  return accept(summarizeTlc(await checkTlc(root, options)));
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

/** Where `templates/` and `skill/` are, from `src/cli.ts` and from the built `dist/cli.js` alike. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const INIT_WORDS: Readonly<Record<InitAction["kind"], string>> = {
  created: "を作りました",
  appended: "に足りない行を足しました",
  skipped: "は既にあるので飛ばしました",
};

async function runInit(root: string): Promise<number> {
  const actions = await initRepository(root, PACKAGE_ROOT);
  process.stdout.write(actions.map(({ path, kind }) => `${path} ${INIT_WORDS[kind]}\n`).join(""));
  for (const line of await linesHidingReview(root)) {
    process.stderr.write(
      `警告: .gitignore の「${line}」が .everypath/ ごと無視するので、.everypath/review.json を git で管理できません。この行を消すか「.everypath/*」に変えてください\n`,
    );
  }
  return 0;
}

async function runScan(
  root: string,
  { json, quiet }: Extract<Command, { readonly kind: "scan" }>,
): Promise<number> {
  const scanned = await scanVia(root, await findServer(root), "scan");
  if (!scanned.ok) return fail(scanned.message);
  const { graph, by } = scanned.value;
  if (json) process.stdout.write(graphText(scanned.value));
  if (!quiet) {
    const lines = [summarize(graph, by), ...graph.warnings.map(describeWarning)];
    process.stderr.write(`${lines.join("\n")}\n`);
  }
  return 0;
}

/**
 * A property the file defines but the check could not read fails the run too, so CI never passes it
 * silently. Under `--tlc` so does a definition the model left out, and any TLC error, which includes
 * a property TLC could not decide, and a variable out of its range. With `--tlc` but no Java or jar
 * the quick check alone decides the exit code. The scan reads TLC's record, so a plain check also
 * counts the last run's violations, and leaves out the quick-check paths that run cleared, unless
 * the model has changed since.
 */
async function runCheck(
  root: string,
  tlc: { readonly timeoutMs?: number } | null,
): Promise<number> {
  const route = await findServer(root);
  const run = tlc === null ? accept(null) : await checkTlcVia(root, route, tlc);
  if (!run.ok) return fail(run.message);
  const scanned = await scanVia(root, route, "check");
  if (!scanned.ok) return fail(scanned.message);
  const summary = run.value;
  const { graph } = scanned.value;
  const warnings = [
    ...graph.warnings,
    ...(summary?.kind === "checked" ? rejectionWarnings(summary.rejected) : []),
  ];
  const stderr = warnings.map(describeWarning);
  const failure = tlcFailure(summary);
  // A stored result.json is not evidence: a committed or stale file could hide a real path. Only a
  // TLC run inside this check may clear a quick-check violation from the exit code.
  const clearedNow = summary?.kind === "checked";
  const storedOnly = clearedNow ? [] : graph.properties.filter(isGuardOnly);
  if (storedOnly.length > 0) {
    stderr.push(
      `ガードを無視したときだけの経路が ${storedOnly.length} 件ありますが、この実行では TLC を走らせていないので終了コードに数えます（everypath check --tlc で確かめられます）`,
    );
  }
  if (summary?.kind === "missing") stderr.push(...summary.guide);
  if (stderr.length > 0) process.stderr.write(`${stderr.join("\n")}\n`);
  process.stdout.write(`${reportChecks(graph, warnings, failure ?? []).join("\n")}\n`);

  const rejected = warnings.some((warning) => warning.file === PROPERTIES_FILE);
  const violated = graph.properties.some(isLiveViolation) || storedOnly.length > 0;
  return rejected || violated || failure !== null ? 1 : 0;
}

/**
 * Prints the diagram from `analyze`, which only reads: nothing is written here, and a running serve
 * is not asked to scan. The scan's warnings go to stderr so that stdout is the diagram alone.
 */
async function runMermaid(root: string): Promise<number> {
  const { graph } = await analyze(root);
  if (graph.nodes.length === 0) {
    return fail("状態がありません。ソースの先頭に @state を書いてから実行してください");
  }
  if (graph.warnings.length > 0) {
    process.stderr.write(`${graph.warnings.map(describeWarning).join("\n")}\n`);
  }
  process.stdout.write(toMermaid(graph));
  return 0;
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
  const server = await startServer({ root, port, uiPath: UI_PATH, promptsDir: PROMPTS_DIR });
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
