#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "./core/json.js";
import { PROPERTIES_FILE } from "./core/properties.js";
import { scan } from "./core/scan.js";
import type { Counterexample, Graph, PropertyResult, ScanWarning } from "./core/types.js";
import { serializeGraph } from "./core/workspace.js";

const USAGE = "使い方: everypath scan [dir] [--json] [--quiet]\n        everypath check [dir]";
const USAGE_ERROR = 2;
const OPTIONS: readonly string[] = ["json", "quiet", "help"];

type Command =
  | { readonly kind: "help" }
  | {
      readonly kind: "scan";
      readonly directory: string;
      readonly json: boolean;
      readonly quiet: boolean;
    }
  | { readonly kind: "check"; readonly directory: string };

type Parsed =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly message: string };

/** The command line is a boundary: whatever the user typed becomes a `Command` or a message. */
function parseCommand(args: readonly string[]): Parsed {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: "boolean" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    const unknown = Object.keys(values).filter((key) => !OPTIONS.includes(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `未知のオプションです: ${unknown.map((key) => `--${key}`).join(" ")}`,
      };
    }
    if (values.help) return { ok: true, command: { kind: "help" } };
    const [name, directory = ".", ...extra] = positionals;
    if (name === undefined) return { ok: false, message: "コマンドがありません" };
    if ((name !== "scan" && name !== "check") || extra.length > 0) {
      return { ok: false, message: `未知のコマンドか引数です: ${positionals.join(" ")}` };
    }
    if (name === "check") {
      if (values.json || values.quiet) {
        return { ok: false, message: "check は --json と --quiet を受け付けません" };
      }
      return { ok: true, command: { kind: "check", directory } };
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
    return { ok: false, message: errorMessage(error) };
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
  return [title, ...counterexamples.map((example) => `  ${formatPath(example)}`)];
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

function reportChecks(graph: Graph): string[] {
  if (graph.properties.length === 0) return [`性質がありません（${PROPERTIES_FILE}）`];
  return [...graph.properties.flatMap(describeProperty), summarizeChecks(graph)];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function main(args: readonly string[]): Promise<number> {
  const parsed = parseCommand(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n${USAGE}\n`);
    return USAGE_ERROR;
  }
  const { command } = parsed;
  if (command.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const root = resolve(command.directory);
  if (!(await isDirectory(root))) {
    process.stderr.write(`ディレクトリが見つかりません: ${command.directory}\n`);
    return USAGE_ERROR;
  }
  return command.kind === "scan" ? runScan(root, command) : runCheck(root);
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

/** A property the file defines but the check could not read fails the run too, so CI never passes it silently. */
async function runCheck(root: string): Promise<number> {
  const graph = await scan(root, { reason: "check" });
  if (graph.warnings.length > 0) {
    process.stderr.write(`${graph.warnings.map(describeWarning).join("\n")}\n`);
  }
  process.stdout.write(`${reportChecks(graph).join("\n")}\n`);
  const rejected = graph.warnings.some((warning) => warning.file === PROPERTIES_FILE);
  return rejected || graph.properties.some((p) => p.result === "violated") ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`エラー: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
