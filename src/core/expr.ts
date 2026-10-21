import type {
  Assignment,
  EventName,
  GuardExpr,
  MemberName,
  ModelVar,
  NonEmpty,
  ParseResult,
  PropExpr,
  PropertyExpr,
  StateName,
  StatePred,
  Value,
  VarName,
  VarType,
} from "./types.js";

/** The text after `if:`. SPEC §5.1 with precedence `||` < `&&` < `!`. */
export function parseGuard(input: string): ParseResult<GuardExpr> {
  return run(input, (cur) => parseExpression(cur, guardLanguage));
}

/** The text after `set:`: `VAR = RHS ("," VAR = RHS)*`, RHS a value or `VAR+1` / `VAR-1`. */
export function parseAssignments(input: string): ParseResult<NonEmpty<Assignment>> {
  return run(input, parseAssignmentList);
}

/** The text after `@state-var`: `NAME ":" TYPE "=" INIT`, TYPE `BOOLEAN`, `N..M` or `{a,b,c}`. */
export function parseVarDecl(input: string): ParseResult<ModelVar> {
  return run(input, parseDeclaration);
}

/** A property expression: the guard grammar plus `state ==|!=|in` and right-associative `=>`. */
export function parseProperty(input: string): ParseResult<PropertyExpr> {
  // The variable-free grammar runs first, so its success is the proof of `mentionsVars: false`.
  const stateOnly = run(input, (cur) => parseExpression(cur, statePredLanguage));
  if (stateOnly.ok) return ok({ mentionsVars: false, expr: stateOnly.value });
  const general = run(input, (cur) => parseExpression(cur, propertyLanguage));
  return general.ok ? ok({ mentionsVars: true, expr: general.value }) : general;
}

/** A state name from `@state`, `@state-next` or a file name. Same identifier rules as expressions. */
export function parseStateName(input: string): ParseResult<StateName> {
  return run(input, (cur) => parseName(cur, "state"));
}

/** An event name from `on:` or `@state-event`. Same identifier rules as state names. */
export function parseEventName(input: string): ParseResult<EventName> {
  return run(input, (cur) => parseName(cur, "event"));
}

/**
 * Turns a file or directory name into a state name: characters an identifier cannot hold become
 * `_`, a leading non-letter gets a `_` prefix, a keyword gets a `_` suffix. Total, unlike the parsers.
 */
export function sanitizeStateName(raw: string): StateName {
  const replaced = raw.normalize("NFC").replace(/[^\p{L}\p{M}\p{Nd}_]/gu, "_");
  const headed = /^[\p{L}_]/u.test(replaced) ? replaced : `_${replaced}`;
  // The replacement and prefix above leave exactly the shape `parseName` accepts.
  return (KEYWORDS.includes(headed) ? `${headed}_` : headed) as StateName;
}

const MAX_NESTING = 64;
const KEYWORDS: readonly string[] = ["TRUE", "FALSE", "BOOLEAN", "state", "in"];

type Pair = "&&" | "||" | "=>" | "==" | "!=" | "<=" | ">=" | "..";
type Single = "(" | ")" | "{" | "}" | "," | ":" | "+" | "-" | "!" | "=" | "<" | ">";
type Punct = Pair | Single;
const PAIRS: readonly Pair[] = ["&&", "||", "=>", "==", "!=", "<=", ">=", ".."];
const SINGLES: readonly Single[] = ["(", ")", "{", "}", ",", ":", "+", "-", "!", "=", "<", ">"];

const LEXEME =
  /(?<space>\s+)|(?<word>[\p{L}_][\p{L}\p{M}\p{Nd}_]*)|(?<number>[0-9]+)|&&|\|\||=>|==|!=|<=|>=|\.\.|[(){},:+\-!=<>]|[\s\S]/gu;

type Token = {
  readonly kind: Punct | "ident" | "int" | "invalid" | "eof";
  readonly text: string;
  readonly column: number;
};

function tokenize(input: string): readonly Token[] {
  const tokens: Token[] = [];
  for (const lexeme of input.matchAll(LEXEME)) {
    const groups: Record<string, string | undefined> = lexeme.groups ?? {};
    const [text] = lexeme;
    const column = lexeme.index + 1;
    if (groups.space !== undefined) continue;
    if (groups.word !== undefined) tokens.push({ kind: "ident", text, column });
    else if (groups.number !== undefined) tokens.push({ kind: "int", text, column });
    else tokens.push({ kind: punctuation(text) ?? "invalid", text, column });
  }
  return tokens;
}

function punctuation(text: string): Punct | undefined {
  return PAIRS.find((p) => p === text) ?? SINGLES.find((p) => p === text);
}

type Cursor = {
  readonly input: string;
  readonly tokens: readonly Token[];
  index: number;
};

type Failure = Extract<ParseResult<never>, { readonly ok: false }>;

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function fail(cur: Cursor, column: number, message: string): Failure {
  return { ok: false, warning: { message, input: cur.input, column } };
}

function peek(cur: Cursor, ahead = 0): Token {
  return cur.tokens[cur.index + ahead] ?? { kind: "eof", text: "", column: cur.input.length + 1 };
}

function take(cur: Cursor): Token {
  const token = peek(cur);
  cur.index += 1;
  return token;
}

function expect(cur: Cursor, kind: Punct): ParseResult<Token> {
  return peek(cur).kind === kind ? ok(take(cur)) : unexpected(cur);
}

function unexpected(cur: Cursor): Failure {
  const { kind, text, column } = peek(cur);
  switch (kind) {
    case "eof":
      return fail(cur, column, cur.index === 0 ? "入力が空です" : "入力が途中で終わっています");
    case "invalid":
      return fail(cur, column, invalidMessage(text));
    case "+":
    case "-":
      return fail(cur, column, "算術は set: の VAR+1 と VAR-1 だけです");
    default:
      return fail(cur, column, `ここに ${text} は置けません`);
  }
}

function invalidMessage(text: string): string {
  if (text === '"' || text === "'" || text === "`") return "文字列リテラルは使えません";
  if (text === "&" || text === "|") return `未知の演算子です: ${text}（&& と || だけ使えます）`;
  return `使えない文字です: ${text}`;
}

function run<T>(input: string, grammar: (cur: Cursor) => ParseResult<T>): ParseResult<T> {
  const cur: Cursor = { input, tokens: tokenize(input), index: 0 };
  const result = grammar(cur);
  if (!result.ok) return result;
  return peek(cur).kind === "eof" ? result : unexpected(cur);
}

type Operands<E> = readonly [E, E, ...E[]];

type Language<E> = {
  readonly atom: (cur: Cursor) => ParseResult<E>;
  readonly not: (operand: E) => E;
  readonly and: (operands: Operands<E>) => E;
  readonly or: (operands: Operands<E>) => E;
  /** Absent where `=>` is not part of the language. */
  readonly implies?: (antecedent: E, consequent: E) => E;
};

const guardLanguage: Language<GuardExpr> = {
  atom: parseVarAtom,
  not: (operand) => ({ kind: "not", operand }),
  and: (operands) => ({ kind: "and", operands }),
  or: (operands) => ({ kind: "or", operands }),
};

const propertyLanguage: Language<PropExpr> = {
  atom: (cur) => (isStateKeyword(peek(cur)) ? parseStateAtom(cur) : parseVarAtom(cur)),
  not: (operand) => ({ kind: "not", operand }),
  and: (operands) => ({ kind: "and", operands }),
  or: (operands) => ({ kind: "or", operands }),
  implies: (antecedent, consequent) => ({ kind: "implies", antecedent, consequent }),
};

const statePredLanguage: Language<StatePred> = {
  atom: parseStateAtom,
  not: (operand) => ({ kind: "not", operand }),
  and: (operands) => ({ kind: "and", operands }),
  or: (operands) => ({ kind: "or", operands }),
  implies: (antecedent, consequent) => ({ kind: "implies", antecedent, consequent }),
};

function parseExpression<E>(cur: Cursor, language: Language<E>): ParseResult<E> {
  const { atom, not, and, or, implies } = language;

  function implication(depth: number): ParseResult<E> {
    const antecedent = chain("||", depth);
    if (!antecedent.ok) return antecedent;
    const arrow = peek(cur);
    if (arrow.kind !== "=>") return antecedent;
    if (implies === undefined) {
      return fail(cur, arrow.column, "ガードでは => を使えません（含意は性質式だけ）");
    }
    take(cur);
    const consequent = implication(depth + 1);
    return consequent.ok ? ok(implies(antecedent.value, consequent.value)) : consequent;
  }

  function chain(op: "||" | "&&", depth: number): ParseResult<E> {
    const operand = (): ParseResult<E> => (op === "||" ? chain("&&", depth) : unary(depth));
    const first = operand();
    if (!first.ok || peek(cur).kind !== op) return first;
    take(cur);
    const second = operand();
    if (!second.ok) return second;
    const rest: E[] = [];
    while (peek(cur).kind === op) {
      take(cur);
      const next = operand();
      if (!next.ok) return next;
      rest.push(next.value);
    }
    const operands: Operands<E> = [first.value, second.value, ...rest];
    return ok(op === "||" ? or(operands) : and(operands));
  }

  function unary(depth: number): ParseResult<E> {
    const token = peek(cur);
    if (depth > MAX_NESTING) return fail(cur, token.column, "入れ子が深すぎます");
    if (token.kind === "!") {
      take(cur);
      const operand = unary(depth + 1);
      return operand.ok ? ok(not(operand.value)) : operand;
    }
    if (token.kind === "(") {
      take(cur);
      const inner = implication(depth + 1);
      if (!inner.ok) return inner;
      const close = expect(cur, ")");
      return close.ok ? inner : close;
    }
    return atom(cur);
  }

  return implication(0);
}

function parseVarAtom(cur: Cursor): ParseResult<GuardExpr> {
  const name = parseName(cur, "var");
  if (!name.ok) return name;
  const op = peek(cur);
  switch (op.kind) {
    case "==":
    case "!=": {
      take(cur);
      const value = parseValue(cur);
      return value.ok
        ? ok({ kind: "cmp", op: op.kind, name: name.value, value: value.value })
        : value;
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      take(cur);
      const bound = peek(cur);
      if (bound.kind !== "int" && bound.kind !== "-") {
        return fail(cur, bound.column, "大小比較の右辺は整数だけです");
      }
      const limit = parseNatural(cur);
      if (!limit.ok) return limit;
      return ok({
        kind: "cmp",
        op: op.kind,
        name: name.value,
        value: { kind: "int", value: limit.value },
      });
    }
    case "=":
      return fail(cur, op.column, "比較は == を使います（= は代入です）");
    case "(":
      return fail(cur, op.column, "関数呼び出しは使えません");
    default:
      return ok({ kind: "cmp", op: "==", name: name.value, value: { kind: "bool", value: true } });
  }
}

function isStateKeyword(token: Token): boolean {
  return token.kind === "ident" && token.text === "state";
}

function parseStateAtom(cur: Cursor): ParseResult<StatePred> {
  if (!isStateKeyword(peek(cur))) return unexpected(cur);
  take(cur);
  const op = peek(cur);
  if (op.kind === "==" || op.kind === "!=") {
    take(cur);
    const state = parseName(cur, "state");
    if (!state.ok) return state;
    const atom: StatePred = { kind: "state-in", states: [state.value] };
    return ok(op.kind === "==" ? atom : { kind: "not", operand: atom });
  }
  if (op.kind === "ident" && op.text === "in") {
    take(cur);
    const states = parseNameSet(cur, "state");
    return states.ok ? ok({ kind: "state-in", states: states.value }) : states;
  }
  return fail(cur, op.column, "state の後ろは ==、!=、in のどれかです");
}

function parseValue(cur: Cursor): ParseResult<Value> {
  const token = peek(cur);
  if (token.kind === "int" || token.kind === "-") {
    const number = parseNatural(cur);
    return number.ok ? ok({ kind: "int", value: number.value }) : number;
  }
  if (token.kind === "ident" && (token.text === "TRUE" || token.text === "FALSE")) {
    take(cur);
    return ok({ kind: "bool", value: token.text === "TRUE" });
  }
  const member = parseName(cur, "member");
  return member.ok ? ok({ kind: "member", name: member.value }) : member;
}

function parseNatural(cur: Cursor): ParseResult<number> {
  const token = peek(cur);
  if (token.kind === "-") return fail(cur, token.column, "負の整数は使えません");
  if (token.kind !== "int") return unexpected(cur);
  const value = Number(token.text);
  if (!Number.isSafeInteger(value)) return fail(cur, token.column, "整数が大きすぎます");
  take(cur);
  return ok(value);
}

type Brands = { var: VarName; state: StateName; member: MemberName; event: EventName };

const ROLE_LABEL = {
  var: "変数名",
  state: "状態名",
  member: "メンバー名",
  event: "イベント名",
} satisfies Record<keyof Brands, string>;

function parseName<Role extends keyof Brands>(cur: Cursor, role: Role): ParseResult<Brands[Role]> {
  const token = peek(cur);
  if (token.kind !== "ident") return unexpected(cur);
  const text = token.text.normalize("NFC");
  if (KEYWORDS.includes(text)) {
    return fail(cur, token.column, `${text} は予約語なので${ROLE_LABEL[role]}に使えません`);
  }
  take(cur);
  return ok(text as Brands[Role]);
}

function parseNameSet<Role extends "state" | "member">(
  cur: Cursor,
  role: Role,
): ParseResult<NonEmpty<Brands[Role]>> {
  const open = expect(cur, "{");
  if (!open.ok) return open;
  const close = peek(cur);
  if (close.kind === "}") return fail(cur, close.column, "空の集合は使えません");
  const first = parseName(cur, role);
  if (!first.ok) return first;
  const names: [Brands[Role], ...Brands[Role][]] = [first.value];
  while (peek(cur).kind === ",") {
    take(cur);
    const at = peek(cur);
    const next = parseName(cur, role);
    if (!next.ok) return next;
    if (names.includes(next.value)) return fail(cur, at.column, `${next.value} が重複しています`);
    names.push(next.value);
  }
  const end = expect(cur, "}");
  return end.ok ? ok(names) : end;
}

function parseAssignmentList(cur: Cursor): ParseResult<NonEmpty<Assignment>> {
  const first = parseAssignment(cur);
  if (!first.ok) return first;
  const list: [Assignment, ...Assignment[]] = [first.value];
  while (peek(cur).kind === ",") {
    take(cur);
    const at = peek(cur);
    const next = parseAssignment(cur);
    if (!next.ok) return next;
    if (list.some((assignment) => assignment.target === next.value.target)) {
      return fail(cur, at.column, "同じ変数に 2 回代入しています");
    }
    list.push(next.value);
  }
  return ok(list);
}

function parseAssignment(cur: Cursor): ParseResult<Assignment> {
  const target = parseName(cur, "var");
  if (!target.ok) return target;
  const equals = peek(cur);
  if (equals.kind === "==") return fail(cur, equals.column, "代入は = を使います（== は比較）");
  const assigned = expect(cur, "=");
  if (!assigned.ok) return assigned;

  const sign = peek(cur, 1).kind;
  if (peek(cur).kind === "ident" && (sign === "+" || sign === "-")) {
    const source = parseName(cur, "var");
    if (!source.ok) return source;
    take(cur);
    const at = peek(cur);
    const step = parseNatural(cur);
    if (!step.ok) return step;
    if (step.value !== 1) return fail(cur, at.column, "加減算は +1 と -1 だけです");
    const delta = sign === "+" ? 1 : -1;
    return ok({ target: target.value, value: { kind: "offset", of: source.value, delta } });
  }
  const value = parseValue(cur);
  return value.ok ? ok({ target: target.value, value: value.value }) : value;
}

function parseVarType(cur: Cursor): ParseResult<VarType> {
  const head = peek(cur);
  switch (head.kind) {
    case "{": {
      const members = parseNameSet(cur, "member");
      return members.ok ? ok({ kind: "enum", members: members.value }) : members;
    }
    case "int":
    case "-": {
      const min = parseNatural(cur);
      if (!min.ok) return min;
      const dots = expect(cur, "..");
      if (!dots.ok) return dots;
      const upper = peek(cur);
      const max = parseNatural(cur);
      if (!max.ok) return max;
      if (min.value > max.value) {
        return fail(
          cur,
          upper.column,
          `範囲の最小 ${min.value} が最大 ${max.value} より大きいです`,
        );
      }
      return ok({ kind: "range", min: min.value, max: max.value });
    }
    case "ident":
      if (head.text !== "BOOLEAN") {
        return fail(
          cur,
          head.column,
          `未対応の型 ${head.text}（BOOLEAN、N..M、{a,b,c} だけ使えます）`,
        );
      }
      take(cur);
      return ok({ kind: "boolean" });
    default:
      return unexpected(cur);
  }
}

function parseDeclaration(cur: Cursor): ParseResult<ModelVar> {
  const name = parseName(cur, "var");
  if (!name.ok) return name;
  const colon = expect(cur, ":");
  if (!colon.ok) return colon;
  const type = parseVarType(cur);
  if (!type.ok) return type;
  const equals = expect(cur, "=");
  if (!equals.ok) return equals;
  const at = peek(cur);
  const parsed = parseValue(cur);
  if (!parsed.ok) return parsed;

  const init = parsed.value;
  const shape = type.value;
  switch (shape.kind) {
    case "boolean":
      if (init.kind !== "bool") {
        return fail(cur, at.column, "BOOLEAN の初期値は TRUE か FALSE です");
      }
      return ok({ kind: "boolean", name: name.value, init: init.value });
    case "range":
      if (init.kind !== "int" || init.value < shape.min || init.value > shape.max) {
        return fail(cur, at.column, `初期値が範囲 ${shape.min}..${shape.max} の外です`);
      }
      return ok({
        kind: "range",
        name: name.value,
        min: shape.min,
        max: shape.max,
        init: init.value,
      });
    case "enum":
      if (init.kind !== "member" || !shape.members.includes(init.name)) {
        return fail(cur, at.column, "初期値が集合のメンバーではありません");
      }
      return ok({ kind: "enum", name: name.value, members: shape.members, init: init.name });
  }
}
