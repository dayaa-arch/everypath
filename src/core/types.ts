declare const nominal: unique symbol;
type Brand<T, Tag extends string> = T & { readonly [nominal]: Tag };

/** A model variable. Minted only by `src/core/expr.ts`. NFC-normalized, never a keyword. */
export type VarName = Brand<string, "VarName">;
/** A statechart state. Minted only by `src/core/expr.ts`, so a node id and `state == X` compare with `===`. */
export type StateName = Brand<string, "StateName">;
/** A member of an enum variable's domain, as written in `{a,b,c}` or in value position. */
export type MemberName = Brand<string, "MemberName">;

export type NonEmpty<T> = readonly [T, ...T[]];
type AtLeastTwo<T> = readonly [T, T, ...T[]];

export type ParseWarning = {
  readonly message: string;
  readonly input: string;
  /** 1-based UTF-16 column in `input`. `input.length + 1` when the input ended too early. */
  readonly column: number;
};

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly warning: ParseWarning };

type IntLit = { readonly kind: "int"; readonly value: number };

/** Integers are non-negative safe integers: the generated TLA+ extends Naturals. */
export type Value =
  | { readonly kind: "bool"; readonly value: boolean }
  | IntLit
  | { readonly kind: "member"; readonly name: MemberName };

/** A bare `authed` is parsed as `authed == TRUE`. Ordering compares with an integer only. */
type VarAtom =
  | {
      readonly kind: "cmp";
      readonly op: "==" | "!=";
      readonly name: VarName;
      readonly value: Value;
    }
  | {
      readonly kind: "cmp";
      readonly op: "<" | "<=" | ">" | ">=";
      readonly name: VarName;
      readonly value: IntLit;
    };

/** `state == A` is `{A}`; `state != A` is `not({A})`. Members are distinct. */
type StateAtom = { readonly kind: "state-in"; readonly states: NonEmpty<StateName> };

type Expr<Atom, Implication extends boolean> =
  | Atom
  | { readonly kind: "not"; readonly operand: Expr<Atom, Implication> }
  | { readonly kind: "and"; readonly operands: AtLeastTwo<Expr<Atom, Implication>> }
  | { readonly kind: "or"; readonly operands: AtLeastTwo<Expr<Atom, Implication>> }
  | (Implication extends true
      ? {
          readonly kind: "implies";
          readonly antecedent: Expr<Atom, Implication>;
          readonly consequent: Expr<Atom, Implication>;
        }
      : never);

/** `@state-next ... if:<guard>`. No `state`, no `=>`. Assignable to `PropExpr`. */
export type GuardExpr = Expr<VarAtom, false>;
/** A property `expr`, `from` or `to`. */
export type PropExpr = Expr<VarAtom | StateAtom, true>;
/** A property with no variable. The BFS checker decides it from reachable states alone. */
export type StatePred = Expr<StateAtom, true>;

export type PropertyExpr =
  | { readonly mentionsVars: false; readonly expr: StatePred }
  | { readonly mentionsVars: true; readonly expr: PropExpr };

/**
 * One `VAR = RHS` of a `set:` list. Targets in one list are distinct (parser-checked).
 * An array, not a Map, because edges are serialized into graph.json.
 */
export type Assignment = {
  readonly target: VarName;
  readonly value: Value | { readonly kind: "offset"; readonly of: VarName; readonly delta: 1 | -1 };
};

/** Parser-guaranteed: 0 <= min <= max, members distinct, init inside the domain. */
export type VarType =
  | { readonly kind: "boolean" }
  | { readonly kind: "range"; readonly min: number; readonly max: number }
  | { readonly kind: "enum"; readonly members: NonEmpty<MemberName> };

/** A `@state-var` declaration. `init` has the representation of its own `kind`. */
export type ModelVar =
  | { readonly kind: "boolean"; readonly name: VarName; readonly init: boolean }
  | {
      readonly kind: "range";
      readonly name: VarName;
      readonly min: number;
      readonly max: number;
      readonly init: number;
    }
  | {
      readonly kind: "enum";
      readonly name: VarName;
      readonly members: NonEmpty<MemberName>;
      readonly init: MemberName;
    };
