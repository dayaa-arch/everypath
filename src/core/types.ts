declare const nominal: unique symbol;
type Brand<T, Tag extends string> = T & { readonly [nominal]: Tag };

/** A model variable. Minted only by `src/core/expr.ts`. NFC-normalized, never a keyword. */
export type VarName = Brand<string, "VarName">;
/** A statechart state. Minted only by `src/core/expr.ts`, so a node id and `state == X` compare with `===`. */
export type StateName = Brand<string, "StateName">;
/** A member of an enum variable's domain, as written in `{a,b,c}` or in value position. */
export type MemberName = Brand<string, "MemberName">;

declare const leaf: unique symbol;
/**
 * A state of the flat model: a node with no child. A transition goes from a leaf to a leaf, a property
 * is judged on leaves, and TLA+ has one `S` constant per leaf. Minted only by `src/core/hierarchy.ts`.
 */
export type Leaf = StateName & { readonly [leaf]: true };

export type NonEmpty<T> = readonly [T, ...T[]];
export type AtLeastTwo<T> = readonly [T, T, ...T[]];

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
export type VarAtom =
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

export type Expr<Atom, Implication extends boolean> =
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
  /** `review` is an `approval` of this `hash`. A conflict is not reviewed. */
  readonly reviewed: boolean;
  /** `review` is an `approval` of another hash: the files changed after it. */
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

/** `proof.tool` in `everypath.config.json`: how `everypath prove` reads the prover's output. */
export type ProofTool = "dafny" | "verus" | "command";

/** `proof` in `everypath.config.json`, with the tool's default command filled in. */
export type Prover = {
  readonly tool: ProofTool;
  /** Split on spaces and run without a shell. The word `{files}` becomes the node's files. */
  readonly command: string;
};

/** One value of `.everypath/proofs.json`, keyed by node id. `everypath prove` writes it. */
export type ProofEntry = {
  readonly result: "passed" | "failed" | "pending";
  /** Any name: a tool outside `ProofTool` may write the file too. */
  readonly tool: string;
  /** What the tool said: the obligations that failed, or its summary. May be empty. */
  readonly message: string;
  readonly at: string;
  /** The node's `hash` when the tool ran. Another hash means its files changed since. */
  readonly hash: string;
};

/** A node's entry as the graph shows it. `stale`: the node's files changed after the tool ran. */
export type NodeProof = Omit<ProofEntry, "hash"> & { readonly stale: boolean };

/**
 * The three fields of `@state-parent` are written only when they are set, so the graph.json of a
 * repository without it is what it was before it existed.
 */
export type StateNode = {
  readonly id: StateName;
  /** The state this one is inside. Absent at the top level. Acyclic, at most `MAX_DEPTH` deep. */
  readonly parent?: StateName;
  /** On a state with children: the child `@state-initial` marks. The top level's mark is `model.initial`. */
  readonly initialChild?: StateName;
  /**
   * A state with children that no file claims: a frame round them and nothing else. It is not
   * `planned`, and has nothing to test, review or approve.
   */
  readonly container?: true;
  readonly group: string | null;
  readonly desc: string | null;
  /** Root-relative, `/`-separated, sorted. Empty for a planned node and a container. */
  readonly files: readonly string[];
  readonly lines: number;
  /** sha1 of the node's file contents concatenated in `files` order. Approvals match against it. */
  readonly hash: string;
  /** `proof` is `none` with no entry, `pending` for a stale one, else the entry's result. */
  readonly status: NodeStatus;
  readonly spec: readonly string[];
  /** The node's entry in `.everypath/proofs.json`. Absent when it has none. */
  readonly proof?: NodeProof;
  /** The approval records about the node. Absent when it has no live approval. */
  readonly review?: NodeReview;
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

/**
 * `tested`, `untested` and `unreviewed` count real nodes only: a planned node and a container have
 * no code to test or review. `planned` counts no container.
 */
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
  /** What `everypath prove` runs. Absent when the config has no usable `proof`. */
  readonly prover?: Prover;
  readonly stats: GraphStats;
  readonly nodes: readonly StateNode[];
  readonly edges: readonly Edge[];
  readonly model: GraphModel;
  readonly properties: readonly PropertyResult[];
  readonly drift: readonly Drift[];
  readonly warnings: readonly ScanWarning[];
};

/**
 * One person's approval of a node's content. `by` is a display name (git's `user.name`, else
 * `$USER`, else empty), never an identity: nothing decides by it.
 */
export type Approval = {
  /** The node `hash` the person approved. */
  readonly hash: string;
  readonly at: string;
  readonly by: string;
  readonly note: string;
};

/** One live record of a node in conflict. `unreadable` is a record this version cannot read. */
export type ReviewMark =
  | ({ readonly kind: "approve" } & Approval)
  | { readonly kind: "revoke"; readonly at: string; readonly by: string }
  | { readonly kind: "unreadable"; readonly file: string };

/**
 * What the approval records say about a node, on `StateNode.review`, written only when a live
 * approval exists. `approval`: every live approval agrees on one hash, and the newest is shown.
 * `conflict`: approvals of two hashes, or an approval beside a revocation or an unreadable record,
 * newest first with unreadable records last. A conflict is never reviewed.
 */
export type NodeReview =
  | { readonly approval: Approval }
  | { readonly conflict: AtLeastTwo<ReviewMark> };

/** `.everypath/layout.json`: where the viewer drew each node, by node id. No scan reads it. */
export type Layout = Readonly<Record<string, { readonly x: number; readonly y: number }>>;

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
