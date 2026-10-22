import { fillTemplate, type PromptKind, type Scope } from "../core/prompts.js";
import type {
  Counterexample,
  FlowEdge,
  Graph,
  ModelVar,
  PropertyResult,
  StateName,
  StateNode,
} from "../core/types.js";
import { isGuardOnly, isLiveViolation } from "../core/verdict.js";
import { driftsFrom, fixOf, liveViolations, selectedIds } from "./facts.js";
import type { DriftDecision, ReplayRef, ViewState } from "./state.js";

/** An instruction ready to paste: the nodes it is about (those its kind applies to) and its text. */
export type Prompt = {
  readonly kind: PromptKind;
  readonly targets: readonly StateName[];
  readonly text: string;
};

type KindRow = {
  /** The button's text. */
  readonly label: string;
  readonly applies: (node: StateNode, graph: Graph) => boolean;
  /** What the person still has to settle before the instruction for `targets` can be made, or null. */
  readonly blocker: (
    graph: Graph,
    targets: readonly StateName[],
    decisions: readonly DriftDecision[],
  ) => string | null;
};

const flowsFrom = (graph: Graph, id: StateName): readonly FlowEdge[] =>
  graph.edges.filter((edge): edge is FlowEdge => edge.type === "flow" && edge.from === id);

const READY = (): null => null;

/**
 * When each kind applies and what it waits for, in one place: the panel's buttons, the counts of
 * "まとめて生成" and `buildPrompt` all read it, so a button never offers what cannot be made.
 */
const KINDS: Readonly<Record<PromptKind, KindRow>> = {
  "fix-counterexample": {
    label: "反例を直す",
    applies: (node, graph) =>
      liveViolations(graph, node).some((property) => property.counterexamples.length > 0),
    blocker: READY,
  },
  "fix-drift": {
    label: "乖離を直す",
    applies: (node, graph) => driftsFrom(graph, node.id).length > 0,
    blocker: (graph, targets, decisions) =>
      targets.some((id) => driftsFrom(graph, id).some((drift) => fixOf(decisions, drift) === null))
        ? "宣言とコードのどちらが正しいかを、乖離ごとに選んでください"
        : null,
  },
  "write-tests": {
    label: "テストを書く",
    applies: (node) => !node.status.tested && !node.status.planned,
    blocker: READY,
  },
  "draw-model": {
    label: "モデルを描かせる",
    applies: (node, graph) =>
      !node.status.planned &&
      !flowsFrom(graph, node.id).some((edge) => edge.guard !== null || edge.set.length > 0),
    blocker: READY,
  },
  "propose-properties": { label: "性質を提案させる", applies: () => true, blocker: READY },
  "explain-model": { label: "モデルを説明させる", applies: () => true, blocker: READY },
};

export function promptLabel(kind: PromptKind): string {
  return KINDS[kind].label;
}

/** The `ids` (in the order given) that `kind` applies to. Ids the graph does not have are dropped. */
export function promptTargets(
  kind: PromptKind,
  graph: Graph,
  ids: readonly StateName[],
): readonly StateName[] {
  const { applies } = KINDS[kind];
  return ids.filter((id) => {
    const node = graph.nodes.find((n) => n.id === id);
    return node !== undefined && applies(node, graph);
  });
}

/**
 * Why the instruction of `kind` for `ids` cannot be made yet, as the panel says it, or null when
 * nothing is left for the person to settle.
 */
export function promptBlocker(
  kind: PromptKind,
  state: ViewState,
  ids: readonly StateName[],
): string | null {
  const { graph } = state;
  if (graph === null) return null;
  return KINDS[kind].blocker(graph, promptTargets(kind, graph, ids), state.decisions);
}

/**
 * The instruction of `kind` for the selected nodes, filled into the template of `state.templates`.
 * `null` when the graph or the templates have not arrived, no selected node takes this kind, or
 * `promptBlocker` names something the person has not settled.
 */
export function buildPrompt(kind: PromptKind, state: ViewState): Prompt | null {
  const { graph, templates, selection } = state;
  if (graph === null || templates === null) return null;
  const targets = promptTargets(kind, graph, selectedIds(selection));
  if (targets.length === 0 || KINDS[kind].blocker(graph, targets, state.decisions) !== null) {
    return null;
  }
  const replay = selection.kind === "node" ? selection.replay : null;
  const scope = scopeOf(kind, graph, targets, { replay, decisions: state.decisions });
  return { kind, targets, text: fillTemplate(templates[kind].text, scope) };
}

const MODEL_PATH = ".everypath/tla/Model.tla";
const RESULT: Readonly<Record<PropertyResult["result"], string>> = {
  ok: "ok",
  violated: "違反",
  error: "エラー",
  pending: "未検査",
};

/**
 * Every name any template may use, whatever the kind: a template that wants fewer leaves some out.
 * Only the fix reads the violations as its job, so only it fills PROPERTY_IDS and APPROVED and may
 * ask for the TLC check.
 */
function scopeOf(
  kind: PromptKind,
  graph: Graph,
  targets: readonly StateName[],
  { replay, decisions }: Pick<ViewState, "decisions"> & { readonly replay: ReplayRef | null },
): Scope {
  const nodes = targets.flatMap((id) => graph.nodes.filter((node) => node.id === id));
  const fixing = kind === "fix-counterexample";
  const included = fixing ? [...new Set(nodes.flatMap((node) => liveViolations(graph, node)))] : [];
  return {
    TARGETS: targets.join("、"),
    MODEL_PATH,
    STATES: graph.nodes.map((node) => node.id).join("、"),
    VARS: graph.model.vars.map(describeVar).join("、"),
    EVENTS: graph.model.events.join("、"),
    PROPERTIES: graph.properties.map(describeProperty).join("\n"),
    PROPERTY_IDS: included.map((property) => property.id).join("、"),
    CHECK_COMMAND: included.some((property) => property.checkedBy !== "bfs")
      ? "everypath check --tlc"
      : "everypath check",
    APPROVED: fixing ? approvedAround(graph, nodes, replay).join("・") : "",
    FOCUS: focusOf(graph, nodes, replay),
    NODES: nodes.map((node) => nodeScope(graph, node, { replay, decisions })),
  };
}

const filesText = (files: readonly string[]): string =>
  files.length === 0 ? "（ファイルなし）" : files.join("、");

function nodeScope(
  graph: Graph,
  node: StateNode,
  { replay, decisions }: Pick<ViewState, "decisions"> & { readonly replay: ReplayRef | null },
): Scope {
  return {
    NODE: node.id,
    FILES: filesText(node.files),
    DRIFTS: driftsFrom(graph, node.id).map((drift) => {
      const fix = fixOf(decisions, drift);
      const target = graph.nodes.find((n) => n.id === drift.to);
      return {
        TO: drift.to,
        VIA: drift.via.join("、"),
        TO_FILES: filesText(target?.files ?? []),
        REMOVE_CALL: fix === "remove-call" ? "yes" : "",
        ADD_NEXT: fix === "add-next" ? "yes" : "",
      };
    }),
    DESC: node.desc ?? "",
    SPEC: node.spec.join(" / "),
    FINDINGS: node.findings
      .map((f) => `- ${f.message}（${f.file}${f.line === null ? "" : `:${f.line}`}, ${f.rule}）`)
      .join("\n"),
    RISKS: node.risks.map((risk) => `- ${risk.message}（${risk.file}）`).join("\n"),
    NEXT: flowsFrom(graph, node.id)
      .map((edge) => `@state-next ${edge.text}`)
      .join("\n"),
    VIOLATIONS: liveViolations(graph, node)
      .map((property) => violationBlock(property, replay))
      .join("\n\n"),
  };
}

function describeVar(decl: ModelVar): string {
  switch (decl.kind) {
    case "boolean":
      return `${decl.name}: BOOLEAN = ${decl.init ? "TRUE" : "FALSE"}`;
    case "range":
      return `${decl.name}: ${decl.min}..${decl.max} = ${decl.init}`;
    case "enum":
      return `${decl.name}: {${decl.members.join(",")}} = ${decl.init}`;
    default: {
      const _exhaustive: never = decl;
      return _exhaustive;
    }
  }
}

function describeProperty(property: PropertyResult): string {
  const note =
    property.staleModel === true
      ? "（古いモデルに対する結果）"
      : isGuardOnly(property)
        ? "（ガードを無視したときだけの経路。TLC では成立）"
        : "";
  const what = property.description ?? "";
  return `- ${property.id}（${property.kind}）${what}: ${RESULT[property.result]}${note}`;
}

/**
 * Reviewed nodes the fix must not touch: those on the counterexamples shown, in step order, then
 * those a target shares a flow edge with, in edge order. A target is what is being changed.
 */
function approvedAround(
  graph: Graph,
  targets: readonly StateNode[],
  replay: ReplayRef | null,
): readonly StateName[] {
  const changing = new Set(targets.map((node) => node.id));
  const onTraces = targets
    .flatMap((node) => liveViolations(graph, node))
    .flatMap((property) => traceOf(property, replay)?.steps.map((step) => step.state) ?? []);
  const neighbours = graph.edges.flatMap((edge) => {
    if (edge.type !== "flow") return [];
    if (changing.has(edge.from) && !changing.has(edge.to)) return [edge.to];
    if (changing.has(edge.to) && !changing.has(edge.from)) return [edge.from];
    return [];
  });
  const reviewed = new Set(graph.nodes.filter((n) => n.status.reviewed).map((n) => n.id));
  return [...new Set([...onTraces, ...neighbours])].filter(
    (id) => reviewed.has(id) && !changing.has(id),
  );
}

/** The violation being replayed, else the first live one of the first target that has one. */
function focusOf(graph: Graph, targets: readonly StateNode[], replay: ReplayRef | null): string {
  const replayed =
    replay === null
      ? undefined
      : graph.properties.find(
          (property) => property.id === replay.property && isLiveViolation(property),
        );
  const property = replayed ?? targets.flatMap((node) => liveViolations(graph, node))[0];
  return property === undefined ? "" : violationBlock(property, replay);
}

/** The replayed counterexample of the property when the replay is on it, else its first. */
function traceOf(property: PropertyResult, replay: ReplayRef | null): Counterexample | undefined {
  const replayed =
    replay?.property === property.id ? property.counterexamples[replay.index] : undefined;
  return replayed ?? property.counterexamples[0];
}

/** SPEC §13's block: who found the violation, which property, then the counterexample step by step. */
function violationBlock(property: PropertyResult, replay: ReplayRef | null): string {
  const what =
    property.description === null ? property.id : `${property.description} (${property.id})`;
  const head = `${checkerOf(property)}で違反: ${what}`;
  const trace = traceOf(property, replay);
  return trace === undefined ? head : [head, "反例:", ...traceLines(trace)].join("\n");
}

function checkerOf({ checkedBy, statesExplored }: PropertyResult): string {
  const count = statesExplored?.toLocaleString("ja-JP");
  const tlc = `TLA+ / TLC${count === undefined ? "" : `、${count} 状態を全探索`}`;
  const bfs = count === undefined ? "" : `（${count} 状態を探索）`;
  switch (checkedBy) {
    case "tlc":
      return `モデル検査（${tlc}）`;
    case "bfs":
      return `簡易検査${bfs}`;
    case "both":
      return `簡易検査とモデル検査（${tlc}）`;
    default: {
      const _exhaustive: never = checkedBy;
      return _exhaustive;
    }
  }
}

/** One line per step: state, event, variables, in columns padded by display width. */
function traceLines(trace: Counterexample): string[] {
  const rows = trace.steps.map((step, index) => ({
    state: `${step.state}`,
    event: index === 0 ? "" : step.event === null ? "（イベントなし）" : `on:${step.event}`,
    vars: Object.entries(step.vars)
      .map(([name, value]) => `${name}=${value}`)
      .join(" "),
  }));
  const column = (read: (row: (typeof rows)[number]) => string): number =>
    Math.max(...rows.map((row) => displayWidth(read(row)))) + 2;
  const stateWidth = column((row) => row.state);
  const eventWidth = column((row) => row.event);
  const lines = rows.map((row, index) =>
    `  ${index + 1}. ${pad(row.state, stateWidth)}${pad(row.event, eventWidth)}${row.vars}`.trimEnd(),
  );
  if (trace.loopStart !== null)
    return [...lines, `  ↺ step ${trace.loopStart + 1} に戻って繰り返す`];
  return lines.map((line, index) => (index === lines.length - 1 ? `${line}   ← ここで違反` : line));
}

/** A CJK character takes two columns of a monospaced font. */
function displayWidth(text: string): number {
  return [...text].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);
}

function pad(text: string, width: number): string {
  return text + " ".repeat(width - displayWidth(text));
}
