import type {
  parseAssignments,
  parseGuard,
  parseStateName,
  parseVarDecl,
} from "../src/core/expr.js";
import type {
  Assignment,
  GuardExpr,
  ModelVar,
  ParseResult,
  PropExpr,
  PropertyExpr,
  StatePred,
  Value,
  VarType,
} from "../src/core/types.js";

// Type-level only: `npm run typecheck` compiles this file and `npm test` never loads it.
// Every brand value is typed by a parser's return type, never by a cast, so each
// `@ts-expect-error` below can fail only for the structural reason written next to it.

type Parsed<R extends ParseResult<unknown>> = Extract<R, { readonly ok: true }>["value"];
type EnumVar = Extract<Parsed<ReturnType<typeof parseVarDecl>>, { readonly kind: "enum" }>;

declare const home: Parsed<ReturnType<typeof parseStateName>>;
declare const v: Parsed<ReturnType<typeof parseAssignments>>[0]["target"];
declare const m: EnumVar["members"][0];
declare const guard: Parsed<ReturnType<typeof parseGuard>>;

const on = { kind: "bool", value: true } satisfies Value;
const three = { kind: "int", value: 3 } satisfies Value;
const mem = { kind: "member", name: m } satisfies Value;

// Accepted shapes, so each rejection below isolates one property.
export const eqBool: GuardExpr = { kind: "cmp", op: "==", name: v, value: on };
export const ltInt: GuardExpr = { kind: "cmp", op: "<", name: v, value: three };
export const neMember: GuardExpr = { kind: "cmp", op: "!=", name: v, value: mem };
export const both: GuardExpr = { kind: "and", operands: [eqBool, ltInt] };
export const stateIn: PropExpr = { kind: "state-in", states: [home] };
export const implied: PropExpr = { kind: "implies", antecedent: stateIn, consequent: guard };
export const pred: StatePred = { kind: "implies", antecedent: stateIn, consequent: stateIn };
export const noVars: PropertyExpr = { mentionsVars: false, expr: pred };
export const withVars: PropertyExpr = { mentionsVars: true, expr: implied };
export const setBool: Assignment = { target: v, value: on };
export const bump: Assignment = { target: v, value: { kind: "offset", of: v, delta: 1 } };
export const drop: Assignment = { target: v, value: { kind: "offset", of: v, delta: -1 } };
export const enumType: VarType = { kind: "enum", members: [m] };
export const enumVar: ModelVar = { kind: "enum", name: v, members: [m], init: m };
export const boolVar: ModelVar = { kind: "boolean", name: v, init: false };

// A GuardExpr is a PropExpr, so one translator serves both.
export const widened: PropExpr = guard;

// @ts-expect-error a guard has no state-in atom
export const withState: GuardExpr = { kind: "state-in", states: [home] };
// @ts-expect-error a guard has no implies
export const withImplies: GuardExpr = { kind: "implies", antecedent: guard, consequent: guard };
// @ts-expect-error ordering compares with an integer, not a bool
export const orderedBool: GuardExpr = { kind: "cmp", op: "<", name: v, value: on };
// @ts-expect-error ordering compares with an integer, not an enum member
export const orderedMember: GuardExpr = { kind: "cmp", op: ">=", name: v, value: mem };
// @ts-expect-error and needs at least two operands
export const loneAnd: GuardExpr = { kind: "and", operands: [eqBool] };
// @ts-expect-error a PropExpr may hold state-in, so it is not a GuardExpr
export const narrowed: GuardExpr = implied;
// @ts-expect-error a property that mentions variables is not a StatePred
export const mislabeled: PropertyExpr = { mentionsVars: false, expr: implied };
// @ts-expect-error a state-in needs at least one state
export const noStates: PropExpr = { kind: "state-in", states: [] };

// @ts-expect-error an enum needs at least one member
export const emptyEnum: VarType = { kind: "enum", members: [] };
// @ts-expect-error an enum init is a MemberName, not a plain string
export const plainInit: ModelVar = { kind: "enum", name: v, members: [m], init: "a" };

// @ts-expect-error an assignment target is a VarName, not a plain string
export const plainTarget: Assignment = { target: "retries", value: on };
// @ts-expect-error a comparison names a VarName, not a plain string
export const plainName: GuardExpr = { kind: "cmp", op: "==", name: "authed", value: on };
// @ts-expect-error a declared variable is a VarName, not a plain string
export const plainDecl: ModelVar = { kind: "boolean", name: "authed", init: false };
// @ts-expect-error a state-in holds StateNames, not plain strings
export const plainState: PropExpr = { kind: "state-in", states: ["Home"] };

// @ts-expect-error an offset moves by 1 or -1
export const bigDelta: Assignment = { target: v, value: { kind: "offset", of: v, delta: 2 } };
