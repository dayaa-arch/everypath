import { checkComparison, type VarTable } from "../model.js";
import { entryOf } from "../properties.js";
import type {
  Assignment,
  EventName,
  FlowEdge,
  Graph,
  MemberName,
  ModelVar,
  PropExpr,
  PropertiesFile,
  PropertyDef,
  PropertyId,
  StateName,
  Value,
  VarName,
} from "../types.js";

/** The name of the range check. Property checks are `P`, a digit and a name, so none can be it. */
export const TYPE_OK = "TypeOK";

/** ASCII identifier to display name. TLC prints only the keys; `result.json` stores the whole table. */
export type TlaNames = {
  readonly states: Readonly<Record<string, StateName>>;
  readonly vars: Readonly<Record<string, VarName>>;
  /** `"tau"` is `null`: a transition with no event, and what `lastEvent` starts as. */
  readonly events: Readonly<Record<string, EventName | null>>;
  readonly members: Readonly<Record<string, MemberName>>;
  readonly checks: Readonly<Record<string, PropertyId | typeof TYPE_OK>>;
};

export type TlaModel = {
  readonly tla: string;
  /**
   * Model.cfg for one TLC run over `checks`, names from `invariants` and `temporal`, invariants first.
   * Without `TypeOK` among them the cfg adds `CONSTRAINT TypeOK`: an unguarded `set:` that leaves its
   * range would otherwise make the state space infinite once TypeOK is no longer an invariant.
   */
  readonly cfg: (checks: readonly string[]) => string;
  readonly names: TlaNames;
  /** Every `invariant` in file order, then `TypeOK`. */
  readonly invariants: readonly string[];
  readonly temporal: readonly string[];
  /** Definitions left out of the model, with the reason. They fail the check without stopping the rest. */
  readonly rejected: readonly { readonly id: PropertyId; readonly reason: string }[];
};

/** The kinds TLC checks. The rest stay with the BFS lane. */
type TlcDef = Extract<PropertyDef, { readonly kind: "invariant" | "leads-to" }>;

function isTlcDef(def: PropertyDef): def is TlcDef {
  return def.kind === "invariant" || def.kind === "leads-to";
}

type Prefix = "S" | "v" | "e" | "m" | "P";

/**
 * A prefix, the 1-based position, and for an ASCII display name `_` plus the name. The position makes
 * every identifier unique and no TLA+ keyword has a digit after one letter, so there is no reserved
 * word list and no collision handling.
 */
function identifier(prefix: Prefix, position: number, display: string): string {
  const suffix = /^[\x20-\x7e]+$/.test(display) ? `_${display.replace(/[^A-Za-z0-9_]/g, "_")}` : "";
  return `${prefix}${position}${suffix}`;
}

/** Both directions of one category, built from one list so they cannot disagree. */
type Table<T extends string> = {
  readonly id: ReadonlyMap<T, string>;
  readonly back: Readonly<Record<string, T>>;
};

function tableOf<T extends string>(prefix: Prefix, displays: readonly T[]): Table<T> {
  const id = new Map<T, string>();
  const back: Record<string, T> = {};
  for (const [index, display] of displays.entries()) {
    const name = identifier(prefix, index + 1, display);
    id.set(display, name);
    back[name] = display;
  }
  return { id, back };
}

type Naming = {
  readonly states: Table<StateName>;
  readonly vars: Table<VarName>;
  readonly events: Table<EventName>;
  readonly members: Table<MemberName>;
  readonly checks: Table<PropertyId>;
};

/** The only place names are minted. */
function allocate(graph: Pick<Graph, "nodes" | "model">, checked: readonly PropertyId[]): Naming {
  const members = graph.model.vars.flatMap((decl) => (decl.kind === "enum" ? decl.members : []));
  return {
    states: tableOf(
      "S",
      graph.nodes.map((node) => node.id),
    ),
    vars: tableOf(
      "v",
      graph.model.vars.map((decl) => decl.name),
    ),
    events: tableOf("e", graph.model.events),
    members: tableOf("m", [...new Set(members)]),
    checks: tableOf("P", checked),
  };
}

function nameOf<T extends string>({ id }: Table<T>, display: T): string {
  const name = id.get(display);
  if (name === undefined) throw new Error(`TLA+ の名前表にありません: ${display}`);
  return name;
}

const quoted = (name: string): string => `"${name}"`;

const OPERATORS = {
  "==": "=",
  "!=": "#",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
} as const satisfies Record<Extract<PropExpr, { readonly kind: "cmp" }>["op"], string>;

function literal(value: Value, naming: Naming): string {
  switch (value.kind) {
    case "bool":
      return value.value ? "TRUE" : "FALSE";
    case "int":
      return String(value.value);
    case "member":
      return quoted(nameOf(naming.members, value.name));
  }
}

function problemIn(expr: PropExpr, vars: VarTable): string | null {
  switch (expr.kind) {
    case "cmp":
      return checkComparison(expr, vars);
    case "state-in":
      return null;
    case "not":
      return problemIn(expr.operand, vars);
    case "and":
    case "or":
      return firstOf(expr.operands, vars);
    case "implies":
      return firstOf([expr.antecedent, expr.consequent], vars);
  }
}

function firstOf(exprs: readonly PropExpr[], vars: VarTable): string | null {
  for (const expr of exprs) {
    const problem = problemIn(expr, vars);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * Guards and property expressions share this one switch: `GuardExpr` is assignable to `PropExpr`.
 * Every compound is parenthesized and atoms are bare, so TLA+ precedence never matters. A state that
 * is no node is dropped from its set. Callers pass only expressions whose variables are declared.
 */
function formula(expr: PropExpr, naming: Naming): string {
  switch (expr.kind) {
    case "cmp":
      return `${nameOf(naming.vars, expr.name)} ${OPERATORS[expr.op]} ${literal(expr.value, naming)}`;
    case "state-in": {
      const known = expr.states.filter((state) => naming.states.id.has(state));
      return `state \\in {${known.map((state) => quoted(nameOf(naming.states, state))).join(", ")}}`;
    }
    case "not": {
      const inner = formula(expr.operand, naming);
      const wrapped =
        expr.operand.kind === "and" ||
        expr.operand.kind === "or" ||
        expr.operand.kind === "implies";
      return `~${wrapped ? inner : `(${inner})`}`;
    }
    case "and":
      return `(${expr.operands.map((operand) => formula(operand, naming)).join(" /\\ ")})`;
    case "or":
      return `(${expr.operands.map((operand) => formula(operand, naming)).join(" \\/ ")})`;
    case "implies":
      return `(${formula(expr.antecedent, naming)} => ${formula(expr.consequent, naming)})`;
  }
}

function assignedValue(value: Assignment["value"], naming: Naming): string {
  if (value.kind !== "offset") return literal(value, naming);
  return `${nameOf(naming.vars, value.of)} ${value.delta === 1 ? "+" : "-"} 1`;
}

function domainOf(decl: ModelVar, naming: Naming): string {
  switch (decl.kind) {
    case "boolean":
      return "BOOLEAN";
    case "range":
      return `${decl.min}..${decl.max}`;
    case "enum":
      return `{${decl.members.map((member) => quoted(nameOf(naming.members, member))).join(", ")}}`;
  }
}

function initialOf(decl: ModelVar, naming: Naming): string {
  switch (decl.kind) {
    case "boolean":
      return decl.init ? "TRUE" : "FALSE";
    case "range":
      return String(decl.init);
    case "enum":
      return quoted(nameOf(naming.members, decl.init));
  }
}

/** A `\*` comment holds one line: display names and annotation text are free text. */
function comment(text: string): string {
  return `\\* ${text.replace(/\r\n|\r|\n/g, " ")}`;
}

function setOf(items: readonly string[]): string {
  return `{${items.join(", ")}}`;
}

function conjuncts(items: readonly string[]): string[] {
  return items.map((item) => `  /\\ ${item}`);
}

function action(edge: FlowEdge, name: string, graph: Pick<Graph, "model">, naming: Naming): string {
  const assigned = new Map(edge.set.map(({ target, value }) => [target, value]));
  const unchanged = graph.model.vars.filter((decl) => !assigned.has(decl.name));
  const event = edge.event === null ? "tau" : nameOf(naming.events, edge.event);
  const lines = [
    `state = ${quoted(nameOf(naming.states, edge.from))}`,
    ...(edge.guard === null ? [] : [formula(edge.guard, naming)]),
    `state' = ${quoted(nameOf(naming.states, edge.to))}`,
    ...graph.model.vars.flatMap(({ name: target }) => {
      const value = assigned.get(target);
      return value === undefined
        ? []
        : [`${nameOf(naming.vars, target)}' = ${assignedValue(value, naming)}`];
    }),
    `lastEvent' = ${quoted(event)}`,
    ...(unchanged.length === 0
      ? []
      : [`UNCHANGED <<${unchanged.map((decl) => nameOf(naming.vars, decl.name)).join(", ")}>>`]),
  ];
  return [
    comment(`${edge.via.join(", ")}: @state-next ${edge.text}`),
    `${name} ==`,
    ...conjuncts(lines),
  ].join("\n");
}

function definition(def: TlcDef, name: string, naming: Naming): string {
  const what = def.description === null ? def.id : `${def.id}（${def.description}）`;
  const body =
    def.kind === "invariant"
      ? formula(def.expr.expr, naming)
      : `${formula(def.from.expr, naming)} ~> ${formula(def.to.expr, naming)}`;
  return [comment(`everypath.properties.json: ${what}`), `${name} == ${body}`].join("\n");
}

function problemOfDef(def: TlcDef, vars: VarTable): string | null {
  return def.kind === "invariant"
    ? problemIn(def.expr.expr, vars)
    : firstOf([def.from.expr, def.to.expr], vars);
}

function render(
  graph: Pick<Graph, "nodes" | "edges" | "model">,
  entry: readonly StateName[],
  accepted: readonly TlcDef[],
  naming: Naming,
): string {
  const { vars } = graph.model;
  const flows = graph.edges.filter((edge): edge is FlowEdge => edge.type === "flow");
  const names = (table: Table<string>) => [...table.id.values()];
  const variables = ["state", ...names(naming.vars), "lastEvent"].join(", ");
  const actions = flows.map((edge, index) => ({ edge, name: `A${index + 1}` }));
  const blocks = [
    [
      "---- MODULE Model ----",
      comment("everypath が注釈から生成した。手で直さず、注釈を直して作り直す"),
      "EXTENDS Naturals",
    ],
    [
      ...graph.nodes.map((node) => comment(`${nameOf(naming.states, node.id)} = ${node.id}`)),
      `States == ${setOf(graph.nodes.map((node) => quoted(nameOf(naming.states, node.id))))}`,
    ],
    [
      comment("tau = イベント無しの遷移"),
      ...graph.model.events.map((event) => comment(`${nameOf(naming.events, event)} = ${event}`)),
      `Events == ${setOf(["tau", ...names(naming.events)].map(quoted))}`,
    ],
    [
      ...vars.map((decl) => comment(`${nameOf(naming.vars, decl.name)} = ${decl.name}`)),
      ...[...naming.members.id].map(([member, name]) => comment(`${name} = ${member}`)),
      `VARIABLES ${variables}`,
      `vars == <<${variables}>>`,
    ],
    [
      "TypeOK ==",
      ...conjuncts([
        "state \\in States",
        ...vars.map((decl) => `${nameOf(naming.vars, decl.name)} \\in ${domainOf(decl, naming)}`),
        "lastEvent \\in Events",
      ]),
    ],
    [
      comment(`入口: ${entry.join("、")}`),
      "Init ==",
      ...conjuncts([
        `state \\in ${setOf(entry.map((state) => quoted(nameOf(naming.states, state))))}`,
        ...vars.map((decl) => `${nameOf(naming.vars, decl.name)} = ${initialOf(decl, naming)}`),
        'lastEvent = "tau"',
      ]),
    ],
    ...actions.map(({ edge, name }) => [action(edge, name, graph, naming)]),
    actions.length === 0
      ? ["Next == FALSE"]
      : ["Next ==", ...actions.map(({ name }) => `  \\/ ${name}`)],
    ["Spec == Init /\\ [][Next]_vars /\\ WF_vars(Next)"],
    ...accepted.map((def) => [definition(def, nameOf(naming.checks, def.id), naming)]),
  ];
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n====\n`;
}

/**
 * SPEC §10.1. `invariant` and `leads-to` become TLA+; every other kind stays with the BFS lane.
 * Fails as a whole only without an entry state: Init would be empty and TLC would call that a success.
 */
export function generateTla(
  graph: Pick<Graph, "nodes" | "edges" | "model">,
  file: PropertiesFile,
):
  | { readonly ok: true; readonly model: TlaModel }
  | { readonly ok: false; readonly reason: string } {
  const entry = entryOf(graph, file);
  if (entry.length === 0) {
    return {
      ok: false,
      reason:
        "入口にする状態がありません（entry も @state-initial も入エッジの無い状態も無い）。TLA+ の Init を作れません",
    };
  }
  const vars: VarTable = new Map(graph.model.vars.map((decl) => [decl.name, decl]));
  const accepted: TlcDef[] = [];
  const rejected: { id: PropertyId; reason: string }[] = [];
  for (const def of file.properties.filter(isTlcDef)) {
    const problem = problemOfDef(def, vars);
    if (problem === null) accepted.push(def);
    else
      rejected.push({ id: def.id, reason: `性質 ${def.id} の式を TLA+ にできません: ${problem}` });
  }

  const naming = allocate(
    graph,
    accepted.map((def) => def.id),
  );
  const checkName = (def: TlcDef) => nameOf(naming.checks, def.id);
  const invariants = [
    ...accepted.filter((def) => def.kind === "invariant").map(checkName),
    TYPE_OK,
  ];
  const temporal = accepted.filter((def) => def.kind === "leads-to").map(checkName);
  const events: Record<string, EventName | null> = { tau: null, ...naming.events.back };

  return {
    ok: true,
    model: {
      tla: render(graph, entry, accepted, naming),
      cfg: (checks) => {
        const invariant = checks.filter((check) => invariants.includes(check));
        return `${[
          "SPECIFICATION Spec",
          ...(invariant.includes(TYPE_OK) ? [] : [`CONSTRAINT ${TYPE_OK}`]),
          ...invariant.map((check) => `INVARIANT ${check}`),
          ...checks.filter((check) => temporal.includes(check)).map((check) => `PROPERTY ${check}`),
        ].join("\n")}\n`;
      },
      names: {
        states: naming.states.back,
        vars: naming.vars.back,
        events,
        members: naming.members.back,
        checks: { ...naming.checks.back, [TYPE_OK]: TYPE_OK },
      },
      invariants,
      temporal,
      rejected,
    },
  };
}
