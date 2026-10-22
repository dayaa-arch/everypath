import { edgeLabel } from "./expr.js";
import { hierarchyOf } from "./hierarchy.js";
import type { FlowEdge, Graph, PropertyId, StateName, StateNode } from "./types.js";
import { isLiveViolation } from "./verdict.js";

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
 *
 * A parent (`@state-parent`) is a composite state `state sN { … }` holding its children, with its own
 * `[*] -->` to the child it enters when one is marked. An arrow is written in the block of the nearest
 * state that holds both its ends, and starts at the state it was declared on: the composite is the
 * idiom for "this arrow holds for everything inside". Only a leaf carries a mark.
 */
export function toMermaid(graph: Graph): string {
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `s${index + 1}`]));
  const idOf = (name: StateName): string => {
    const id = ids.get(name);
    if (id === undefined) throw new Error(`${name} is on an edge but is not a node of the graph`);
    return id;
  };
  const hierarchy = hierarchyOf(graph.nodes);
  const live = new Set(graph.properties.filter(isLiveViolation).map((property) => property.id));
  const markOf = (node: StateNode): Mark["name"] | undefined =>
    hierarchy.isLeaf(node.id) ? MARKS.find((mark) => mark.applies(node, live))?.name : undefined;

  const flows = graph.edges.filter((edge): edge is FlowEdge => edge.type === "flow");
  const arrowsIn = (scope: StateName | null): string[] =>
    flows
      .filter((edge) => hierarchy.commonAncestor(edge.from, edge.to) === scope)
      .map((edge) => {
        const label = edgeLabel(edge);
        return `${idOf(edge.from)} --> ${idOf(edge.to)}${label === "" ? "" : ` : ${label}`}`;
      });
  /** A state's declaration line, and for a parent the block of what is inside it. */
  const declare = (name: StateName): string[] =>
    hierarchy.isLeaf(name)
      ? [`${idOf(name)} : ${name}`]
      : [
          `${idOf(name)} : ${name}`,
          `state ${idOf(name)} {`,
          ...levelOf(name, hierarchy.initialChild(name)).map((line) => `${INDENT}${line}`),
          "}",
        ];
  /** One level, in `graph.nodes` order: its states, the arrow to where entering lands, its arrows. */
  const levelOf = (scope: StateName | null, initial: StateName | null): string[] => [
    ...graph.nodes
      .filter(({ id }) => hierarchy.parentOf(id) === scope)
      .flatMap(({ id }) => declare(id)),
    ...(initial === null ? [] : [`[*] --> ${idOf(initial)}`]),
    ...arrowsIn(scope),
  ];
  const marked = MARKS.flatMap(({ name }) => {
    const members = graph.nodes.filter((node) => markOf(node) === name);
    return members.length === 0
      ? []
      : [`class ${members.map((node) => idOf(node.id)).join(",")} ${name}`];
  });

  const body = [
    ...MARKS.map(({ name, style }) => `classDef ${name} ${style}`),
    ...levelOf(null, graph.model.initial),
    ...marked,
  ];
  const lines = ["stateDiagram-v2", ...body.map((line) => `${INDENT}${line}`)];
  return `${lines.join("\n")}\n`;
}
