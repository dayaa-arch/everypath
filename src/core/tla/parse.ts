import type { Counterexample, StateName, Step } from "../types.js";
import type { TlaNames } from "./generate.js";

/** One TLC run, read. `check` is the ASCII name from `names.checks`; `null` is a temporal property. */
export type TlcReport =
  | { readonly kind: "ok"; readonly distinctStates: number }
  | {
      readonly kind: "violated";
      readonly check: string | null;
      readonly trace: Counterexample;
      readonly distinctStates: number | null;
    }
  | { readonly kind: "error"; readonly message: string; readonly distinctStates: number | null };

const COMPLETED = /^Model checking completed\. No error has been found\./m;
const INVARIANT_VIOLATED = /^Error: Invariant (\S+) is violated/;
const TEMPORAL_VIOLATED = /^Error: Temporal properties were violated\./;
const STATE_COUNT = /([\d,]+) distinct states? (?:found|generated)/g;
const STATE_HEADER = /^State \d+: (.*)$/;
const BACK_TO = /^Back to state (\d+):/;
const BINDING = /^\/\\ (\S+) = (.*)$/;

/** The last count TLC printed, so the progress lines of a run that was killed still give one. */
function lastStateCount(output: string): number | null {
  const digits = [...output.matchAll(STATE_COUNT)].at(-1)?.[1];
  return digits === undefined ? null : Number(digits.replaceAll(",", ""));
}

/** Total: output that is not TLC's, or names that are not in `names`, become an `error` report. */
export function parseTlcOutput(output: string, names: TlaNames): TlcReport {
  const distinctStates = lastStateCount(output);
  const fail = (message: string): TlcReport => ({ kind: "error", message, distinctStates });
  if (COMPLETED.test(output)) {
    return distinctStates === null
      ? fail("TLC は成功と報告しましたが、状態数を読めません")
      : { kind: "ok", distinctStates };
  }

  const lines = output.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const invariant = INVARIANT_VIOLATED.exec(line)?.[1];
    if (invariant === undefined && !TEMPORAL_VIOLATED.test(line)) continue;
    if (invariant !== undefined && !Object.hasOwn(names.checks, invariant)) {
      return fail(`TLC が知らない不変条件 ${invariant} の違反を報告しました`);
    }
    const trace = readTrace(lines.slice(index + 1), names, invariant === undefined);
    return trace.ok
      ? { kind: "violated", check: invariant ?? null, trace: trace.trace, distinctStates }
      : fail(trace.message);
  }
  return fail(failureOf(lines));
}

/** What went wrong, in TLC's own words when it said: its first `Error:` line, else a Java exception. */
function failureOf(lines: readonly string[]): string {
  const error = lines.find((line) => line.startsWith("Error: "));
  if (error !== undefined) return error.slice("Error: ".length);
  const exception = lines.find(
    (line) => line.startsWith("Exception in thread ") || line.startsWith("***"),
  );
  if (exception !== undefined) return exception;
  const last = lines.findLast((line) => line.trim() !== "");
  return `TLC の出力から結果を読めません（最後の行: ${last ?? "なし"}）`;
}

type Block = Map<string, string>;
type Loop = { readonly back: number } | "stuttering" | null;
type Trace =
  | { readonly ok: true; readonly trace: Counterexample }
  | { readonly ok: false; readonly message: string };

/**
 * The lines after the `Error:` line: `State N: <action>` followed by `/\ name = value` lines, a blank
 * line between states. An initial-state violation has the `/\` lines with no header. The trace ends
 * at `Back to state N`, at `State N: Stuttering`, or at the first other line once it has started.
 */
function splitTrace(lines: readonly string[]): { blocks: Block[]; loop: Loop } {
  const blocks: Block[] = [];
  for (const line of lines) {
    const header = STATE_HEADER.exec(line);
    if (header !== null) {
      if (header[1] === "Stuttering") return { blocks, loop: "stuttering" };
      blocks.push(new Map());
      continue;
    }
    const back = BACK_TO.exec(line)?.[1];
    if (back !== undefined) return { blocks, loop: { back: Number(back) - 1 } };
    const binding = BINDING.exec(line);
    if (binding !== null) {
      const [, name = "", value = ""] = binding;
      if (blocks.length === 0) blocks.push(new Map());
      blocks.at(-1)?.set(name, value);
    } else if (line.trim() !== "" && blocks.length > 0) {
      break;
    }
  }
  return { blocks, loop: null };
}

/** `lasso` says the behavior must loop: a temporal violation. */
function readTrace(lines: readonly string[], names: TlaNames, lasso: boolean): Trace {
  const { blocks, loop } = splitTrace(lines);
  const [head, ...tail] = blocks;
  if (head === undefined) return { ok: false, message: "TLC の反例から状態を読めません" };
  const first = stepOf(head, names, true);
  if (!first.ok) return first;
  const steps: [Step, ...Step[]] = [first.step];
  for (const block of tail) {
    const step = stepOf(block, names, false);
    if (!step.ok) return step;
    steps.push(step.step);
  }

  const loopStart = lasso ? loopIndex(loop, steps.length) : null;
  if (loopStart === undefined) return { ok: false, message: "TLC の反例のループ位置を読めません" };
  const path: [StateName, ...StateName[]] = [first.step.state];
  for (const { state } of steps.slice(1)) path.push(state);
  return { ok: true, trace: { path, steps, loopStart } };
}

/** `Back to state N` goes to step N - 1; a stuttering behavior repeats its last step. */
function loopIndex(loop: Loop, length: number): number | undefined {
  if (loop === null) return undefined;
  if (loop === "stuttering") return length - 1;
  return loop.back >= 0 && loop.back < length ? loop.back : undefined;
}

type StepResult =
  | { readonly ok: true; readonly step: Step }
  | { readonly ok: false; readonly message: string };

const unquote = (value: string | undefined): string | undefined => value?.match(/^"(.*)"$/)?.[1];

/** An own key only, so a printed `constructor` is unknown rather than a function. */
function lookup<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

function stepOf(block: Block, names: TlaNames, initial: boolean): StepResult {
  const unknown = (what: string, printed: string | undefined): StepResult => ({
    ok: false,
    message: `TLC の反例に ${what} ${printed ?? "（無し）"} があります。生成した名前表にありません`,
  });
  const state = lookup(names.states, unquote(block.get("state")));
  if (state === undefined) return unknown("状態", block.get("state"));
  const event = initial ? null : lookup(names.events, unquote(block.get("lastEvent")));
  if (event === undefined) return unknown("イベント", block.get("lastEvent"));

  const vars: Record<string, string> = {};
  for (const [id, display] of Object.entries(names.vars)) {
    const value = printedValue(block.get(id), names);
    if (value === undefined) return unknown(`変数 ${id} の値`, block.get(id));
    vars[display] = value;
  }
  return { ok: true, step: { state, event, vars } };
}

function printedValue(raw: string | undefined, names: TlaNames): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === "TRUE" || raw === "FALSE" || /^\d+$/.test(raw)) return raw;
  return lookup(names.members, unquote(raw));
}
