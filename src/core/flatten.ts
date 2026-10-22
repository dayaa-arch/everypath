import { type Hierarchy, hierarchyOf } from "./hierarchy.js";
import type {
  Assignment,
  AtLeastTwo,
  DepEdge,
  EventName,
  Expr,
  FlowEdge,
  GraphModel,
  GuardExpr,
  Leaf,
  ModelVar,
  PropExpr,
  PropertiesFile,
  PropertyDef,
  PropertyExpr,
  PropertyId,
  StateName,
  StateNode,
  StatePred,
  VarAtom,
} from "./types.js";

// The one place that reads the tree to decide what a transition or a property means. The quick check
// and TLA+ generation take a `Flat` and nothing else, so there is no second reading to get wrong.

/** `state in {...}` after lowering: leaves only, and possibly none (a name the graph does not have). */
export type LeafAtom = { readonly kind: "state-in"; readonly states: readonly Leaf[] };
export type LeafExpr = Expr<VarAtom | LeafAtom, true>;
export type LeafPred = Expr<LeafAtom, true>;
export type LeafPropertyExpr =
  | { readonly mentionsVars: false; readonly expr: LeafPred }
  | { readonly mentionsVars: true; readonly expr: LeafExpr };

/**
 * A property definition after lowering: the kinds of `PropertyDef`, with state names resolved.
 * Behavior kinds hold leaves; `dep-only-via` holds declared nodes, because a dependency is between
 * files, not between behaviors.
 */
export type FlatPropertyDef = {
  readonly id: PropertyId;
  readonly description: string | null;
} & (
  | { readonly kind: "invariant"; readonly expr: LeafPropertyExpr }
  | { readonly kind: "leads-to"; readonly from: LeafPropertyExpr; readonly to: LeafPropertyExpr }
  | {
      readonly kind: "never-reach";
      readonly target: readonly Leaf[];
      readonly avoid: readonly Leaf[];
    }
  | { readonly kind: "always-reach"; readonly target: readonly Leaf[] }
  | { readonly kind: "no-dead-end"; readonly except: readonly Leaf[] }
  | {
      readonly kind: "dep-only-via";
      readonly fromGroup: string;
      readonly target: readonly StateName[];
      readonly via: readonly StateName[];
    }
);

/** A `@state-next` as declared, before the code is compared with it (`observed`). */
export type DeclaredFlow = Omit<FlowEdge, "observed">;

/**
 * One step the model can take, from a leaf to a leaf. A transition declared on a parent is one arc per
 * leaf inside it and per leaf it lands on; its guard may carry the negation of an inner rival's.
 */
export type FlatArc = {
  readonly from: Leaf;
  readonly to: Leaf;
  readonly event: EventName | null;
  readonly guard: GuardExpr | null;
  readonly set: readonly Assignment[];
  /** The `@state-next` this arc comes from. `declared.from` is `from` or one of its ancestors. */
  readonly declared: DeclaredFlow;
};

declare const flattened: unique symbol;

/** The statechart as the quick check and TLC see it. Made by `flattenModel` alone. */
export type FlatModel = {
  readonly [flattened]: true;
  readonly hierarchy: Hierarchy;
  /** Every leaf, in id order. */
  readonly states: readonly Leaf[];
  /** The leaves with code behind them. */
  readonly real: readonly Leaf[];
  /**
   * By source leaf, target leaf, event and text: the order `scan` sorts flow edges in, so a graph with
   * no `@state-parent` keeps its order, and a parent and its hand-flattened twin give one order. Ties
   * go by the declaration's source and target, so the order never depends on how the flows came in.
   */
  readonly arcs: readonly FlatArc[];
  /** What entering `model.initial` lands on. Empty without a top-level `@state-initial`. */
  readonly initial: readonly Leaf[];
  readonly vars: readonly ModelVar[];
  readonly events: readonly EventName[];
  /** For `dep-only-via`, which reads files' imports, not behavior. */
  readonly deps: readonly DepEdge[];
  readonly groups: ReadonlyMap<string, readonly StateName[]>;
};

export type UnknownName = {
  readonly in: "entry" | { readonly property: PropertyId; readonly field: string };
  readonly name: StateName;
};

/** A graph's model and its properties file, flattened together: all a checking lane reads. */
export type Flat = {
  readonly model: FlatModel;
  /**
   * Where behavior starts: what the file's `entry` enters, else what `model.initial` enters, else
   * the real leaves nothing else leads to. TLA+'s `Init` and the quick check's searches start here.
   */
  readonly entry: readonly Leaf[];
  readonly properties: readonly FlatPropertyDef[];
  /** Names in the properties file that the graph does not have; the quick check words the warnings. */
  readonly unknown: readonly UnknownName[];
  /**
   * Parents with several children and no `@state-initial` that a transition enters, or that behavior
   * starts in (the file's `entry`, else `model.initial`), in id order. Entering one lands on every child.
   */
  readonly ambiguous: readonly StateName[];
  /** The inner flows whose unread `if:` left a parent's transition in place, in flow order. */
  readonly unreadRivals: readonly UnreadRival[];
};

/**
 * A flow whose `if:` could not be read, on an event a state above it also has a transition on. It
 * lost its guard, as every clause with a problem does, but it shadows nothing: failing closed keeps
 * the inherited arcs. `kept` is those states, in id order; `scan` words the warning.
 */
export type UnreadRival = { readonly rival: DeclaredFlow; readonly kept: readonly StateName[] };

/** The statechart as the annotations declare it: what flattening reads, before any code is compared. */
export type Declared = {
  readonly nodes: readonly StateNode[];
  readonly flows: readonly DeclaredFlow[];
  /** The flows whose `if:` could not be read. */
  readonly unreadGuards: ReadonlySet<DeclaredFlow>;
  readonly deps: readonly DepEdge[];
  readonly model: GraphModel;
};

const NONE: readonly never[] = [];

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** SPEC §5 `@state-parent`: the statechart with every parent replaced by the leaves inside it. */
function flattenModel(graph: Declared): {
  readonly model: FlatModel;
  readonly unreadRivals: readonly UnreadRival[];
} {
  const hierarchy = hierarchyOf(graph.nodes);
  const { flows, unreadGuards } = graph;
  const bySource = new Map<StateName, DeclaredFlow[]>();
  for (const edge of flows) bySource.set(edge.from, [...(bySource.get(edge.from) ?? []), edge]);

  const arcs: FlatArc[] = [];
  const kept = new Map<DeclaredFlow, Set<StateName>>();
  for (const edge of flows) {
    const landing = hierarchy.enter(edge.to);
    for (const from of hierarchy.within(edge.from)) {
      const inherited = guardAt(edge, from, hierarchy, bySource, unreadGuards);
      if (inherited === SHADOWED) continue;
      for (const rival of inherited.past) {
        kept.set(rival, (kept.get(rival) ?? new Set()).add(edge.from));
      }
      const { guard } = inherited;
      for (const to of landing) {
        arcs.push({ from, to, event: edge.event, guard, set: edge.set, declared: edge });
      }
    }
  }
  arcs.sort(
    (a, b) =>
      compareText(a.from, b.from) ||
      compareText(a.to, b.to) ||
      compareText(a.event ?? "", b.event ?? "") ||
      compareText(a.declared.text, b.declared.text) ||
      compareText(a.declared.from, b.declared.from) ||
      compareText(a.declared.to, b.declared.to),
  );

  const groups = new Map<string, StateName[]>();
  for (const node of graph.nodes) {
    if (node.group !== null) groups.set(node.group, [...(groups.get(node.group) ?? []), node.id]);
  }
  const real = new Set(graph.nodes.filter((node) => !node.status.planned).map((node) => node.id));
  const model = mint({
    hierarchy,
    states: hierarchy.leaves,
    real: hierarchy.leaves.filter((leaf) => real.has(leaf)),
    arcs,
    initial: graph.model.initial === null ? NONE : hierarchy.enter(graph.model.initial),
    vars: graph.model.vars,
    events: graph.model.events,
    deps: graph.deps,
    groups,
  });
  const unreadRivals = flows.flatMap((rival): UnreadRival[] => {
    const states = kept.get(rival);
    return states === undefined ? [] : [{ rival, kept: [...states].sort(compareText) }];
  });
  return { model, unreadRivals };
}

/** The only place a `FlatModel` is made. */
function mint(model: Omit<FlatModel, typeof flattened>): FlatModel {
  return model as FlatModel;
}

const SHADOWED = Symbol("shadowed");

/** The guard `edge` gives a leaf's arc, and the rivals with an unread `if:` the arc stayed past. */
type Inherited = { readonly guard: GuardExpr | null; readonly past: readonly DeclaredFlow[] };

/**
 * Inner first, as in UML and Harel. `edge` is declared on an ancestor of `source` (or on `source`).
 * On the levels between them, every transition with the same named event is a rival. An unguarded
 * rival always takes the event, so the inherited arc is dropped; guarded rivals leave it the guard
 * `g && !(r1 || r2 …)`. A rival whose `if:` could not be read is neither: nothing says when it takes
 * the event, so the arc stays. A transition with no event may happen at any time: it neither yields
 * nor shadows.
 */
function guardAt(
  edge: DeclaredFlow,
  source: Leaf,
  hierarchy: Hierarchy,
  bySource: ReadonlyMap<StateName, readonly DeclaredFlow[]>,
  unread: ReadonlySet<DeclaredFlow>,
): Inherited | typeof SHADOWED {
  if (edge.from === source || edge.event === null) return { guard: edge.guard, past: NONE };
  const chain = [source, ...hierarchy.ancestorsOf(source)];
  const rivals = chain
    .slice(0, chain.indexOf(edge.from))
    .flatMap((level) =>
      (bySource.get(level) ?? NONE).filter((other) => other.event === edge.event),
    );
  const guards: GuardExpr[] = [];
  const past: DeclaredFlow[] = [];
  for (const rival of rivals) {
    if (unread.has(rival)) past.push(rival);
    else if (rival.guard === null) return SHADOWED;
    else guards.push(rival.guard);
  }
  const [first, second, ...rest] = guards;
  if (first === undefined) return { guard: edge.guard, past };
  const blocked: GuardExpr =
    second === undefined ? first : { kind: "or", operands: [first, second, ...rest] };
  const negated: GuardExpr = { kind: "not", operand: blocked };
  const guard: GuardExpr =
    edge.guard === null ? negated : { kind: "and", operands: [edge.guard, negated] };
  return { guard, past };
}

/**
 * `P` in a predicate or a target is every leaf inside P; a leaf is itself. Nothing is deduplicated: a
 * name written twice stays twice in Model.tla, as it did before `@state-parent`.
 */
function leavesIn(names: readonly StateName[], hierarchy: Hierarchy): Leaf[] {
  return names.flatMap((name) => hierarchy.within(name));
}

/** `P` in `dep-only-via` is P and every state under it: dependencies are between files. */
function nodesIn(names: readonly StateName[], hierarchy: Hierarchy): StateName[] {
  return names.flatMap((name) => hierarchy.subtree(name));
}

function mapTwo<T, U>(operands: AtLeastTwo<T>, f: (item: T) => U): AtLeastTwo<U> {
  const [a, b, ...rest] = operands;
  return [f(a), f(b), ...rest.map(f)];
}

function lowerExpr(expr: PropExpr, hierarchy: Hierarchy): LeafExpr {
  const lower = (operand: PropExpr) => lowerExpr(operand, hierarchy);
  switch (expr.kind) {
    case "cmp":
      return expr;
    case "state-in":
      return { kind: "state-in", states: leavesIn(expr.states, hierarchy) };
    case "not":
      return { kind: "not", operand: lower(expr.operand) };
    case "and":
      return { kind: "and", operands: mapTwo(expr.operands, lower) };
    case "or":
      return { kind: "or", operands: mapTwo(expr.operands, lower) };
    case "implies":
      return {
        kind: "implies",
        antecedent: lower(expr.antecedent),
        consequent: lower(expr.consequent),
      };
  }
}

function lowerPred(expr: StatePred, hierarchy: Hierarchy): LeafPred {
  const lower = (operand: StatePred) => lowerPred(operand, hierarchy);
  switch (expr.kind) {
    case "state-in":
      return { kind: "state-in", states: leavesIn(expr.states, hierarchy) };
    case "not":
      return { kind: "not", operand: lower(expr.operand) };
    case "and":
      return { kind: "and", operands: mapTwo(expr.operands, lower) };
    case "or":
      return { kind: "or", operands: mapTwo(expr.operands, lower) };
    case "implies":
      return {
        kind: "implies",
        antecedent: lower(expr.antecedent),
        consequent: lower(expr.consequent),
      };
  }
}

function lowerProperty(expr: PropertyExpr, hierarchy: Hierarchy): LeafPropertyExpr {
  return expr.mentionsVars
    ? { mentionsVars: true, expr: lowerExpr(expr.expr, hierarchy) }
    : { mentionsVars: false, expr: lowerPred(expr.expr, hierarchy) };
}

function lowerDef(def: PropertyDef, hierarchy: Hierarchy): FlatPropertyDef {
  const head = { id: def.id, description: def.description };
  switch (def.kind) {
    case "invariant":
      return { ...head, kind: def.kind, expr: lowerProperty(def.expr, hierarchy) };
    case "leads-to":
      return {
        ...head,
        kind: def.kind,
        from: lowerProperty(def.from, hierarchy),
        to: lowerProperty(def.to, hierarchy),
      };
    case "never-reach":
      return {
        ...head,
        kind: def.kind,
        target: leavesIn(def.target, hierarchy),
        avoid: leavesIn(def.avoid, hierarchy),
      };
    case "always-reach":
      return { ...head, kind: def.kind, target: leavesIn(def.target, hierarchy) };
    case "no-dead-end":
      return { ...head, kind: def.kind, except: leavesIn(def.except, hierarchy) };
    case "dep-only-via":
      return {
        ...head,
        kind: def.kind,
        fromGroup: def.fromGroup,
        target: nodesIn(def.target, hierarchy),
        via: nodesIn(def.via, hierarchy),
      };
  }
}

function statesIn(expr: PropExpr): StateName[] {
  switch (expr.kind) {
    case "cmp":
      return [];
    case "state-in":
      return [...expr.states];
    case "not":
      return statesIn(expr.operand);
    case "and":
    case "or":
      return expr.operands.flatMap(statesIn);
    case "implies":
      return [...statesIn(expr.antecedent), ...statesIn(expr.consequent)];
  }
}

/** The names a definition mentions, by the field that mentions them. */
function mentions(def: PropertyDef): readonly (readonly [string, readonly StateName[]])[] {
  switch (def.kind) {
    case "invariant":
      return [["expr", statesIn(def.expr.expr)]];
    case "leads-to":
      return [
        ["from", statesIn(def.from.expr)],
        ["to", statesIn(def.to.expr)],
      ];
    case "never-reach":
      return [
        ["target", def.target],
        ["avoid", def.avoid],
      ];
    case "always-reach":
      return [["target", def.target]];
    case "no-dead-end":
      return [["except", def.except]];
    case "dep-only-via":
      return [
        ["target", def.target],
        ["via", def.via],
      ];
  }
}

/**
 * Flattens the statechart and lowers the properties file onto it in one step, so no lane can lower
 * differently. A name no state has is a typo more often than a choice: it is reported and judged as
 * an empty set, as before.
 */
export function flatten(graph: Declared, file: PropertiesFile): Flat {
  const { model, unreadRivals } = flattenModel(graph);
  const { hierarchy } = model;
  const unknown: UnknownName[] = [];
  for (const name of new Set(file.entry ?? NONE)) {
    if (!hierarchy.has(name)) unknown.push({ in: "entry", name });
  }
  for (const def of file.properties) {
    const reported = new Set<StateName>();
    for (const [field, names] of mentions(def)) {
      for (const name of names) {
        if (hierarchy.has(name) || reported.has(name)) continue;
        reported.add(name);
        unknown.push({ in: { property: def.id, field }, name });
      }
    }
  }
  const start = file.entry ?? (graph.model.initial === null ? NONE : [graph.model.initial]);
  const entered = [...graph.flows.map((edge) => edge.to), ...start];
  return {
    model,
    entry: entryOf(model, file),
    properties: file.properties.map((def) => lowerDef(def, hierarchy)),
    unknown,
    ambiguous: [...new Set(entered.flatMap((name) => hierarchy.ambiguousEntries(name)))].sort(
      compareText,
    ),
    unreadRivals,
  };
}

function entryOf(model: FlatModel, file: PropertiesFile): readonly Leaf[] {
  const { hierarchy } = model;
  if (file.entry !== null) return file.entry.flatMap((name) => hierarchy.enter(name));
  if (model.initial.length > 0) return model.initial;
  const entered = new Set(model.arcs.filter((arc) => arc.from !== arc.to).map((arc) => arc.to));
  return model.real.filter((leaf) => !entered.has(leaf));
}
