import type {
  Counterexample,
  FlowEdge,
  Graph,
  GuardExpr,
  PropertyResult,
  StateName,
  StateNode,
  Value,
} from "../core/types.js";
import { type Box, boxAt, type Point, route } from "./layout.js";
import { isLiveViolation, replayOf, type ViewState } from "./state.js";

export type Tone =
  | "danger"
  | "planned"
  | "wip"
  | "untested"
  | "changed"
  | "unreviewed"
  | "proven"
  | "approved";

/** How one tone looks. Colors are CSS colors; `dash` is an SVG `stroke-dasharray`, null for solid. */
export type ToneRow = {
  readonly tone: Tone;
  readonly label: string;
  readonly fill: string;
  readonly stroke: string;
  readonly width: number;
  readonly dash: string | null;
  /** The color of the box's name and caption. */
  readonly text: string;
  /** True for the two tones a reviewer is done with (blue and green). */
  readonly settled: boolean;
};

/** What a row of §7.2 reads: the node's status, and whether a live violation passes through it. */
type Facts = StateNode["status"] & { readonly failing: boolean };
type Rule = ToneRow & { readonly when: (facts: Facts) => boolean };

const INK = "#222222";

const RULES: readonly Rule[] = [
  {
    tone: "danger",
    label: "脆弱性・性質違反",
    fill: "#f8cecc",
    stroke: "#c62828",
    width: 3,
    dash: null,
    text: INK,
    settled: false,
    when: (f) => f.vuln || f.failing || f.proof === "failed",
  },
  {
    tone: "planned",
    label: "計画のみ",
    fill: "#ffffff",
    stroke: "#8c8c8c",
    width: 1.5,
    dash: "6 4",
    text: "#8c8c8c",
    settled: false,
    when: (f) => f.planned,
  },
  {
    tone: "wip",
    label: "作業中",
    fill: "#fff2b3",
    stroke: INK,
    width: 1.5,
    dash: null,
    text: INK,
    settled: false,
    when: (f) => f.wip,
  },
  {
    tone: "untested",
    label: "未テスト",
    fill: "#ffe0b2",
    stroke: INK,
    width: 1.5,
    dash: null,
    text: INK,
    settled: false,
    when: (f) => !f.tested,
  },
  {
    tone: "changed",
    label: "承認後に変更",
    fill: "#dedede",
    stroke: INK,
    width: 3,
    dash: null,
    text: INK,
    settled: false,
    when: (f) => f.changedSinceReview,
  },
  {
    tone: "unreviewed",
    label: "未レビュー",
    fill: "#eeeeee",
    stroke: INK,
    width: 1.5,
    dash: null,
    text: INK,
    settled: false,
    when: (f) => !f.reviewed,
  },
  {
    tone: "proven",
    label: "証明済み・承認済み",
    fill: "#dae8fc",
    stroke: INK,
    width: 1.5,
    dash: null,
    text: INK,
    settled: true,
    when: (f) => f.reviewed && f.proof === "passed",
  },
];

const FALLBACK: ToneRow = {
  tone: "approved",
  label: "承認済み",
  fill: "#d4edd4",
  stroke: INK,
  width: 1.5,
  dash: null,
  text: INK,
  settled: true,
};

/**
 * SPEC §7.2 as ONE table: priority is row order, the first matching row wins, the last row is the
 * fallback. `toneOf`, the legend, the canvas colors, the header counts and the review queue all read
 * it, so a color never disagrees with a count. Tone, priority, label, fill, stroke, width, dash, text
 * and `settled` of every row live here and nowhere else.
 */
export const TONES: readonly ToneRow[] = [...RULES, FALLBACK];

/** The row that paints `tone`. */
export function rowOf(tone: Tone): ToneRow {
  return TONES.find((row) => row.tone === tone) ?? FALLBACK;
}

/**
 * Condition 4. A violation counts only while its property is `violated` and not `staleModel`.
 * `proof == "failed"` is `danger` too.
 */
export function toneOf(node: StateNode, properties: readonly PropertyResult[]): Tone {
  const failing = node.violations.some((id) =>
    properties.some((p) => p.id === id && isLiveViolation(p)),
  );
  const facts: Facts = { ...node.status, failing };
  return (RULES.find((rule) => rule.when(facts)) ?? FALLBACK).tone;
}

/** The properties a person must look at: violated on the current model. Header and TLC summary count these. */
export function violated(graph: Graph): readonly PropertyResult[] {
  return graph.properties.filter(isLiveViolation);
}

/**
 * Nodes whose tone is not settled, in `TONES` order, then id. The header's "未レビュー N" is its
 * length and its "脆弱性 N" its danger rows, so the counts can never disagree with the colors.
 */
export function reviewQueue(
  graph: Graph,
): readonly { readonly node: StateNode; readonly tone: Tone }[] {
  const rank = (tone: Tone): number => TONES.findIndex((row) => row.tone === tone);
  return graph.nodes
    .map((node) => ({ node, tone: toneOf(node, graph.properties) }))
    .filter(({ tone }) => !rowOf(tone).settled)
    .sort((a, b) => rank(a.tone) - rank(b.tone) || compare(a.node.id, b.node.id));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `on:` event, then `[guard]` (SPEC §12.1). Printed from the AST with SPEC §5.1's operators. */
export function edgeLabel(edge: FlowEdge): string {
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

/** A box being dragged and where it is now (world coordinates, unsnapped). */
export type Drag = { readonly id: StateName; readonly at: Point };

export type SceneItem =
  | {
      readonly kind: "box";
      readonly id: StateName;
      readonly box: Box;
      readonly tone: Tone;
      readonly title: string;
      /** The tone's label, shown under the name. */
      readonly caption: string;
      readonly selected: boolean;
      /** The state of the replay's current step. */
      readonly current: boolean;
      /** ms since `lastChangedAt` while under 30 s, else null. */
      readonly age: number | null;
    }
  | {
      readonly kind: "line";
      readonly look: "flow" | "dep" | "trail";
      readonly points: readonly Point[];
      /** Parallel flow edges between one pair are one line; their labels join with " / ". */
      readonly label: string | null;
    }
  | {
      readonly kind: "callout";
      /** The box it sits beside. */
      readonly box: Box;
      /** "step 2/3", "event: forgot", "authed = FALSE", "retries = 0", "↺ 繰り返し" */
      readonly lines: readonly string[];
    };

/**
 * The canvas as data. `live` is everything that moves with the dragged box (the box, its edges, trail
 * segments and callout touching it); `base` is the rest. With no drag, `live` is empty. Each list is
 * in paint order: dep lines, flow lines, trail, boxes, callout.
 */
export type Scene = {
  readonly base: readonly SceneItem[];
  readonly live: readonly SceneItem[];
  /** Bounding box of the drawn boxes, for the first fit-to-view. null for an empty graph. */
  readonly bounds: Box | null;
};

/** SPEC §7.2: a node added or changed this recently pulses. */
const PULSE_MS = 30_000;
/** Roughly what fits on one line of a box at the title's font size, counting a CJK character as 1. */
const TITLE_EM = 10.5;

type Pair = { readonly from: StateName; readonly to: StateName; readonly labels: string[] };

/** One entry per ordered pair, in first-seen order. */
function pairsOf(
  links: readonly { readonly from: StateName; readonly to: StateName; readonly label: string }[],
): readonly Pair[] {
  const pairs = new Map<string, Pair>();
  for (const { from, to, label } of links) {
    const key = JSON.stringify([from, to]);
    const pair = pairs.get(key) ?? { from, to, labels: [] };
    if (label !== "") pair.labels.push(label);
    pairs.set(key, pair);
  }
  return [...pairs.values()];
}

/** Each step to the next, then back to where a looping trace repeats from. */
function trailOf(
  trace: Counterexample,
): readonly { readonly from: StateName; readonly to: StateName; readonly label: string }[] {
  const states = trace.steps.map((step) => step.state);
  const loop = trace.loopStart === null ? undefined : states[trace.loopStart];
  const targets = loop === undefined ? states.slice(1) : [...states.slice(1), loop];
  return targets.flatMap((to, index) => {
    const from = states[index];
    return from === undefined ? [] : [{ from, to, label: "" }];
  });
}

function widthOf(char: string): number {
  return (char.codePointAt(0) ?? 0) > 0xff ? 1 : 0.6;
}

function fitTitle(text: string): string {
  const chars = [...text];
  if (chars.reduce((sum, char) => sum + widthOf(char), 0) <= TITLE_EM) return text;
  let width = widthOf("…");
  let kept = "";
  for (const char of chars) {
    width += widthOf(char);
    if (width > TITLE_EM) break;
    kept += char;
  }
  return `${kept}…`;
}

/** Pure: the same state, `now` and drag give the same scene. A node without a point is not drawn. */
export function sceneOf(
  state: ViewState,
  frame: { readonly now: number; readonly drag: Drag | null },
): Scene {
  const { graph } = state;
  if (graph === null) return { base: [], live: [], bounds: null };
  const { drag, now } = frame;
  const boxOf = (id: StateName): Box | undefined => {
    const point = drag?.id === id ? drag.at : state.layout[id];
    return point === undefined ? undefined : boxAt(point);
  };
  const replay = replayOf(state);
  const selected = state.selection.kind === "node" ? state.selection.id : null;
  const items: { readonly item: SceneItem; readonly touches: readonly StateName[] }[] = [];

  const lines = (look: "flow" | "dep" | "trail", pairs: readonly Pair[], lane: number): void => {
    for (const { from, to, labels } of pairs) {
      const a = boxOf(from);
      const b = boxOf(to);
      if (a === undefined || b === undefined) continue;
      const label = labels.length === 0 ? null : labels.join(" / ");
      items.push({
        item: { kind: "line", look, points: route(a, b, lane), label },
        touches: [from, to],
      });
    }
  };
  if (state.showDeps) {
    lines(
      "dep",
      pairsOf(graph.edges.flatMap((e) => (e.type === "dep" ? [{ ...e, label: "" }] : []))),
      1,
    );
  }
  lines(
    "flow",
    pairsOf(graph.edges.flatMap((e) => (e.type === "flow" ? [{ ...e, label: edgeLabel(e) }] : []))),
    0,
  );
  if (replay !== null) lines("trail", pairsOf(trailOf(replay.trace)), 0);

  for (const node of graph.nodes) {
    const box = boxOf(node.id);
    if (box === undefined) continue;
    const tone = toneOf(node, graph.properties);
    const age = now - Date.parse(node.lastChangedAt);
    items.push({
      item: {
        kind: "box",
        id: node.id,
        box,
        tone,
        title: fitTitle(node.id),
        caption: rowOf(tone).label,
        selected: node.id === selected,
        current: replay?.current.state === node.id,
        age: age >= 0 && age < PULSE_MS ? age : null,
      },
      touches: [node.id],
    });
  }

  const beside = replay === null ? undefined : boxOf(replay.current.state);
  if (replay !== null && beside !== undefined) {
    const { current, step, trace, loopStart } = replay;
    const looping = loopStart !== null && step >= loopStart;
    items.push({
      item: {
        kind: "callout",
        box: beside,
        lines: [
          `step ${step + 1}/${trace.steps.length}`,
          ...(current.event === null ? [] : [`イベント: ${current.event}`]),
          ...Object.entries(current.vars).map(([name, value]) => `${name} = ${value}`),
          ...(looping ? [`↺ 繰り返し（step ${loopStart + 1} から）`] : []),
        ],
      },
      touches: [current.state],
    });
  }

  const moving = (touches: readonly StateName[]): boolean =>
    drag !== null && touches.includes(drag.id);
  const boxes = items.flatMap(({ item }) => (item.kind === "box" ? [item.box] : []));
  return {
    base: items.filter(({ touches }) => !moving(touches)).map(({ item }) => item),
    live: items.filter(({ touches }) => moving(touches)).map(({ item }) => item),
    bounds: boundsOf(boxes),
  };
}

function boundsOf(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
