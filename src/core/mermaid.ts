import type {
  FlowEdge,
  Graph,
  GuardExpr,
  PropertyId,
  StateName,
  StateNode,
  Value,
} from "./types.js";

type Mark = {
  readonly name: "violated" | "planned";
  readonly style: string;
  readonly applies: (node: StateNode, live: ReadonlySet<PropertyId>) => boolean;
};

/**
 * The marks of `SPEC.md` 7.2 that a pasted diagram can carry, in its priority order: the first mark
 * that applies is the only one a state gets. Both `classDef` and `class` lines come from this table.
 * The colors are those of the viewer's `danger` and `planned` tones in `src/ui/view.ts`.
 */
const MARKS: readonly Mark[] = [
  {
    name: "violated",
    style: "fill:#f8cecc,stroke:#c62828,stroke-width:3px,color:#222222",
    applies: (node, live) => node.violations.some((id) => live.has(id)),
  },
  {
    name: "planned",
    style: "fill:#ffffff,stroke:#8c8c8c,stroke-width:1.5px,stroke-dasharray:6 4,color:#8c8c8c",
    applies: (node) => node.status.planned,
  },
];

const INDENT = "    ";

/**
 * `everypath export --mermaid` (`SPEC.md` 15): the flow edges of `graph` as a `stateDiagram-v2`. Pure,
 * so one graph is one text, with no time and no path in it, and a regenerated diagram differs from
 * the last only where the statechart does.
 *
 * A state's Mermaid id is `s` and its 1-based position in `graph.nodes`, which `scan` keeps in name
 * order. A state name can be in any script, or a word Mermaid reserves such as `end`, so the name is
 * written once, as the description in `sN : name`, and never as an id. A new state renumbers the ids
 * after it. Edges follow `graph.edges`, which `scan` keeps sorted. The start arrow is `model.initial`
 * alone; without a `@state-initial` there is none.
 */
export function toMermaid(graph: Graph): string {
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `s${index + 1}`]));
  const idOf = (name: StateName): string => {
    const id = ids.get(name);
    if (id === undefined) throw new Error(`${name} is on an edge but is not a node of the graph`);
    return id;
  };
  const live = new Set(
    graph.properties
      .filter((property) => property.result === "violated" && property.staleModel !== true)
      .map((property) => property.id),
  );
  const markOf = (node: StateNode): Mark["name"] | undefined =>
    MARKS.find((mark) => mark.applies(node, live))?.name;

  const start = graph.model.initial === null ? [] : [`[*] --> ${idOf(graph.model.initial)}`];
  const arrows = graph.edges
    .filter((edge): edge is FlowEdge => edge.type === "flow")
    .map((edge) => {
      const label = edgeLabel(edge);
      return `${idOf(edge.from)} --> ${idOf(edge.to)}${label === "" ? "" : ` : ${label}`}`;
    });
  const marked = MARKS.flatMap(({ name }) => {
    const members = graph.nodes.filter((node) => markOf(node) === name);
    return members.length === 0
      ? []
      : [`class ${members.map((node) => idOf(node.id)).join(",")} ${name}`];
  });

  const body = [
    ...MARKS.map(({ name, style }) => `classDef ${name} ${style}`),
    ...graph.nodes.map((node) => `${idOf(node.id)} : ${node.id}`),
    ...start,
    ...arrows,
    ...marked,
  ];
  const lines = ["stateDiagram-v2", ...body.map((line) => `${INDENT}${line}`)];
  return `${lines.join("\n")}\n`;
}

/**
 * `on:` event, then `[guard]`, as `edgeLabel` in `src/ui/view.ts` prints them. That file cannot be
 * imported here: it reaches `@dagrejs/dagre`, a devDependency that `dist/cli.js` must not load
 * (R-02). `test/mermaid.test.ts` compares the two over every operator, so they cannot drift.
 */
function edgeLabel(edge: FlowEdge): string {
  const guard = edge.guard === null ? null : `[${printGuard(edge.guard)}]`;
  return [edge.event, guard].filter((part) => part !== null).join(" ");
}

/** `authed` for `authed == TRUE`, which is how the parser reads a bare variable. */
function isBare(expr: GuardExpr): boolean {
  return expr.kind === "cmp" && expr.op === "==" && expr.value.kind === "bool" && expr.value.value;
}

/** Precedence `||` < `&&` < `!`, so parentheses go only round an `||` in an `&&` and a compound under `!`. */
function printGuard(expr: GuardExpr): string {
  switch (expr.kind) {
    case "cmp":
      return isBare(expr) ? expr.name : `${expr.name}${expr.op}${printValue(expr.value)}`;
    case "not": {
      const inner = printGuard(expr.operand);
      return expr.operand.kind === "not" || isBare(expr.operand) ? `!${inner}` : `!(${inner})`;
    }
    case "and":
      return expr.operands
        .map((operand) =>
          operand.kind === "or" ? `(${printGuard(operand)})` : printGuard(operand),
        )
        .join(" && ");
    case "or":
      return expr.operands.map(printGuard).join(" || ");
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}

function printValue(value: Value): string {
  switch (value.kind) {
    case "bool":
      return value.value ? "TRUE" : "FALSE";
    case "int":
      return String(value.value);
    case "member":
      return value.name;
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}
