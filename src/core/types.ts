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

/** An event named by `on:` or `@state-event`. Minted only by `src/core/expr.ts`. */
export type EventName = Brand<string, "EventName">;

/** The `id` of a definition in `everypath.properties.json`. Minted only by `src/core/properties.ts`. */
export type PropertyId = Brand<string, "PropertyId">;

/** One annotation or input file the scanner could not use. `detail` is the parser's own warning, if any. */
export type ScanWarning = {
  readonly file: string | null;
  readonly line: number | null;
  readonly message: string;
  readonly detail: ParseWarning | null;
};

export type NodeStatus = {
  readonly tested: boolean;
  readonly vuln: boolean;
  readonly wip: boolean;
  readonly planned: boolean;
  readonly requireProof: boolean;
  readonly proof: "none" | "pending" | "passed" | "failed";
  readonly reviewed: boolean;
  readonly changedSinceReview: boolean;
};

export type Finding = {
  readonly file: string;
  readonly line: number | null;
  readonly severity: "high" | "medium" | "low";
  readonly rule: string;
  readonly message: string;
};

/** A `@state-risk` the agent declared about itself. Kept apart from scanner findings. */
export type Risk = { readonly file: string; readonly message: string };

export type StateNode = {
  readonly id: StateName;
  readonly group: string | null;
  readonly desc: string | null;
  /** Root-relative, `/`-separated, sorted. Empty for a planned node. */
  readonly files: readonly string[];
  readonly lines: number;
  /** sha1 of the node's file contents concatenated in `files` order. Approvals match against it. */
  readonly hash: string;
  readonly status: NodeStatus;
  readonly spec: readonly string[];
  readonly risks: readonly Risk[];
  readonly findings: readonly Finding[];
  /** Ids of the violated properties whose counterexample passes through this node, in file order. */
  readonly violations: readonly PropertyId[];
  readonly lastChangedAt: string;
};

export type FlowEdge = {
  readonly type: "flow";
  readonly from: StateName;
  readonly to: StateName;
  readonly event: EventName | null;
  readonly guard: GuardExpr | null;
  readonly set: readonly Assignment[];
  /** Everything after `@state-next`, as written. Two declarations with the same text are one edge. */
  readonly text: string;
  readonly via: readonly string[];
  readonly declared: true;
  /** A navigation call in the source's files reaches the target. `false` is no evidence of absence. */
  readonly observed: boolean;
};

export type DepEdge = {
  readonly type: "dep";
  readonly from: StateName;
  readonly to: StateName;
  readonly via: readonly string[];
};

/**
 * A navigation call no `@state-next` declares. A type of its own because the BFS and TLC lanes read
 * `flow` edges only, so drift never enters the model: the model is the declaration.
 */
export type ObservedEdge = {
  readonly type: "observed";
  readonly from: StateName;
  readonly to: StateName;
  readonly declared: false;
  readonly observed: true;
  /** The files that make the call. */
  readonly via: readonly string[];
};

export type Edge = FlowEdge | DepEdge | ObservedEdge;

/** Where the code and the declaration disagree. A declared flow the code never takes is not drift. */
export type Drift = {
  readonly kind: "observed-not-declared";
  readonly from: StateName;
  readonly to: StateName;
  readonly via: readonly string[];
};

export type GraphModel = {
  readonly initial: StateName | null;
  readonly vars: readonly ModelVar[];
  readonly events: readonly EventName[];
};

/** `tested`, `untested` and `unreviewed` count real nodes only: a planned node has no code to test or review. */
export type GraphStats = {
  readonly nodes: number;
  readonly edges: number;
  readonly tested: number;
  readonly untested: number;
  readonly vuln: number;
  readonly wip: number;
  readonly planned: number;
  readonly unreviewed: number;
};

export type PropertyDef = {
  readonly id: PropertyId;
  readonly description: string | null;
} & (
  | { readonly kind: "invariant"; readonly expr: PropertyExpr }
  | { readonly kind: "leads-to"; readonly from: PropertyExpr; readonly to: PropertyExpr }
  | {
      readonly kind: "never-reach";
      readonly target: NonEmpty<StateName>;
      readonly avoid: readonly StateName[];
    }
  | { readonly kind: "always-reach"; readonly target: NonEmpty<StateName> }
  | { readonly kind: "no-dead-end"; readonly except: readonly StateName[] }
  | {
      readonly kind: "dep-only-via";
      /** `from_group` in the file: a `@state-group` value. Every state of the group is a start. */
      readonly fromGroup: string;
      readonly target: NonEmpty<StateName>;
      readonly via: NonEmpty<StateName>;
    }
);

/** `everypath.properties.json` after validation. A `null` entry means "work it out from the graph". */
export type PropertiesFile = {
  readonly entry: NonEmpty<StateName> | null;
  readonly properties: readonly PropertyDef[];
};

/** One state on a counterexample. `event` is what led here, `null` for the first state. */
export type Step = {
  readonly state: StateName;
  readonly event: EventName | null;
  /** Variable values at this state. The BFS lane has no variables and writes `{}`. */
  readonly vars: Readonly<Record<VarName, string>>;
};

export type Counterexample = {
  /** The `state` of each step. */
  readonly path: NonEmpty<StateName>;
  readonly steps: NonEmpty<Step>;
  /**
   * 0-based index into `steps`: after the last step the behavior goes back to `steps[loopStart]` and
   * repeats forever. `null` for a finite trace, which is every BFS counterexample.
   */
  readonly loopStart: number | null;
};

/**
 * What TLC said about a property the quick check found violated. The quick check takes every guard as
 * true, so its path may be one no behavior can take: `ok` means the path is open only with guards
 * ignored, and `violated` comes with a behavior TLC found, with the variable values.
 */
export type TlcVerdict = {
  readonly result: "ok" | "violated" | "error";
  readonly counterexamples: readonly Counterexample[];
  readonly statesExplored: number | null;
  readonly checkedAt: string;
  /** As on `PropertyResult`: the model TLC checked has changed since. */
  readonly staleModel?: true;
};

export type PropertyResult = {
  readonly id: PropertyId;
  readonly kind: PropertyDef["kind"];
  readonly description: string | null;
  readonly checkedBy: "bfs" | "tlc" | "both";
  readonly result: "ok" | "violated" | "error" | "pending";
  readonly counterexamples: readonly Counterexample[];
  /** States the search reached. `null` while the result is pending. */
  readonly statesExplored: number | null;
  readonly checkedAt: string;
  /**
   * Only on a TLC verdict about a model that has changed since the run: the states, transitions,
   * variables or properties TLC checked are no longer the ones this graph describes. Such a verdict
   * marks no node and fails no check.
   */
  readonly staleModel?: true;
  /**
   * Only on a quick-check `violated` that TLC also checked. It sits beside the quick check's verdict
   * and never replaces it: `result`, `counterexamples`, `checkedBy` and the marks on nodes stay the
   * quick check's.
   */
  readonly tlc?: TlcVerdict;
};

export type Graph = {
  readonly version: 1;
  readonly generatedAt: string;
  readonly root: string;
  readonly findingsSource: string | null;
  readonly stats: GraphStats;
  readonly nodes: readonly StateNode[];
  readonly edges: readonly Edge[];
  readonly model: GraphModel;
  readonly properties: readonly PropertyResult[];
  readonly drift: readonly Drift[];
  readonly warnings: readonly ScanWarning[];
};

export type Approval = {
  readonly hash: string;
  readonly at: string;
  readonly by: string;
  readonly note: string;
};

/** `.everypath/layout.json`: where the viewer drew each node, by node id. No scan reads it. */
export type Layout = Readonly<Record<string, { readonly x: number; readonly y: number }>>;

/** `.everypath/review.json`. Written by the viewer, read by the scanner. */
export type ReviewFile = {
  readonly version: 1;
  readonly approvals: Readonly<Record<string, Approval>>;
};

/** An edge as `history.jsonl` identifies it. A dep has no event. History records no drift. */
export type EdgeRef = {
  readonly type: (FlowEdge | DepEdge)["type"];
  readonly from: StateName;
  readonly to: StateName;
  readonly event: EventName | null;
};

/** One line of `.everypath/history.jsonl`. */
export type HistoryEntry = {
  readonly at: string;
  readonly reason: string;
  readonly added: readonly StateName[];
  readonly removed: readonly StateName[];
  readonly updated: readonly StateName[];
  readonly addedEdges: readonly EdgeRef[];
  readonly removedEdges: readonly EdgeRef[];
};
