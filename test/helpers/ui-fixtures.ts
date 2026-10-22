import { parseEventName, parseStateName, parseVarName } from "../../src/core/expr.js";
import { parseProperties } from "../../src/core/properties.js";
import type {
  Counterexample,
  DepEdge,
  Edge,
  EventName,
  FlowEdge,
  Graph,
  NodeStatus,
  ParseResult,
  PropertyId,
  PropertyResult,
  StateName,
  StateNode,
  Step,
  VarName,
} from "../../src/core/types.js";
import type { GraphEvent, TlcEvent } from "../../src/ui/wire.js";

function unwrap<T>(parsed: ParseResult<T>, text: string): T {
  if (!parsed.ok)
    throw new Error(`fixture name ${JSON.stringify(text)}: ${parsed.warning.message}`);
  return parsed.value;
}

export function name(text: string): StateName {
  return unwrap(parseStateName(text), text);
}

export function eventName(text: string): EventName {
  return unwrap(parseEventName(text), text);
}

export function varName(text: string): VarName {
  return unwrap(parseVarName(text), text);
}

/** `PropertyId` is minted by the properties file parser only. */
export function propertyId(text: string): PropertyId {
  const { file } = parseProperties({ properties: [{ id: text, kind: "no-dead-end" }] });
  const [definition] = file.properties;
  if (definition === undefined) throw new Error(`fixture property id ${JSON.stringify(text)}`);
  return definition.id;
}

/** Tested, not yet reviewed: SPEC §7.2 row 6, with every row above it off. */
export const UNREVIEWED: NodeStatus = {
  tested: true,
  vuln: false,
  wip: false,
  planned: false,
  requireProof: false,
  proof: "none",
  reviewed: false,
  changedSinceReview: false,
};

export function node(
  id: string,
  parts: { status?: Partial<NodeStatus>; violations?: readonly PropertyId[] } = {},
): StateNode {
  return {
    id: name(id),
    group: null,
    desc: null,
    files: [],
    lines: 0,
    hash: `hash-${id}`,
    status: { ...UNREVIEWED, ...parts.status },
    spec: [],
    risks: [],
    findings: [],
    violations: parts.violations ?? [],
    lastChangedAt: "2026-10-21T05:00:00.000Z",
  };
}

export function flow(from: string, to: string, event: string | null = null): FlowEdge {
  return {
    type: "flow",
    from: name(from),
    to: name(to),
    event: event === null ? null : eventName(event),
    guard: null,
    set: [],
    text: event === null ? "" : `on:${event}`,
    via: [],
    declared: true,
    observed: false,
  };
}

export function dep(from: string, to: string): DepEdge {
  return { type: "dep", from: name(from), to: name(to), via: [] };
}

/** `vars[i]` is the variable values at step `i`, as `[variable, value]` pairs. */
export function counterexample(
  path: readonly [string, ...string[]],
  options: {
    loopStart?: number;
    vars?: readonly (readonly (readonly [string, string])[])[];
  } = {},
): Counterexample {
  const steps = path.map(
    (state, index): Step => ({
      state: name(state),
      event: index === 0 ? null : eventName(`e${index}`),
      vars: Object.fromEntries(
        (options.vars?.[index] ?? []).map(([variable, value]) => [varName(variable), value]),
      ),
    }),
  );
  const [first, ...rest] = steps;
  if (first === undefined) throw new Error("a counterexample has a step");
  return {
    path: [first.state, ...rest.map((step) => step.state)],
    steps: [first, ...rest],
    loopStart: options.loopStart ?? null,
  };
}

export function property(
  id: string,
  result: PropertyResult["result"],
  counterexamples: readonly Counterexample[] = [],
  options: { stale?: true } = {},
): PropertyResult {
  return {
    id: propertyId(id),
    kind: "invariant",
    description: null,
    checkedBy: "tlc",
    result,
    counterexamples,
    statesExplored: 10,
    checkedAt: "2026-10-21T05:00:00.000Z",
    ...(options.stale === undefined ? {} : { staleModel: options.stale }),
  };
}

export function graph(parts: {
  nodes: readonly StateNode[];
  edges?: readonly Edge[];
  properties?: readonly PropertyResult[];
}): Graph {
  const { nodes, edges = [], properties = [] } = parts;
  const real = nodes.filter((n) => !n.status.planned);
  return {
    version: 1,
    generatedAt: "2026-10-21T05:00:00.000Z",
    root: "/repo",
    findingsSource: null,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      tested: real.filter((n) => n.status.tested).length,
      untested: real.filter((n) => !n.status.tested).length,
      vuln: nodes.filter((n) => n.status.vuln).length,
      wip: nodes.filter((n) => n.status.wip).length,
      planned: nodes.length - real.length,
      unreviewed: real.filter((n) => !n.status.reviewed).length,
    },
    nodes,
    edges,
    model: { initial: null, vars: [], events: [] },
    properties,
    drift: [],
    warnings: [],
  };
}

export function graphEvent(g: Graph, reason = "watch"): GraphEvent {
  return { type: "graph", graph: g, diff: null, reason };
}

export function tlcEvent(
  status: TlcEvent["status"],
  parts: { states?: number; message?: string } = {},
): TlcEvent {
  return { type: "tlc", status, states: parts.states ?? null, message: parts.message ?? null };
}
