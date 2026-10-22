import { edgeLabel } from "../core/expr.js";
import type { Counterexample, Graph, PropertyResult, StateName, StateNode } from "../core/types.js";
import { isGuardOnly, isLiveViolation } from "../core/verdict.js";
import { selectedIds } from "./facts.js";
import { type Box, boxAt, labelBoxes, overlaps, type Point, route } from "./layout.js";
import { replayOf, type ViewState } from "./state.js";

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
 * Condition 4. A violation counts only while `isLiveViolation` says so: not on an older model, and
 * not a path TLC cleared. `proof == "failed"` is `danger` too.
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

/** Nodes whose tone is not settled, in `TONES` order, then id. The header's "未レビュー N" is its length. */
export function reviewQueue(
  graph: Graph,
): readonly { readonly node: StateNode; readonly tone: Tone }[] {
  const rank = (tone: Tone): number => TONES.findIndex((row) => row.tone === tone);
  return graph.nodes
    .map((node) => ({ node, tone: toneOf(node, graph.properties) }))
    .filter(({ tone }) => !rowOf(tone).settled)
    .sort((a, b) => rank(a.tone) - rank(b.tone) || compare(a.node.id, b.node.id));
}

/** The header line of SPEC §12. 脆弱性 counts scanner findings (`status.vuln`), not every red box. */
export function headerCounts(graph: Graph): {
  readonly nodes: number;
  readonly unreviewed: number;
  readonly vulnerable: number;
  readonly violated: number;
} {
  return {
    nodes: graph.nodes.length,
    unreviewed: reviewQueue(graph).length,
    vulnerable: graph.nodes.filter((node) => node.status.vuln).length,
    violated: violated(graph).length,
  };
}

/**
 * Which lane decided a property, so a reviewer can tell a TLC-only finding from a reachability one
 * (SPEC §19 item 8). TLC's explored-state count goes with it when TLC reported one.
 */
export function checkedByLabel(property: PropertyResult): string {
  const states = property.statesExplored === null ? "" : `、${property.statesExplored} 状態`;
  switch (property.checkedBy) {
    case "bfs":
      return "簡易検査（変数を見ない到達性）で判定";
    case "tlc":
      return `全探索（TLC）で判定${states}`;
    case "both":
      return `簡易検査と全探索（TLC）で判定${states}`;
  }
}

/** Only step 0 is the initial state; a later step without an event took an event-less transition. */
export function stepEvent(index: number, event: string | null): string {
  if (event !== null) return event;
  return index === 0 ? "（初期状態）" : "（イベントなし）";
}

/**
 * What TLC said about a quick-check violation, for the detail panel; empty without a verdict. A path
 * TLC cleared on this model is listed as open only with guards ignored, so it is never replayed red.
 */
export function tlcLines(property: PropertyResult): readonly string[] {
  const { tlc } = property;
  if (tlc === undefined) return [];
  const count = tlc.statesExplored === null ? "" : `、${tlc.statesExplored} 状態`;
  if (tlc.staleModel === true) {
    return [`全探索（TLC）: ${TLC_WORDS[tlc.result]}（古いモデルに対する結果${count}）`];
  }
  if (isGuardOnly(property)) {
    return [
      `全探索（TLC${count}）では成立。ガードどおりに動くと、この経路は通れません`,
      ...property.counterexamples.map(
        (trace) =>
          `ガードを無視したときだけの経路: ${trace.steps.map((step) => step.state).join(" → ")}`,
      ),
    ];
  }
  return [`全探索（TLC${count}）: ${TLC_WORDS[tlc.result]}`];
}

const TLC_WORDS = { ok: "成立", violated: "違反", error: "エラーで判定できませんでした" } as const;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A box being dragged and where it is now (world coordinates, unsnapped). */
export type Drag = { readonly id: StateName; readonly at: Point };

/**
 * SPEC §7.3's line kinds. A declared flow is black whether or not a call was observed, because a
 * missing call is no evidence (docs/specs/drift.md); `observed` is a call no `@state-next` declares.
 */
export type Look = "flow" | "dep" | "observed" | "trail";

/** How a drift line looks: orange, labelled 宣言なし (SPEC §7.3). */
export const DRIFT = { stroke: "#ef6c00", label: "宣言なし" } as const;

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
      readonly look: Look;
      readonly points: readonly Point[];
      /**
       * Parallel flow edges between one pair are one line; their labels join with " / ". `box` is
       * where the text is centred: it overlaps no node and no label placed before it, if any spot
       * of the line allows that.
       */
      readonly label: { readonly text: string; readonly box: Box } | null;
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
 * in paint order: dep lines, flow lines, drift lines, trail, boxes, callout.
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
  const selected = new Set(selectedIds(state.selection));
  const items: { readonly item: SceneItem; readonly touches: readonly StateName[] }[] = [];
  /** What a label may not cover: every node, then each label as it is placed. */
  const taken = graph.nodes.flatMap(({ id }) => boxOf(id) ?? []);

  const lines = (look: Look, pairs: readonly Pair[], lane: number): void => {
    for (const { from, to, labels } of pairs) {
      const a = boxOf(from);
      const b = boxOf(to);
      if (a === undefined || b === undefined) continue;
      const points = route(a, b, lane);
      const label = labels.length === 0 ? null : placeLabel(labels.join(" / "), points, taken);
      if (label !== null) taken.push(label.box);
      items.push({ item: { kind: "line", look, points, label }, touches: [from, to] });
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
  // Lane 0 is free: scan makes an observed edge only for a pair no flow declares.
  lines(
    "observed",
    pairsOf(
      graph.edges.flatMap((e) => (e.type === "observed" ? [{ ...e, label: DRIFT.label }] : [])),
    ),
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
        selected: selected.has(node.id),
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
          `イベント: ${stepEvent(step, current.event)}`,
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

/** The first place for the text that covers nothing in `taken`; the best place if there is none. */
function placeLabel(
  text: string,
  points: readonly Point[],
  taken: readonly Box[],
): { readonly text: string; readonly box: Box } {
  const boxes = labelBoxes(text, points);
  const box =
    boxes.find((candidate) => taken.every((other) => !overlaps(candidate, other))) ??
    boxes[0] ??
    boxAt({ x: 0, y: 0 });
  return { text, box };
}

function boundsOf(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
