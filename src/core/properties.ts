import { parseProperty, parseStateName } from "./expr.js";
import type { Flat, FlatModel, FlatPropertyDef, LeafPred, UnknownName } from "./flatten.js";
import { asItems, isRecord } from "./json.js";
import type { Problem } from "./model.js";
import type {
  Counterexample,
  EventName,
  Leaf,
  NonEmpty,
  PropertiesFile,
  PropertyDef,
  PropertyExpr,
  PropertyId,
  PropertyResult,
  ScanWarning,
  StateName,
  Step,
} from "./types.js";

export const PROPERTIES_FILE = "everypath.properties.json";

export const NO_PROPERTIES: PropertiesFile = { entry: null, properties: [] };

type Kind = PropertyDef["kind"];
/** A definition without the fields every kind shares. */
type BodyOf<K extends Kind> =
  Extract<PropertyDef, { readonly kind: K }> extends infer D
    ? D extends unknown
      ? Omit<D, "id" | "description">
      : never
    : never;

type Failure = { readonly ok: false; readonly problem: Problem };
type Parsed<T> = { readonly ok: true; readonly value: T } | Failure;

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function fail(message: string, detail: Problem["detail"] = null): Failure {
  return { ok: false, problem: { message, detail } };
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

function stateNames(raw: unknown, field: string): Parsed<readonly StateName[]> {
  if (!Array.isArray(raw)) return fail(`${field} は状態名の配列にしてください`);
  const names: StateName[] = [];
  for (const item of asItems(raw)) {
    const name = typeof item === "string" ? parseStateName(item) : null;
    if (name === null || !name.ok)
      return fail(`${field} に状態名でない値があります: ${show(item)}`);
    names.push(name.value);
  }
  return ok(names);
}

function nonEmptyStateNames(raw: unknown, field: string): Parsed<NonEmpty<StateName>> {
  const names = stateNames(raw, field);
  if (!names.ok) return names;
  const [first, ...rest] = names.value;
  return first === undefined
    ? fail(`${field} には状態名を 1 つ以上書いてください`)
    : ok([first, ...rest]);
}

function optionalStateNames(raw: unknown, field: string): Parsed<readonly StateName[]> {
  return raw == null ? ok([]) : stateNames(raw, field);
}

/** Compared with `@state-group` as the scanner keeps it: trimmed, nothing else. */
function groupName(raw: unknown, field: string): Parsed<string> {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text === "" ? fail(`${field} は空でないグループ名の文字列にしてください`) : ok(text);
}

function expression(raw: unknown, field: string): Parsed<PropertyExpr> {
  if (typeof raw !== "string") return fail(`${field} は式の文字列にしてください`);
  const parsed = parseProperty(raw);
  if (parsed.ok) return ok(parsed.value);
  return fail(`${field} を解釈できません: ${parsed.warning.message}`, parsed.warning);
}

type Fields = Readonly<Record<string, unknown>>;
type BodyParsers = { readonly [K in Kind]: (raw: Fields) => Parsed<BodyOf<K>> };

/** One parser per `kind`. The table is the list of kinds the file may use. */
const BODY_PARSERS = {
  invariant: (raw) => {
    const expr = expression(raw.expr, "expr");
    return expr.ok ? ok({ kind: "invariant", expr: expr.value }) : expr;
  },
  "leads-to": (raw) => {
    const from = expression(raw.from, "from");
    if (!from.ok) return from;
    const to = expression(raw.to, "to");
    return to.ok ? ok({ kind: "leads-to", from: from.value, to: to.value }) : to;
  },
  "never-reach": (raw) => {
    const target = nonEmptyStateNames(raw.target, "target");
    if (!target.ok) return target;
    const avoid = optionalStateNames(raw.avoid, "avoid");
    return avoid.ok ? ok({ kind: "never-reach", target: target.value, avoid: avoid.value }) : avoid;
  },
  "always-reach": (raw) => {
    const target = nonEmptyStateNames(raw.target, "target");
    return target.ok ? ok({ kind: "always-reach", target: target.value }) : target;
  },
  "no-dead-end": (raw) => {
    const except = optionalStateNames(raw.except, "except");
    return except.ok ? ok({ kind: "no-dead-end", except: except.value }) : except;
  },
  "dep-only-via": (raw) => {
    const fromGroup = groupName(raw.from_group, "from_group");
    if (!fromGroup.ok) return fromGroup;
    const target = nonEmptyStateNames(raw.target, "target");
    if (!target.ok) return target;
    const via = nonEmptyStateNames(raw.via, "via");
    if (!via.ok) return via;
    return ok({
      kind: "dep-only-via",
      fromGroup: fromGroup.value,
      target: target.value,
      via: via.value,
    });
  },
} satisfies BodyParsers;

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && Object.hasOwn(BODY_PARSERS, value);
}

/** The only place a `PropertyId` is made. */
function propertyId(raw: unknown): PropertyId | null {
  return typeof raw === "string" && raw.trim() !== "" ? (raw as PropertyId) : null;
}

function parseDefinition(
  raw: unknown,
  id: PropertyId | null,
  taken: ReadonlySet<PropertyId>,
): Parsed<PropertyDef> {
  if (!isRecord(raw)) return fail("定義が JSON オブジェクトではありません");
  if (id === null) return fail("id がありません。空でない文字列を書いてください");
  if (taken.has(id)) return fail("id が先の定義と重複しています");
  if (raw.kind === undefined) return fail("kind がありません");
  if (!isKind(raw.kind)) {
    const kinds = Object.keys(BODY_PARSERS).join("、");
    return fail(`kind ${show(raw.kind)} は未知です（${kinds} のどれか）`);
  }
  if (raw.description != null && typeof raw.description !== "string") {
    return fail("description は文字列にしてください");
  }
  const body = BODY_PARSERS[raw.kind](raw);
  if (!body.ok) return body;
  return ok({ id, description: raw.description ?? null, ...body.value });
}

function warn(message: string, detail: ScanWarning["detail"] = null): ScanWarning {
  return { file: PROPERTIES_FILE, line: null, message, detail };
}

/**
 * The properties file is a boundary. A definition outside the grammar is dropped with one warning that
 * names its first problem, so a property that cannot be checked never passes silently.
 */
export function parseProperties(raw: unknown): {
  file: PropertiesFile;
  warnings: ScanWarning[];
} {
  const unusable = (reason: string) => ({
    file: NO_PROPERTIES,
    warnings: [warn(`${PROPERTIES_FILE} ${reason}。性質を読み込みません`)],
  });
  if (!isRecord(raw)) return unusable("は JSON オブジェクトにしてください");
  if (!Array.isArray(raw.properties)) return unusable("に properties 配列がありません");

  const warnings: ScanWarning[] = [];
  let entry: NonEmpty<StateName> | null = null;
  if (raw.entry != null) {
    const parsed = nonEmptyStateNames(raw.entry, "entry");
    if (parsed.ok) entry = parsed.value;
    else {
      warnings.push(warn(`${PROPERTIES_FILE} の ${parsed.problem.message}。入口は自動で決めます`));
    }
  }

  const properties: PropertyDef[] = [];
  const taken = new Set<PropertyId>();
  for (const [index, definition] of asItems(raw.properties).entries()) {
    const id = isRecord(definition) ? propertyId(definition.id) : null;
    const parsed = parseDefinition(definition, id, taken);
    if (parsed.ok) {
      taken.add(parsed.value.id);
      properties.push(parsed.value);
      continue;
    }
    const subject = id === null ? `${index + 1} 番目の性質の` : `性質 ${id} の`;
    warnings.push(
      warn(`${subject}${parsed.problem.message}。この性質は読み込みません`, parsed.problem.detail),
    );
  }
  return { file: { entry, properties }, warnings };
}

/** One way out of a state. A dep edge has no event. */
type Arc<S extends StateName> = { readonly to: S; readonly event: EventName | null };
/** By source state, in `graph.edges` order, so a search takes the same path on every run. */
type Arcs<S extends StateName> = ReadonlyMap<S, readonly Arc<S>[]>;

/** The arcs of the flat model, indexed once per check. Dep edges play no part. */
type Flow = {
  /** Every leaf, planned ones included. */
  readonly states: ReadonlySet<Leaf>;
  /** The leaves with code behind them, in id order. */
  readonly real: readonly Leaf[];
  readonly outgoing: Arcs<Leaf>;
  readonly incoming: ReadonlyMap<Leaf, readonly Leaf[]>;
};

/** The dep edges and the groups, which only `dep-only-via` reads. They are between declared nodes. */
type Deps = {
  readonly outgoing: Arcs<StateName>;
  /** The states of each `@state-group`, in id order. */
  readonly groups: ReadonlyMap<string, readonly StateName[]>;
};

const NONE: readonly never[] = [];
const NO_STATES: ReadonlySet<never> = new Set();

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function depsOf({ deps, groups }: FlatModel): Deps {
  const outgoing = new Map<StateName, Arc<StateName>[]>();
  for (const edge of deps) append(outgoing, edge.from, { to: edge.to, event: null });
  return { outgoing, groups };
}

function flowOf({ states, real, arcs }: FlatModel): Flow {
  const outgoing = new Map<Leaf, Arc<Leaf>[]>();
  const incoming = new Map<Leaf, Leaf[]>();
  for (const arc of arcs) {
    append(outgoing, arc.from, { to: arc.to, event: arc.event });
    append(incoming, arc.to, arc.from);
  }
  return { states: new Set(states), real, outgoing, incoming };
}

function isDeadEnd(flow: Flow, state: Leaf): boolean {
  return (flow.outgoing.get(state) ?? NONE).length === 0;
}

/** How a state was first reached. `null` for a start. */
type Arrival<S extends StateName> = { readonly from: S; readonly event: EventName | null } | null;
type Reached<S extends StateName> = ReadonlyMap<S, Arrival<S>>;

/**
 * Breadth first from all `starts` at once, so the first state that satisfies `isGoal` is a shortest
 * path away from the nearest start, and the order of `starts` and of the edges breaks ties.
 */
function search<S extends StateName>(
  starts: readonly S[],
  outgoing: Arcs<S>,
  isGoal: (state: S) => boolean,
  blocked: ReadonlySet<S> = NO_STATES,
): { readonly goal: S | null; readonly reached: Reached<S> } {
  const reached = new Map<S, Arrival<S>>();
  const queue: S[] = [];
  const enter = (state: S, arrival: Arrival<S>): void => {
    if (blocked.has(state) || reached.has(state)) return;
    reached.set(state, arrival);
    queue.push(state);
  };
  for (const start of starts) enter(start, null);
  // An array iterator also visits what is pushed while it runs, which makes `queue` a FIFO.
  for (const state of queue) {
    if (isGoal(state)) return { goal: state, reached };
    for (const edge of outgoing.get(state) ?? NONE) {
      enter(edge.to, { from: state, event: edge.event });
    }
  }
  return { goal: null, reached };
}

function stepAt<S extends StateName>(state: S, reached: Reached<S>): Step {
  return { state, event: reached.get(state)?.event ?? null, vars: {} };
}

function counterexampleOf(steps: NonEmpty<Step>): Counterexample {
  const [first, ...rest] = steps;
  return { path: [first.state, ...rest.map((step) => step.state)], steps, loopStart: null };
}

/** The path from the start that reached `goal`, ending at `goal`. */
function pathTo<S extends StateName>(goal: S, reached: Reached<S>): Counterexample {
  const steps: [Step, ...Step[]] = [stepAt(goal, reached)];
  for (let arrival = reached.get(goal); arrival; arrival = reached.get(arrival.from)) {
    steps.unshift(stepAt(arrival.from, reached));
  }
  return counterexampleOf(steps);
}

function holds(expr: LeafPred, state: Leaf): boolean {
  switch (expr.kind) {
    case "state-in":
      return expr.states.includes(state);
    case "not":
      return !holds(expr.operand, state);
    case "and":
      return expr.operands.every((operand) => holds(operand, state));
    case "or":
      return expr.operands.some((operand) => holds(operand, state));
    case "implies":
      return !holds(expr.antecedent, state) || holds(expr.consequent, state);
  }
}

/** What a check says about one property. */
type Verdict = Pick<PropertyResult, "checkedBy" | "result" | "counterexamples" | "statesExplored">;

type Context = {
  readonly flow: Flow;
  readonly entry: readonly Leaf[];
  readonly deps: Deps;
};

/** Only TLC can judge a property that reads a variable or speaks of time. */
const AWAITS_TLC: Verdict = {
  checkedBy: "tlc",
  result: "pending",
  counterexamples: [],
  statesExplored: null,
};

function settled(counterexamples: readonly Counterexample[], statesExplored: number): Verdict {
  const result = counterexamples.length > 0 ? "violated" : "ok";
  return { checkedBy: "bfs", result, counterexamples, statesExplored };
}

/** One counterexample at most: the shortest path to the first goal state, if there is one. */
function settledBySearch({ goal, reached }: ReturnType<typeof search>): Verdict {
  return settled(goal === null ? [] : [pathTo(goal, reached)], reached.size);
}

/** Whether the judgment searches outward from the entry states. */
function needsEntry(def: FlatPropertyDef): boolean {
  return def.kind === "never-reach" || (def.kind === "invariant" && !def.expr.mentionsVars);
}

function invariant(expr: LeafPred, { flow, entry }: Context): Verdict {
  return settledBySearch(search(entry, flow.outgoing, (state) => !holds(expr, state)));
}

function neverReach(
  target: readonly Leaf[],
  avoid: readonly Leaf[],
  { flow, entry }: Context,
): Verdict {
  return settledBySearch(
    search(entry, flow.outgoing, (state) => target.includes(state), new Set(avoid)),
  );
}

type DepOnlyVia = Extract<FlatPropertyDef, { readonly kind: "dep-only-via" }>;

/**
 * never-reach's search on the dep edges: from every state of the group at once, with the via states
 * taken out. A state of the group that is itself a target is a path of that state alone.
 */
function depOnlyVia({ fromGroup, target, via }: DepOnlyVia, { deps }: Context): Verdict {
  const starts = deps.groups.get(fromGroup) ?? NONE;
  return settledBySearch(
    search(starts, deps.outgoing, (state) => target.includes(state), new Set(via)),
  );
}

/** Every state that has a path to one of `targets`, found by walking the edges backwards. */
function reaching(targets: readonly Leaf[], incoming: Flow["incoming"]): ReadonlySet<Leaf> {
  const seen = new Set(targets);
  // A set iterator also visits what is added while it runs.
  for (const state of seen) {
    for (const from of incoming.get(state) ?? NONE) seen.add(from);
  }
  return seen;
}

/** One counterexample per stuck state: its way to the nearest dead end, or the state alone. */
function alwaysReach(target: readonly Leaf[], { flow }: Context): Verdict {
  const canReach = reaching(target, flow.incoming);
  const counterexamples = flow.real
    .filter((state) => !canReach.has(state))
    .map((state) => {
      const { goal, reached } = search([state], flow.outgoing, (next) => isDeadEnd(flow, next));
      return pathTo(goal ?? state, reached);
    });
  return settled(counterexamples, flow.real.length);
}

function noDeadEnd(except: readonly Leaf[], { flow }: Context): Verdict {
  const counterexamples = flow.real
    .filter((state) => !except.includes(state) && isDeadEnd(flow, state))
    .map((state) => counterexampleOf([{ state, event: null, vars: {} }]));
  return settled(counterexamples, flow.real.length);
}

/** One function per `kind`; the switch is exhaustive, so a new kind fails to compile until it is judged. */
function judge(def: FlatPropertyDef, context: Context): Verdict {
  switch (def.kind) {
    case "invariant":
      return def.expr.mentionsVars ? AWAITS_TLC : invariant(def.expr.expr, context);
    case "leads-to":
      return AWAITS_TLC;
    case "never-reach":
      return neverReach(def.target, def.avoid, context);
    case "always-reach":
      return alwaysReach(def.target, context);
    case "no-dead-end":
      return noDeadEnd(def.except, context);
    case "dep-only-via":
      return depOnlyVia(def, context);
  }
}

/** A name that is no state is a typo more often than a deliberate choice, but the property is still judged. */
function unknownNameWarning({ in: where, name }: UnknownName): ScanWarning {
  return warn(
    where === "entry"
      ? `${PROPERTIES_FILE} の entry にある ${name} は、どの状態にもありません。入口に使いません`
      : `性質 ${where.property} の ${where.field} にある ${name} は、どの状態にもありません`,
  );
}

function unknownGroupWarnings(def: FlatPropertyDef, deps: Deps): ScanWarning[] {
  if (def.kind !== "dep-only-via" || deps.groups.has(def.fromGroup)) return [];
  return [
    warn(
      `性質 ${def.id} の from_group にある ${def.fromGroup} は、どの状態のグループにもありません`,
    ),
  ];
}

function entryWarnings(
  properties: readonly FlatPropertyDef[],
  entry: readonly Leaf[],
): ScanWarning[] {
  const needing = properties.filter(needsEntry);
  if (entry.length > 0 || needing.length === 0) return [];
  const ids = needing.map((def) => def.id).join("、");
  return [
    warn(
      `入口にする状態がありません（entry も @state-initial も入エッジの無い状態も無い）。${ids} は何も探索せずに判定しました`,
    ),
  ];
}

/**
 * The properties whose counterexample passes through each state, in file order. A `staleModel` one is
 * left out: its trace runs through a model that is gone, so it would mark a bug that may not exist.
 */
export function violationsOf(results: readonly PropertyResult[]): Map<StateName, PropertyId[]> {
  const violations = new Map<StateName, PropertyId[]>();
  for (const { id, counterexamples, staleModel } of results) {
    if (staleModel) continue;
    for (const state of new Set(counterexamples.flatMap((example) => example.path))) {
      append(violations, state, id);
    }
  }
  return violations;
}

/**
 * The quick lane of SPEC §9: every property is judged on the arcs of the flat model alone, guards
 * taken as always true, except `dep-only-via`, which is judged on the dep edges alone. A property that
 * needs a variable or a time-ordered argument stays `pending` for TLC.
 */
export function checkProperties(
  flat: Flat,
  checkedAt: string,
): {
  properties: PropertyResult[];
  violations: ReadonlyMap<StateName, readonly PropertyId[]>;
  warnings: ScanWarning[];
} {
  const flow = flowOf(flat.model);
  const deps = depsOf(flat.model);
  const properties = flat.properties.map(
    (def): PropertyResult => ({
      id: def.id,
      kind: def.kind,
      description: def.description,
      ...judge(def, { flow, entry: flat.entry, deps }),
      checkedAt,
    }),
  );
  return {
    properties,
    violations: violationsOf(properties),
    warnings: [
      ...flat.unknown.filter(({ in: where }) => where === "entry").map(unknownNameWarning),
      ...entryWarnings(flat.properties, flat.entry),
      ...flat.properties.flatMap((def) => [
        ...unknownGroupWarnings(def, deps),
        ...flat.unknown
          .filter(({ in: where }) => where !== "entry" && where.property === def.id)
          .map(unknownNameWarning),
      ]),
    ],
  };
}
