#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "./core/json.js";
import { scan } from "./core/scan.js";
import type { Graph, ScanWarning } from "./core/types.js";
import { serializeGraph } from "./core/workspace.js";

const USAGE = "使い方: everypath scan [dir] [--json] [--quiet]";
const USAGE_ERROR = 2;
const OPTIONS: readonly string[] = ["json", "quiet", "help"];

type Command =
  | { readonly kind: "help" }
  | {
      readonly kind: "scan";
      readonly directory: string;
      readonly json: boolean;
      readonly quiet: boolean;
    };

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
    if (name !== "scan" || extra.length > 0) {
      return { ok: false, message: `未知のコマンドか引数です: ${positionals.join(" ")}` };
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
  const graph = await scan(root);
  if (command.json) process.stdout.write(serializeGraph(graph));
  if (!command.quiet) {
    const lines = [summarize(graph), ...graph.warnings.map(describeWarning)];
    process.stderr.write(`${lines.join("\n")}\n`);
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`エラー: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
