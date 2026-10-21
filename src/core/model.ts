import type { NextDecl } from "./annotations.js";
import { parseAssignments, parseEventName, parseGuard } from "./expr.js";
import type {
  Assignment,
  EventName,
  GuardExpr,
  ModelVar,
  NonEmpty,
  ParseResult,
  ParseWarning,
  Value,
  VarName,
} from "./types.js";

/** The declared variables, keyed by name. Guards and assignments are checked against it. */
export type VarTable = ReadonlyMap<VarName, ModelVar>;

export type Problem = { readonly message: string; readonly detail: ParseWarning | null };

export type ResolvedNext = {
  readonly event: EventName | null;
  readonly guard: GuardExpr | null;
  readonly set: readonly Assignment[];
  /** The first problem on the line. A clause with a problem is dropped; the others stay. */
  readonly problem: Problem | null;
};

type Clause<T> = { readonly value: T | null; readonly problem: Problem | null };

/** Parses the `on:`, `if:` and `set:` text of one `@state-next` and checks it against `vars`. */
export function resolveNext(decl: NextDecl, vars: VarTable): ResolvedNext {
  const on = resolveClause("on:", decl.on, parseEventName, () => null);
  const guard = resolveClause("if:", decl.guard, parseGuard, (expr) => checkGuard(expr, vars));
  const set = resolveClause("set:", decl.set, parseAssignments, (list) =>
    checkAssignments(list, vars),
  );
  return {
    event: on.value,
    guard: guard.value,
    set: set.value ?? [],
    problem: on.problem ?? guard.problem ?? set.problem,
  };
}

function resolveClause<T>(
  label: string,
  text: string | null,
  parse: (input: string) => ParseResult<T>,
  check: (value: T) => string | null,
): Clause<T> {
  if (text === null) return { value: null, problem: null };
  const parsed = parse(text);
  if (!parsed.ok) {
    const { warning } = parsed;
    return {
      value: null,
      problem: { message: `${label} を解釈できません: ${warning.message}`, detail: warning },
    };
  }
  const wrong = check(parsed.value);
  if (wrong !== null)
    return { value: null, problem: { message: `${label} ${wrong}`, detail: null } };
  return { value: parsed.value, problem: null };
}

type Comparison = Extract<GuardExpr, { readonly kind: "cmp" }>;

function checkGuard(expr: GuardExpr, vars: VarTable): string | null {
  switch (expr.kind) {
    case "cmp":
      return checkComparison(expr, vars);
    case "not":
      return checkGuard(expr.operand, vars);
    case "and":
    case "or":
      return firstProblem(expr.operands, (operand) => checkGuard(operand, vars));
  }
}

export function checkComparison({ name, op, value }: Comparison, vars: VarTable): string | null {
  const decl = vars.get(name);
  if (decl === undefined) return undeclared(name);
  if (op === "==" || op === "!=") {
    return fits(decl, value)
      ? null
      : `${name} は ${typeLabel(decl)} なので ${show(value)} とは比較できません`;
  }
  return decl.kind === "range"
    ? null
    : `${name} は ${typeLabel(decl)} なので大小比較できません（範囲の変数だけ）`;
}

function checkAssignments(list: NonEmpty<Assignment>, vars: VarTable): string | null {
  return firstProblem(list, ({ target, value }) => {
    const decl = vars.get(target);
    if (decl === undefined) return undeclared(target);
    if (value.kind === "offset") {
      const source = vars.get(value.of);
      if (source === undefined) return undeclared(value.of);
      return firstProblem([decl, source], (each) =>
        each.kind === "range"
          ? null
          : `加減算は範囲の変数だけです: ${each.name} は ${typeLabel(each)}`,
      );
    }
    if (!fits(decl, value))
      return `${target} は ${typeLabel(decl)} なので ${show(value)} は代入できません`;
    if (
      decl.kind === "range" &&
      value.kind === "int" &&
      (value.value < decl.min || value.value > decl.max)
    ) {
      return `${target} の範囲 ${decl.min}..${decl.max} の外です: ${value.value}`;
    }
    return null;
  });
}

function firstProblem<T>(items: readonly T[], check: (item: T) => string | null): string | null {
  for (const item of items) {
    const problem = check(item);
    if (problem !== null) return problem;
  }
  return null;
}

/** Whether a value of this kind can meet the variable in `==`, `!=` or `=`. Range bounds are not checked here. */
function fits(decl: ModelVar, value: Value): boolean {
  switch (decl.kind) {
    case "boolean":
      return value.kind === "bool";
    case "range":
      return value.kind === "int";
    case "enum":
      return value.kind === "member" && decl.members.includes(value.name);
  }
}

function undeclared(name: VarName): string {
  return `変数 ${name} が宣言されていません`;
}

function typeLabel(decl: ModelVar): string {
  switch (decl.kind) {
    case "boolean":
      return "BOOLEAN";
    case "range":
      return `${decl.min}..${decl.max}`;
    case "enum":
      return `{${decl.members.join(",")}}`;
  }
}

function show(value: Value): string {
  switch (value.kind) {
    case "bool":
      return value.value ? "TRUE" : "FALSE";
    case "int":
      return String(value.value);
    case "member":
      return value.name;
  }
}
