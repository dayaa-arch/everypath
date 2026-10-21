import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseAssignments,
  parseEventName,
  parseGuard,
  parseProperty,
  parseStateName,
  parseVarDecl,
  sanitizeStateName,
} from "../src/core/expr.js";
import type { ParseResult } from "../src/core/types.js";

type Parser = (input: string) => ParseResult<unknown>;
type Accept = { readonly input: string; readonly expected: unknown };
type Reject = { readonly name: string; readonly input: string; readonly column: number };

const bool = (value: boolean) => ({ kind: "bool", value });
const int = (value: number) => ({ kind: "int", value });
const member = (name: string) => ({ kind: "member", name });
const cmp = (op: string, name: string, value: unknown) => ({ kind: "cmp", op, name, value });
const flag = (name: string) => cmp("==", name, bool(true));
const stateIn = (...states: string[]) => ({ kind: "state-in", states });
const not = (operand: unknown) => ({ kind: "not", operand });
const and = (...operands: unknown[]) => ({ kind: "and", operands });
const or = (...operands: unknown[]) => ({ kind: "or", operands });
const implies = (antecedent: unknown, consequent: unknown) => ({
  kind: "implies",
  antecedent,
  consequent,
});
const assign = (target: string, value: unknown) => ({ target, value });
const offset = (of: string, delta: 1 | -1) => ({ kind: "offset", of, delta });
const property = (mentionsVars: boolean, expr: unknown) => ({ mentionsVars, expr });
const boolVar = (name: string, init: boolean) => ({ kind: "boolean", name, init });
const rangeVar = (name: string, min: number, max: number, init: number) => ({
  kind: "range",
  name,
  min,
  max,
  init,
});
const enumVar = (name: string, members: string[], init: string) => ({
  kind: "enum",
  name,
  members,
  init,
});

function accepts(parse: Parser, input: string, value: unknown): void {
  assert.deepStrictEqual(parse(input), { ok: true, value });
}

function rejects(parse: Parser, input: string, column: number): void {
  const result = parse(input);
  if (result.ok) {
    assert.fail(`accepted ${JSON.stringify(input)} as ${JSON.stringify(result.value)}`);
  }
  assert.equal(result.warning.input, input);
  assert.equal(result.warning.column, column, `column for ${JSON.stringify(input)}`);
}

function acceptCases(title: string, parse: Parser, cases: readonly Accept[]): void {
  describe(title, () => {
    for (const { input, expected } of cases) {
      it(`accepts ${JSON.stringify(input)}`, () => accepts(parse, input, expected));
    }
  });
}

function rejectCases(title: string, parse: Parser, cases: readonly Reject[]): void {
  describe(title, () => {
    for (const { name, input, column } of cases) {
      it(`rejects ${name} ${JSON.stringify(input)} at column ${column}`, () =>
        rejects(parse, input, column));
    }
  });
}

const guardSpec: readonly Accept[] = [
  { input: "retries<3", expected: cmp("<", "retries", int(3)) },
  { input: "retries==3", expected: cmp("==", "retries", int(3)) },
  { input: "authed", expected: flag("authed") },
  { input: "a && b || !c", expected: or(and(flag("a"), flag("b")), not(flag("c"))) },
];

const guardMore: readonly Accept[] = [
  { input: "retries < 3", expected: cmp("<", "retries", int(3)) },
  { input: "  retries<3  ", expected: cmp("<", "retries", int(3)) },
  { input: "retries<=3", expected: cmp("<=", "retries", int(3)) },
  { input: "retries>0", expected: cmp(">", "retries", int(0)) },
  { input: "retries>=1", expected: cmp(">=", "retries", int(1)) },
  { input: "retries!=2", expected: cmp("!=", "retries", int(2)) },
  { input: "retries < 9007199254740991", expected: cmp("<", "retries", int(9007199254740991)) },
  { input: "authed == TRUE", expected: cmp("==", "authed", bool(true)) },
  { input: "authed == FALSE", expected: cmp("==", "authed", bool(false)) },
  { input: "mode == b", expected: cmp("==", "mode", member("b")) },
  { input: "mode != b", expected: cmp("!=", "mode", member("b")) },
  { input: "マイページ", expected: flag("マイページ") },
  { input: "!authed", expected: not(flag("authed")) },
  { input: "(authed)", expected: flag("authed") },
  {
    input: "authed && retries<3",
    expected: and(flag("authed"), cmp("<", "retries", int(3))),
  },
  { input: "a && b && c", expected: and(flag("a"), flag("b"), flag("c")) },
  { input: "a || b || c", expected: or(flag("a"), flag("b"), flag("c")) },
  { input: "a || b && c", expected: or(flag("a"), and(flag("b"), flag("c"))) },
  {
    input: "a && b && c || d",
    expected: or(and(flag("a"), flag("b"), flag("c")), flag("d")),
  },
  { input: "(a || b) && c", expected: and(or(flag("a"), flag("b")), flag("c")) },
  { input: "!(a && b)", expected: not(and(flag("a"), flag("b"))) },
];

const assignmentSpec: readonly Accept[] = [
  {
    input: "authed=TRUE, retries=0",
    expected: [assign("authed", bool(true)), assign("retries", int(0))],
  },
  { input: "retries=retries+1", expected: [assign("retries", offset("retries", 1))] },
];

const assignmentMore: readonly Accept[] = [
  { input: "retries=retries-1", expected: [assign("retries", offset("retries", -1))] },
  { input: "retries = retries + 1", expected: [assign("retries", offset("retries", 1))] },
  { input: "authed=FALSE", expected: [assign("authed", bool(false))] },
  { input: "mode=b", expected: [assign("mode", member("b"))] },
  { input: "x=y-1", expected: [assign("x", offset("y", -1))] },
  {
    input: "a=1,b=2,c=3",
    expected: [assign("a", int(1)), assign("b", int(2)), assign("c", int(3))],
  },
];

const varDeclSpec: readonly Accept[] = [
  { input: "authed: BOOLEAN = FALSE", expected: boolVar("authed", false) },
  { input: "retries: 0..3 = 0", expected: rangeVar("retries", 0, 3, 0) },
];

const varDeclTypes: readonly Accept[] = [
  { input: "mode: {a,b,c} = a", expected: enumVar("mode", ["a", "b", "c"], "a") },
  { input: "authed: BOOLEAN = TRUE", expected: boolVar("authed", true) },
  { input: "retries: 0..3 = 3", expected: rangeVar("retries", 0, 3, 3) },
  { input: "level: 2..5 = 2", expected: rangeVar("level", 2, 5, 2) },
  { input: "level: 2..5 = 5", expected: rangeVar("level", 2, 5, 5) },
  { input: "x: 0..0 = 0", expected: rangeVar("x", 0, 0, 0) },
  { input: "mode: {a,b,c} = b", expected: enumVar("mode", ["a", "b", "c"], "b") },
  { input: "mode: {a,b,c} = c", expected: enumVar("mode", ["a", "b", "c"], "c") },
  { input: "mode: {c,a,b} = a", expected: enumVar("mode", ["c", "a", "b"], "a") },
  { input: "mode:{a,b,c}=b", expected: enumVar("mode", ["a", "b", "c"], "b") },
  { input: "retries:0..3=0", expected: rangeVar("retries", 0, 3, 0) },
  { input: "authed:BOOLEAN=FALSE", expected: boolVar("authed", false) },
  {
    input: "page: {ログイン, マイページ} = マイページ",
    expected: enumVar("page", ["ログイン", "マイページ"], "マイページ"),
  },
];

const propertySpec: readonly Accept[] = [
  {
    input: "state in {Home, マイページ} => authed",
    expected: property(true, implies(stateIn("Home", "マイページ"), flag("authed"))),
  },
  { input: "retries <= 3", expected: property(true, cmp("<=", "retries", int(3))) },
  { input: "state == ログアウト", expected: property(false, stateIn("ログアウト")) },
  { input: "state == ログイン", expected: property(false, stateIn("ログイン")) },
  {
    input: "state == A => state == B => state == C",
    expected: property(false, implies(stateIn("A"), implies(stateIn("B"), stateIn("C")))),
  },
];

const propertyMore: readonly Accept[] = [
  {
    input: "(state == A => state == B) => state == C",
    expected: property(false, implies(implies(stateIn("A"), stateIn("B")), stateIn("C"))),
  },
  { input: "state != A", expected: property(false, not(stateIn("A"))) },
  { input: "!(state == A)", expected: property(false, not(stateIn("A"))) },
  { input: "state in {A}", expected: property(false, stateIn("A")) },
  { input: "state in {A, B, C}", expected: property(false, stateIn("A", "B", "C")) },
  { input: "state in {C, A, B}", expected: property(false, stateIn("C", "A", "B")) },
  {
    input: "state != A || state == B",
    expected: property(false, or(not(stateIn("A")), stateIn("B"))),
  },
  {
    input: "authed => retries<3",
    expected: property(true, implies(flag("authed"), cmp("<", "retries", int(3)))),
  },
  {
    input: "a || b => c && d",
    expected: property(true, implies(or(flag("a"), flag("b")), and(flag("c"), flag("d")))),
  },
  {
    input: "state == A && authed",
    expected: property(true, and(stateIn("A"), flag("authed"))),
  },
];

const stateNameSpec: readonly Accept[] = [{ input: "DB層", expected: "DB層" }];

const stateNameMore: readonly Accept[] = [
  { input: "Home", expected: "Home" },
  { input: "ログイン", expected: "ログイン" },
];

const guardRejects: readonly Reject[] = [
  { name: "function call", input: "check(authed)", column: 6 },
  { name: "string literal", input: 'name == "x"', column: 9 },
  { name: "unknown operator", input: "retries % 2", column: 9 },
  { name: "unbalanced paren", input: "(authed && retries<3", column: 21 },
  { name: "empty input", input: "", column: 1 },
  { name: "single = comparison", input: "retries = 3", column: 9 },
  { name: "=> in a guard", input: "authed => retries<3", column: 8 },
  { name: "state in a guard", input: "state == Home", column: 1 },
];

const assignmentRejects: readonly Reject[] = [
  { name: "expression on the right-hand side", input: "retries=retries*2", column: 16 },
  { name: "offset other than 1", input: "retries=retries+2", column: 17 },
];

const guardMalformed: readonly Reject[] = [
  { name: "leading whitespace before an unknown operator", input: "  retries % 2", column: 11 },
  { name: "operator without a right operand", input: "authed &&", column: 10 },
  { name: "operator without a left operand", input: "&& authed", column: 1 },
  { name: "single &", input: "authed & b", column: 8 },
  { name: "unmatched close paren", input: "authed)", column: 7 },
  { name: "empty parens", input: "()", column: 2 },
  { name: "two atoms in a row", input: "a b", column: 3 },
  { name: "dangling !", input: "!", column: 2 },
  { name: "comparison without a value", input: "retries<", column: 9 },
  { name: "ordering against a bool", input: "retries < TRUE", column: 11 },
  { name: "ordering against a member", input: "retries < b", column: 11 },
  { name: "negative integer", input: "retries < -1", column: 11 },
  { name: "integer beyond the safe range", input: "retries < 9007199254740993", column: 11 },
];

const assignmentMalformed: readonly Reject[] = [
  { name: "empty input", input: "", column: 1 },
  { name: "target without =", input: "retries", column: 8 },
  { name: "= without a value", input: "retries=", column: 9 },
  { name: "negative integer", input: "retries=-1", column: 9 },
  { name: "trailing comma", input: "a=1,", column: 5 },
  { name: "repeated target", input: "a=1, a=2", column: 6 },
  { name: "state as a target", input: "state=1", column: 1 },
];

const varDeclRejects: readonly Reject[] = [
  { name: "type string", input: "x: string = a", column: 4 },
  { name: "type number", input: "x: number = 0", column: 4 },
  { name: "empty range", input: "x: 3..1 = 1", column: 7 },
  { name: "empty enum", input: "x: {} = a", column: 5 },
  { name: "init above the range", input: "retries: 0..3 = 4", column: 17 },
  { name: "integer init for BOOLEAN", input: "authed: BOOLEAN = 1", column: 19 },
  { name: "init not in the enum", input: "mode: {a,b} = c", column: 15 },
  { name: "negative init", input: "x: 0..3 = -1", column: 11 },
];

const varDeclMalformed: readonly Reject[] = [
  { name: "init below the range", input: "x: 2..5 = 1", column: 11 },
  { name: "missing init", input: "retries: 0..3", column: 14 },
  { name: "missing colon", input: "authed BOOLEAN = FALSE", column: 8 },
  { name: "state as a variable name", input: "state: BOOLEAN = FALSE", column: 1 },
  { name: "empty input", input: "", column: 1 },
];

const propertyMalformed: readonly Reject[] = [
  { name: "state alone", input: "state", column: 6 },
  { name: "dangling =>", input: "authed =>", column: 10 },
  { name: "leading =>", input: "=> authed", column: 1 },
  { name: "empty state set", input: "state in {}", column: 11 },
  { name: "state set without braces", input: "state in Home", column: 10 },
  { name: "empty input", input: "", column: 1 },
];

const stateNameRejects: readonly Reject[] = [
  { name: "empty input", input: "", column: 1 },
  { name: "two words", input: "a b", column: 3 },
  { name: "operator inside", input: "A&&B", column: 2 },
];

describe("SPEC 5.2 and 6.3 expressions parse to the expected AST (condition 3)", () => {
  acceptCases("parseGuard", parseGuard, guardSpec);
  acceptCases("parseAssignments", parseAssignments, assignmentSpec);
  acceptCases("parseVarDecl", parseVarDecl, varDeclSpec);
  acceptCases("parseProperty", parseProperty, propertySpec);
  acceptCases("parseStateName", parseStateName, stateNameSpec);
});

describe("normalization, precedence and spacing", () => {
  acceptCases("parseGuard", parseGuard, guardMore);
  acceptCases("parseAssignments", parseAssignments, assignmentMore);
  acceptCases("parseProperty", parseProperty, propertyMore);
  acceptCases("parseStateName", parseStateName, stateNameMore);
});

describe("input outside the grammar is a located warning, not a throw (condition 4)", () => {
  rejectCases("parseGuard", parseGuard, guardRejects);
  rejectCases("parseAssignments", parseAssignments, assignmentRejects);
});

describe("variable types (condition 5)", () => {
  acceptCases("parseVarDecl", parseVarDecl, varDeclTypes);
  rejectCases("parseVarDecl", parseVarDecl, varDeclRejects);
});

describe("other malformed input", () => {
  rejectCases("parseGuard", parseGuard, guardMalformed);
  rejectCases("parseAssignments", parseAssignments, assignmentMalformed);
  rejectCases("parseVarDecl", parseVarDecl, varDeclMalformed);
  rejectCases("parseProperty", parseProperty, propertyMalformed);
  rejectCases("parseStateName", parseStateName, stateNameRejects);
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pieces: readonly string[] = [
  ...["(", ")", "&&", "||", "!", "=", "==", "!=", "<", "<=", ">", ">=", "=>", ",", ":"],
  ...["{", "}", "..", "+", "-", "*", "%", '"', "'", " ", " ", " "],
  ...["state", "in", "TRUE", "FALSE", "BOOLEAN", "authed", "retries", "マイページ", "DB層"],
  ...["＝", "（", "）", "😀", "𠮷"],
  ..."abcdxyzABCXYZ_".split(""),
  ..."0123456789".split(""),
];

function generate(next: () => number, count: number): string[] {
  const pick = () => pieces[Math.floor(next() * pieces.length)] ?? "";
  const corpus: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = Math.floor(next() * 41);
    let text = "";
    while (text.length < length) text += pick();
    corpus.push(text.slice(0, length));
  }
  return corpus;
}

function assertWellFormed(parse: Parser, input: string): boolean {
  const result = parse(input);
  assert.equal(typeof result.ok, "boolean", `ok for ${JSON.stringify(input)}`);
  if (!result.ok) {
    const { column } = result.warning;
    assert.equal(result.warning.input, input);
    assert.ok(
      Number.isInteger(column) && column >= 1 && column <= input.length + 1,
      `column ${column} out of range for ${JSON.stringify(input)}`,
    );
  }
  return result.ok;
}

type Fuzzed = {
  readonly name: string;
  readonly parse: Parser;
  readonly accepted: readonly Accept[];
  readonly acceptsRandomText: boolean;
};

const fuzzed: readonly Fuzzed[] = [
  {
    name: "parseGuard",
    parse: parseGuard,
    accepted: [...guardSpec, ...guardMore],
    acceptsRandomText: true,
  },
  {
    name: "parseAssignments",
    parse: parseAssignments,
    accepted: [...assignmentSpec, ...assignmentMore],
    acceptsRandomText: false,
  },
  {
    name: "parseVarDecl",
    parse: parseVarDecl,
    accepted: [...varDeclSpec, ...varDeclTypes],
    acceptsRandomText: false,
  },
  {
    name: "parseProperty",
    parse: parseProperty,
    accepted: [...propertySpec, ...propertyMore],
    acceptsRandomText: true,
  },
  {
    name: "parseStateName",
    parse: parseStateName,
    accepted: [...stateNameSpec, ...stateNameMore],
    acceptsRandomText: true,
  },
];

describe("arbitrary input never throws and rejections point inside the input (condition 6)", () => {
  const corpus = generate(mulberry32(0xc0ffee), 1000);

  for (const { name, parse, acceptsRandomText } of fuzzed) {
    it(`${name} over 1,000 generated strings`, () => {
      const outcomes = corpus.map((input) => assertWellFormed(parse, input));
      assert.ok(outcomes.includes(false), "the corpus has no rejected input");
      if (acceptsRandomText) assert.ok(outcomes.includes(true), "the corpus has no accepted input");
    });
  }

  for (const { name, parse, accepted } of fuzzed) {
    it(`${name} over every prefix of its accepted inputs`, () => {
      for (const { input } of accepted) {
        for (let end = 0; end <= input.length; end++) assertWellFormed(parse, input.slice(0, end));
      }
    });
  }
});

describe("event names", () => {
  acceptCases("parseEventName", parseEventName, [
    { input: "login_ok", expected: "login_ok" },
    { input: "  ログイン成功 ", expected: "ログイン成功" },
  ]);
  rejectCases("parseEventName", parseEventName, [
    { name: "empty input", input: "", column: 1 },
    { name: "two words", input: "login ok", column: 7 },
    { name: "keyword", input: "TRUE", column: 1 },
  ]);
});

describe("sanitizeStateName", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["login-form", "login_form"],
    ["2fa", "_2fa"],
    ["state", "state_"],
    ["BOOLEAN", "BOOLEAN_"],
    ["src/a/utils", "src_a_utils"],
    ["a.test", "a_test"],
    ["ログイン", "ログイン"],
    ["", "_"],
    ["\u0301x", "_\u0301x"],
  ];
  for (const [raw, expected] of cases) {
    it(`turns ${JSON.stringify(raw)} into ${JSON.stringify(expected)}`, () => {
      const name = sanitizeStateName(raw);
      assert.equal(name, expected.normalize("NFC"));
      accepts(parseStateName, name, name);
    });
  }
});
