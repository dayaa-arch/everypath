import { parseProperty, parseStateName } from "./expr.js";
import { asItems, isRecord } from "./json.js";
import type { Problem } from "./model.js";
import type {
  Counterexample,
  EventName,
  FlowEdge,
  Graph,
  NonEmpty,
  PropExpr,
  PropertiesFile,
  PropertyDef,
  PropertyExpr,
  PropertyId,
  PropertyResult,
  ScanWarning,
  StateName,
  StatePred,
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
  "dep-only-via": () => ok({ kind: "dep-only-via" }),
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

/** The flow edges of the graph, indexed once per check. Dep edges play no part. */
type Flow = {
  /** Every node, planned ones included. */
  readonly states: ReadonlySet<StateName>;
  /** The nodes with code behind them, in id order. */
  readonly real: readonly StateName[];
  /** In `graph.edges` order, so a search takes the same path on every run. */
  readonly outgoing: ReadonlyMap<StateName, readonly FlowEdge[]>;
  readonly incoming: ReadonlyMap<StateName, readonly StateName[]>;
};

const NONE: readonly never[] = [];
const NO_STATES: ReadonlySet<StateName> = new Set();

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function flowOf({ nodes, edges }: Pick<Graph, "nodes" | "edges">): Flow {
  const outgoing = new Map<StateName, FlowEdge[]>();
  const incoming = new Map<StateName, StateName[]>();
  for (const edge of edges) {
    if (edge.type !== "flow") continue;
    append(outgoing, edge.from, edge);
    append(incoming, edge.to, edge.from);
  }
  return {
    states: new Set(nodes.map((node) => node.id)),
    real: nodes.filter((node) => !node.status.planned).map((node) => node.id),
    outgoing,
    incoming,
  };
}

function isDeadEnd(flow: Flow, state: StateName): boolean {
  return (flow.outgoing.get(state) ?? NONE).length === 0;
}

/**
 * `entry`, else the model's initial state, else the states nothing else leads to. The TLA+ lane
 * starts from the same states, so it asks here.
 */
export function entryOf(
  graph: Pick<Graph, "nodes" | "edges" | "model">,
  { entry }: PropertiesFile,
  flow: Flow = flowOf(graph),
): readonly StateName[] {
  if (entry !== null) return entry.filter((state) => flow.states.has(state));
  if (graph.model.initial !== null) return [graph.model.initial];
  return flow.real.filter(
    (state) => !(flow.incoming.get(state) ?? NONE).some((from) => from !== state),
  );
}

/** How a state was first reached. `null` for a start. */
type Arrival = { readonly from: StateName; readonly event: EventName | null } | null;
type Reached = ReadonlyMap<StateName, Arrival>;

/**
 * Breadth first from all `starts` at once, so the first state that satisfies `isGoal` is a shortest
 * path away from the nearest start, and the order of `starts` and of the edges breaks ties.
 */
function search(
  starts: readonly StateName[],
  outgoing: Flow["outgoing"],
  isGoal: (state: StateName) => boolean,
  blocked: ReadonlySet<StateName> = NO_STATES,
): { readonly goal: StateName | null; readonly reached: Reached } {
  const reached = new Map<StateName, Arrival>();
  const queue: StateName[] = [];
  const enter = (state: StateName, arrival: Arrival): void => {
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

function stepAt(state: StateName, reached: Reached): Step {
  return { state, event: reached.get(state)?.event ?? null, vars: {} };
}

function counterexampleOf(steps: NonEmpty<Step>): Counterexample {
  const [first, ...rest] = steps;
  return { path: [first.state, ...rest.map((step) => step.state)], steps, loopStart: null };
}

/** The path from the start that reached `goal`, ending at `goal`. */
function pathTo(goal: StateName, reached: Reached): Counterexample {
  const steps: [Step, ...Step[]] = [stepAt(goal, reached)];
  for (let arrival = reached.get(goal); arrival; arrival = reached.get(arrival.from)) {
    steps.unshift(stepAt(arrival.from, reached));
  }
  return counterexampleOf(steps);
}

function holds(expr: StatePred, state: StateName): boolean {
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

type Context = { readonly flow: Flow; readonly entry: readonly StateName[] };

function pending(checkedBy: Verdict["checkedBy"]): Verdict {
  return { checkedBy, result: "pending", counterexamples: [], statesExplored: null };
}

function settled(counterexamples: readonly Counterexample[], statesExplored: number): Verdict {
  const result = counterexamples.length > 0 ? "violated" : "ok";
  return { checkedBy: "bfs", result, counterexamples, statesExplored };
}

/** One counterexample at most: the shortest path to the first goal state, if there is one. */
function settledBySearch({ goal, reached }: ReturnType<typeof search>): Verdict {
  return settled(goal === null ? [] : [pathTo(goal, reached)], reached.size);
}

/** Whether the judgment searches outward from the entry states. */
function needsEntry(def: PropertyDef): boolean {
  return def.kind === "never-reach" || (def.kind === "invariant" && !def.expr.mentionsVars);
}

function invariant(expr: StatePred, { flow, entry }: Context): Verdict {
  return settledBySearch(search(entry, flow.outgoing, (state) => !holds(expr, state)));
}

function neverReach(
  target: NonEmpty<StateName>,
  avoid: readonly StateName[],
  { flow, entry }: Context,
): Verdict {
  return settledBySearch(
    search(entry, flow.outgoing, (state) => target.includes(state), new Set(avoid)),
  );
}

/** Every state that has a path to one of `targets`, found by walking the edges backwards. */
function reaching(
  targets: readonly StateName[],
  incoming: Flow["incoming"],
): ReadonlySet<StateName> {
  const seen = new Set(targets);
  // A set iterator also visits what is added while it runs.
  for (const state of seen) {
    for (const from of incoming.get(state) ?? NONE) seen.add(from);
  }
  return seen;
}

/** One counterexample per stuck state: its way to the nearest dead end, or the state alone. */
function alwaysReach(target: NonEmpty<StateName>, { flow }: Context): Verdict {
  const canReach = reaching(target, flow.incoming);
  const counterexamples = flow.real
    .filter((state) => !canReach.has(state))
    .map((state) => {
      const { goal, reached } = search([state], flow.outgoing, (next) => isDeadEnd(flow, next));
      return pathTo(goal ?? state, reached);
    });
  return settled(counterexamples, flow.real.length);
}

function noDeadEnd(except: readonly StateName[], { flow }: Context): Verdict {
  const counterexamples = flow.real
    .filter((state) => !except.includes(state) && isDeadEnd(flow, state))
    .map((state) => counterexampleOf([{ state, event: null, vars: {} }]));
  return settled(counterexamples, flow.real.length);
}

/** One function per `kind`; the switch is exhaustive, so a new kind fails to compile until it is judged. */
function judge(def: PropertyDef, context: Context): Verdict {
  switch (def.kind) {
    case "invariant":
      return def.expr.mentionsVars ? pending("tlc") : invariant(def.expr.expr, context);
    case "leads-to":
      return pending("tlc");
    case "never-reach":
      return neverReach(def.target, def.avoid, context);
    case "always-reach":
      return alwaysReach(def.target, context);
    case "no-dead-end":
      return noDeadEnd(def.except, context);
    case "dep-only-via":
      return pending("bfs");
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

/** The states a definition names, by the field that names them. */
function references(def: PropertyDef): readonly (readonly [string, readonly StateName[]])[] {
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
      return [];
  }
}

/** A name that is no node is a typo more often than a deliberate choice, but the property is still judged. */
function unknownStateWarnings(def: PropertyDef, flow: Flow): ScanWarning[] {
  const reported = new Set<StateName>();
  const warnings: ScanWarning[] = [];
  for (const [field, names] of references(def)) {
    for (const name of names) {
      if (flow.states.has(name) || reported.has(name)) continue;
      reported.add(name);
      warnings.push(warn(`性質 ${def.id} の ${field} にある ${name} は、どの状態にもありません`));
    }
  }
  return warnings;
}

function entryWarnings(
  { entry, properties }: PropertiesFile,
  resolved: readonly StateName[],
  flow: Flow,
): ScanWarning[] {
  const unknown = new Set((entry ?? NONE).filter((name) => !flow.states.has(name)));
  const warnings = [...unknown].map((name) =>
    warn(`${PROPERTIES_FILE} の entry にある ${name} は、どの状態にもありません。入口に使いません`),
  );
  const needing = properties.filter(needsEntry);
  if (resolved.length === 0 && needing.length > 0) {
    const ids = needing.map((def) => def.id).join("、");
    warnings.push(
      warn(
        `入口にする状態がありません（entry も @state-initial も入エッジの無い状態も無い）。${ids} は何も探索せずに判定しました`,
      ),
    );
  }
  return warnings;
}

/** The properties whose counterexample passes through each state, in file order. */
export function violationsOf(results: readonly PropertyResult[]): Map<StateName, PropertyId[]> {
  const violations = new Map<StateName, PropertyId[]>();
  for (const { id, counterexamples } of results) {
    for (const state of new Set(counterexamples.flatMap((example) => example.path))) {
      append(violations, state, id);
    }
  }
  return violations;
}

/**
 * The quick lane of SPEC §9: every property is judged on the flow edges alone, guards taken as always
 * true. `graph.nodes` is in id order, as `scan` builds it. A property that needs a variable or a
 * time-ordered argument stays `pending` for TLC.
 */
export function checkProperties(
  graph: Pick<Graph, "nodes" | "edges" | "model">,
  file: PropertiesFile,
  checkedAt: string,
): {
  properties: PropertyResult[];
  violations: ReadonlyMap<StateName, readonly PropertyId[]>;
  warnings: ScanWarning[];
} {
  const flow = flowOf(graph);
  const entry = entryOf(graph, file, flow);
  const properties = file.properties.map(
    (def): PropertyResult => ({
      id: def.id,
      kind: def.kind,
      description: def.description,
      ...judge(def, { flow, entry }),
      checkedAt,
    }),
  );
  return {
    properties,
    violations: violationsOf(properties),
    warnings: [
      ...entryWarnings(file, entry, flow),
      ...file.properties.flatMap((def) => unknownStateWarnings(def, flow)),
    ],
  };
}
