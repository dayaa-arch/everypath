import { hierarchyOf, isContainer } from "../core/hierarchy.js";
import { PROMPT_KINDS, type PromptKind } from "../core/prompts.js";
import type {
  EdgeRef,
  Graph,
  HistoryEntry,
  NodeStatus,
  PropertyResult,
  StateName,
  StateNode,
} from "../core/types.js";
import { isGuardOnly, isLiveViolation } from "../core/verdict.js";
import { driftsFrom, fixOf, selectedIds } from "./facts.js";
import { type Box, boxAt, type Point, pointIn } from "./layout.js";
import { modelSlice } from "./model.js";
import { type Prompt, promptBlocker, promptLabel, promptTargets } from "./prompt.js";
import {
  type Action,
  type DriftFix,
  type Replay,
  replayOf,
  type TlcView,
  type ViewState,
} from "./state.js";
import {
  checkedByLabel,
  DRIFT,
  FILE_CARD,
  headerCounts,
  type Look,
  reviewQueue,
  rowOf,
  type SceneItem,
  sceneOf,
  stepEvent,
  TONES,
  type ToneRow,
  tlcLines,
  toneOf,
  violated,
} from "./view.js";

/** What the screen can ask for. `dispatch` changes state; the rest are HTTP and live in main.ts. */
export type Commands = {
  readonly dispatch: (action: Action) => void;
  readonly approve: (node: StateNode) => void;
  readonly revoke: (node: StateNode) => void;
  readonly runTlc: () => void;
  /** Builds the instruction of this kind for the selection and puts it on the clipboard. */
  readonly generate: (kind: PromptKind) => void;
  readonly copy: (text: string) => void;
};

export type Viewer = {
  /** Hands over the latest state. Paints on the next animation frame; many calls, one paint. */
  show(state: ViewState): void;
};

/** World-to-screen transform of `#world`: screen = world * k + (x, y). */
type Viewport = { readonly x: number; readonly y: number; readonly k: number };

/** The pointer between down and up. It never reaches the reducer until a drag is dropped. */
type Gesture =
  | { readonly kind: "idle" }
  | {
      readonly kind: "press" | "drag";
      readonly pointer: number;
      readonly id: StateName;
      readonly start: Point;
      readonly origin: Point;
      readonly at: Point;
    }
  | {
      readonly kind: "pan";
      readonly pointer: number;
      readonly start: Point;
      readonly from: Viewport;
      readonly moved: boolean;
      /** A parent's frame pressed: a click selects it. A frame is never dragged; its boxes are. */
      readonly frame: StateName | null;
    };

const SVG_NS = "http://www.w3.org/2000/svg";
/** A press that moves less than this is a click. */
const SLOP = 4;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;
const DANGER = rowOf("danger");
/** The lines whose color means something; `null` leaves it to the stylesheet's ink and grey. */
const LINE_COLORS: Readonly<Record<Look, string | null>> = {
  flow: null,
  dep: null,
  observed: DRIFT.stroke,
  trail: DANGER.stroke,
};

const PROOF: Readonly<Record<NodeStatus["proof"], string>> = {
  none: "なし",
  pending: "検証待ち",
  passed: "成功",
  failed: "失敗",
};
const SEVERITY = { high: "高", medium: "中", low: "低" } as const;

type Attrs = Readonly<Record<string, string | number>>;
type Content = Node | string;
type Child = Content | null;

/** The only element factories. Strings become text nodes and attribute values, never markup. */
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: readonly Child[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children.filter((child) => child !== null));
  return element;
}

function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children.filter((child) => child !== null));
  return element;
}

function button(text: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const element = html("button", { type: "button" }, text);
  element.disabled = disabled;
  element.addEventListener("click", onClick);
  return element;
}

function checkbox(text: string, checked: boolean, onChange: (checked: boolean) => void): Node {
  const input = html("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return html("label", {}, input, text);
}

function find<T extends Element>(id: string, type: abstract new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`index.html に #${id} がありません`);
  return element;
}

/** Finds the elements of index.html, installs every listener once, and returns the viewer. */
export function mount(commands: Commands): Viewer {
  const header = find("header", HTMLElement);
  const canvas = find("canvas", SVGSVGElement);
  const world = find("world", SVGGElement);
  const base = find("base", SVGGElement);
  const live = find("live", SVGGElement);
  const panel = find("panel", HTMLElement);
  const dockTabs = find("dock-tabs", HTMLElement);
  const dockList = find("dock-list", HTMLElement);
  find("legend", HTMLElement).replaceChildren(...legend());

  let latest: ViewState | null = null;
  let painted: { readonly state: ViewState | null; readonly dragId: StateName | null } = {
    state: null,
    dragId: null,
  };
  let scheduled = false;
  let gesture: Gesture = { kind: "idle" };
  let viewport: Viewport = { x: 0, y: 0, k: 1 };
  let fitted = false;
  let labelsAlways = true;
  let dismissed: TlcView | null = null;

  const request = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(frame);
  };

  const applyViewport = (): void => {
    world.setAttribute("transform", `translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`);
  };

  const controls: HeaderControls = {
    labelsAlways: () => labelsAlways,
    setLabelsAlways: (checked) => {
      labelsAlways = checked;
      canvas.classList.toggle("labels-on-hover", !checked);
    },
    dismissed: () => dismissed,
    dismiss: (tlc) => {
      dismissed = tlc;
      if (latest !== null) header.replaceChildren(...headerOf(latest, commands, controls));
    },
    relayout: () => {
      fitted = false;
      commands.dispatch({ kind: "relayout" });
    },
  };

  function frame(): void {
    scheduled = false;
    const state = latest;
    if (state === null) return;
    const drag = gesture.kind === "drag" ? { id: gesture.id, at: gesture.at } : null;
    const scene = sceneOf(state, { now: Date.now(), drag });
    const fresh = state !== painted.state;
    if (fresh || (drag?.id ?? null) !== painted.dragId) paint(base, scene.base);
    paint(live, scene.live);
    if (fresh) {
      header.replaceChildren(...headerOf(state, commands, controls));
      paintPanel(state, painted.state);
      paintDock(state, painted.state);
    }
    if (!fitted && scene.bounds !== null) {
      const { width, height } = canvas.getBoundingClientRect();
      viewport = fit(scene.bounds, width, height);
      fitted = true;
      applyViewport();
    }
    painted = { state, dragId: drag?.id ?? null };
  }

  /** A new selection or tab starts at the top; any other change leaves the person where they were reading. */
  function paintPanel(state: ViewState, previous: ViewState | null): void {
    const top = panel.scrollTop;
    panel.replaceChildren(...panelOf(state, commands));
    const same =
      previous !== null &&
      previous.panelTab === state.panelTab &&
      selectedIds(previous.selection).join("\n") === selectedIds(state.selection).join("\n");
    panel.scrollTop = same ? top : 0;
    if (state.prompt !== null && state.prompt !== previous?.prompt) {
      panel.querySelector("#prompt-output")?.scrollIntoView({ block: "nearest" });
    }
  }

  function paintDock(state: ViewState, previous: ViewState | null): void {
    const top = dockList.scrollTop;
    dockTabs.replaceChildren(...dockTabsOf(state, commands));
    dockList.replaceChildren(...dockListOf(state, jump));
    dockList.scrollTop = previous?.dockTab === state.dockTab ? top : 0;
  }

  /** Selects the node and brings its box to the middle of the canvas, at the zoom it has now. */
  function jump(id: StateName): void {
    commands.dispatch({ kind: "select", id, extend: false });
    const point = latest === null ? undefined : pointIn(latest.layout, id);
    if (point === undefined) return;
    const box = boxAt(point);
    const { width, height } = canvas.getBoundingClientRect();
    viewport = {
      ...viewport,
      x: width / 2 - (box.x + box.width / 2) * viewport.k,
      y: height / 2 - (box.y + box.height / 2) * viewport.k,
    };
    applyViewport();
  }

  const nodeAt = (target: EventTarget | null): StateName | null => {
    const id =
      target instanceof Element ? target.closest("[data-id]")?.getAttribute("data-id") : null;
    return latest?.graph?.nodes.find((node) => node.id === id)?.id ?? null;
  };

  const isFrame = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest("[data-id]")?.classList.contains("parent") === true;

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || gesture.kind !== "idle") return;
    const start = { x: event.clientX, y: event.clientY };
    const id = nodeAt(event.target);
    const frame = isFrame(event.target) ? id : null;
    const origin =
      id === null || frame !== null || latest === null ? undefined : pointIn(latest.layout, id);
    if (id !== null && origin !== undefined) {
      gesture = { kind: "press", pointer: event.pointerId, id, start, origin, at: origin };
    } else {
      gesture = {
        kind: "pan",
        pointer: event.pointerId,
        start,
        from: viewport,
        moved: false,
        frame,
      };
      canvas.classList.add("panning");
    }
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (gesture.kind === "idle" || event.pointerId !== gesture.pointer) return;
    const dx = event.clientX - gesture.start.x;
    const dy = event.clientY - gesture.start.y;
    const moved = Math.hypot(dx, dy) >= SLOP;
    if (gesture.kind === "pan") {
      viewport = { ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy };
      gesture = { ...gesture, moved: gesture.moved || moved };
      applyViewport();
      return;
    }
    if (gesture.kind === "press" && !moved) return;
    const at = { x: gesture.origin.x + dx / viewport.k, y: gesture.origin.y + dy / viewport.k };
    gesture = { ...gesture, kind: "drag", at };
    request();
  });

  const release = (event: PointerEvent, commit: boolean): void => {
    if (gesture.kind === "idle" || event.pointerId !== gesture.pointer) return;
    const ended = gesture;
    gesture = { kind: "idle" };
    canvas.classList.remove("panning");
    request();
    if (!commit) return;
    if (ended.kind === "press") {
      commands.dispatch({ kind: "select", id: ended.id, extend: event.shiftKey });
    }
    if (ended.kind === "drag") commands.dispatch({ kind: "move", id: ended.id, to: ended.at });
    if (ended.kind === "pan" && !ended.moved) {
      commands.dispatch({
        kind: "select",
        id: ended.frame,
        extend: ended.frame !== null && event.shiftKey,
      });
    }
  };
  canvas.addEventListener("pointerup", (event) => release(event, true));
  canvas.addEventListener("lostpointercapture", (event) => release(event, false));

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const k = clamp(viewport.k * Math.exp(-event.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
      const scale = k / viewport.k;
      viewport = {
        k,
        x: cursor.x - (cursor.x - viewport.x) * scale,
        y: cursor.y - (cursor.y - viewport.y) * scale,
      };
      applyViewport();
    },
    { passive: false },
  );

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // The arrows of a focused radio button move its choice; they must not step the replay too.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (event.key === "ArrowLeft") commands.dispatch({ kind: "step", delta: -1 });
    if (event.key === "ArrowRight") commands.dispatch({ kind: "step", delta: 1 });
    if (event.key === "Escape") commands.dispatch({ kind: "escape" });
  });

  // The pointer is captured by the canvas, so the box is found under the pointer, not by target.
  canvas.addEventListener("dblclick", (event) => {
    const id = nodeAt(document.elementFromPoint(event.clientX, event.clientY));
    if (id !== null) commands.dispatch({ kind: "zoom", id });
  });

  return {
    show(state) {
      latest = state;
      request();
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The whole graph in view, no larger than 100 %, centred across and from the top. */
function fit(bounds: Box, width: number, height: number): Viewport {
  const pad = 40;
  const k = clamp(
    Math.min((width - 2 * pad) / bounds.width, (height - 2 * pad) / bounds.height),
    ZOOM_MIN,
    1,
  );
  return { k, x: (width - bounds.width * k) / 2 - bounds.x * k, y: pad - bounds.y * k };
}

function paint(layer: SVGGElement, items: readonly SceneItem[]): void {
  layer.replaceChildren(...items.map(draw));
  for (const callout of layer.querySelectorAll<SVGGElement>(".callout")) {
    const { x, y, width, height } = callout.getBBox();
    callout.prepend(
      svg("rect", { x: x - 8, y: y - 6, width: width + 16, height: height + 12, rx: 4 }),
    );
  }
}

function draw(item: SceneItem): SVGElement {
  switch (item.kind) {
    case "group": {
      const { box, label } = item;
      return svg(
        "g",
        { class: "group" },
        svg("rect", { class: "frame", ...box, rx: 12 }),
        svg("text", { class: "name", x: label.x + 4, y: label.y + label.height / 2 }, item.name),
      );
    }
    case "parent":
      return drawParent(item);
    case "box":
      return drawBox(item);
    case "line": {
      const d = `M ${item.points.map((p) => `${p.x} ${p.y}`).join(" L ")}`;
      const color = LINE_COLORS[item.look];
      return svg(
        "g",
        { class: `line ${item.look}` },
        svg("path", { class: "hit", d }),
        svg("path", {
          class: "stroke",
          d,
          "marker-end": "url(#arrow)",
          ...(color === null ? {} : { stroke: color }),
        }),
        item.label === null
          ? null
          : svg(
              "text",
              {
                class: "label",
                x: item.label.box.x + item.label.box.width / 2,
                y: item.label.box.y + item.label.box.height / 2,
                ...(color === null ? {} : { fill: color }),
              },
              item.label.text,
            ),
      );
    }
    case "callout": {
      const left = item.box.x + item.box.width + 22;
      return svg(
        "g",
        { class: "callout" },
        ...item.lines.map((line, index) =>
          svg("text", { x: left, y: item.box.y + 16 + index * 18 }, line),
        ),
      );
    }
    case "files":
      return drawFiles(item);
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

/**
 * A parent's frame in the tone its own files give it, solid, so it never reads as a group (dashed
 * grey) or as planned. A container has no file and no tone: plain ink. It carries the parent's id, so
 * a click on it selects the parent.
 */
function drawParent(item: Extract<SceneItem, { kind: "parent" }>): SVGElement {
  const row = item.tone === null ? null : rowOf(item.tone);
  const { box, label } = item;
  const paint =
    row === null ? {} : { fill: row.fill, stroke: row.stroke, "stroke-width": row.width };
  return svg(
    "g",
    { class: row === null ? "parent container" : "parent", "data-id": item.id },
    svg("rect", { class: "frame", ...box, rx: 10, ...paint }),
    item.selected
      ? svg("rect", {
          class: "ring",
          x: box.x - 6,
          y: box.y - 6,
          width: box.width + 12,
          height: box.height + 12,
          rx: 16,
        })
      : null,
    svg(
      "text",
      {
        class: "name",
        x: label.x + 4,
        y: label.y + label.height / 2,
        ...(row === null ? {} : { fill: row.text }),
      },
      item.id,
    ),
    svg("title", {}, item.id),
  );
}

function drawBox(item: Extract<SceneItem, { kind: "box" }>): SVGElement {
  const row = rowOf(item.tone);
  const { x, y, width, height } = item.box;
  const group = svg("g", { class: item.age === null ? "box" : "box recent", "data-id": item.id });
  if (item.age !== null) group.style.setProperty("--since", `${-item.age}ms`);
  const around = (gap: number, attrs: Attrs): SVGRectElement =>
    svg("rect", {
      x: x - gap,
      y: y - gap,
      width: width + 2 * gap,
      height: height + 2 * gap,
      rx: 8 + gap,
      ...attrs,
    });
  group.append(
    ...[
      item.age === null ? null : around(2, { class: "halo", stroke: row.stroke }),
      around(0, {
        class: "frame",
        fill: row.fill,
        stroke: row.stroke,
        "stroke-width": row.width,
        ...(row.dash === null ? {} : { "stroke-dasharray": row.dash }),
      }),
      item.selected ? around(7, { class: "ring" }) : null,
      item.current ? around(4, { class: "now", stroke: DANGER.stroke }) : null,
      svg("text", { class: "title", x: x + width / 2, y: y + 27, fill: row.text }, item.title),
      svg("text", { class: "caption", x: x + width / 2, y: y + 48, fill: row.text }, item.caption),
      svg("title", {}, item.id),
    ].filter((child) => child !== null),
  );
  return group;
}

/** The open files of a box. It carries the box's id, so a press on it drags or selects that box. */
function drawFiles(item: Extract<SceneItem, { kind: "files" }>): SVGElement {
  const { box, rows, id } = item;
  const left = box.x + FILE_CARD.inset;
  const right = box.x + box.width - FILE_CARD.inset;
  const rowY = (index: number): number =>
    box.y + FILE_CARD.heading + index * FILE_CARD.row + FILE_CARD.row / 2;
  const listed =
    rows.length === 0
      ? [svg("text", { class: "file", x: left, y: rowY(0) }, "ファイルなし（計画のみ）")]
      : rows.flatMap((row, index) => [
          svg("text", { class: "file", x: left, y: rowY(index) }, row.file),
          row.tested === null
            ? null
            : svg(
                "text",
                { class: row.tested ? "tested" : "untested", x: right, y: rowY(index) },
                row.tested ? "テスト済み" : "未テスト",
              ),
        ]);
  return svg(
    "g",
    { class: "files", "data-id": id },
    svg("rect", { class: "card", ...box, rx: 8 }),
    svg(
      "text",
      { class: "heading", x: left, y: box.y + FILE_CARD.heading / 2 + 2 },
      `${id} のファイル`,
    ),
    ...listed,
    svg("title", {}, "ダブルクリックか Escape で閉じます"),
  );
}

function swatch(row: ToneRow): SVGSVGElement {
  return svg(
    "svg",
    { width: 26, height: 16, viewBox: "0 0 26 16", "aria-hidden": "true" },
    svg("rect", {
      x: 2,
      y: 2,
      width: 22,
      height: 12,
      rx: 3,
      fill: row.fill,
      stroke: row.stroke,
      "stroke-width": Math.min(row.width, 2.5),
      ...(row.dash === null ? {} : { "stroke-dasharray": "3 2" }),
    }),
  );
}

function chip(row: ToneRow): HTMLElement {
  return html("span", { class: "chip" }, swatch(row), row.label);
}

function legend(): Node[] {
  const sample = (look: Look, text: string): HTMLElement => {
    const color = LINE_COLORS[look];
    return html(
      "span",
      { class: "chip" },
      svg(
        "svg",
        {
          width: 34,
          height: 12,
          viewBox: "0 0 34 12",
          "aria-hidden": "true",
          class: `line ${look}`,
        },
        svg("path", {
          class: "stroke",
          d: "M 2 6 L 30 6",
          "marker-end": "url(#arrow)",
          ...(color === null ? {} : { stroke: color }),
        }),
      ),
      text,
    );
  };
  return [
    html("strong", {}, "凡例"),
    ...TONES.map(chip),
    sample("flow", "遷移"),
    sample("observed", `${DRIFT.label}（コードにだけある遷移）`),
    sample("dep", "依存"),
    sample("trail", "反例の経路"),
  ];
}

type HeaderControls = {
  readonly labelsAlways: () => boolean;
  readonly setLabelsAlways: (checked: boolean) => void;
  readonly dismissed: () => TlcView | null;
  readonly dismiss: (tlc: TlcView) => void;
  readonly relayout: () => void;
};

function projectName(root: string): string {
  return (
    root
      .split(/[\\/]/)
      .filter((part) => part !== "")
      .at(-1) ?? root
  );
}

const CONNECTION: Readonly<Record<ViewState["connection"], string>> = {
  connecting: "● 接続中",
  live: "● live",
  offline: "● offline",
};

function headerOf(state: ViewState, commands: Commands, controls: HeaderControls): Content[] {
  const { graph, tlc } = state;
  const connection = html("span", { class: "connection" }, CONNECTION[state.connection]);
  if (state.connection === "offline") connection.style.color = DANGER.stroke;
  const items: Child[] = [
    html("span", { class: "project" }, graph === null ? "everypath" : projectName(graph.root)),
    connection,
  ];
  if (graph !== null) {
    const counts = headerCounts(graph);
    items.push(
      html(
        "span",
        { class: "counts" },
        `ノード ${counts.nodes} · 未レビュー ${counts.unreviewed} · 脆弱性 ${counts.vulnerable} · 性質違反 ${counts.violated}`,
      ),
    );
    const stale = graph.properties.filter((p) => p.staleModel === true).length;
    if (stale > 0)
      items.push(html("span", { class: "status" }, `古いモデルに対する結果 ${stale} 件`));
  }
  items.push(tlcStatus(tlc, graph === null ? 0 : violated(graph).length));
  items.push(
    html(
      "span",
      { class: "tools" },
      button("全探索を実行", commands.runTlc, graph === null || tlc.kind === "running"),
      button("整列し直す", controls.relayout, graph === null),
      checkbox("依存を表示", state.showDeps, () => commands.dispatch({ kind: "toggle-deps" })),
      checkbox("ラベルを常に表示", controls.labelsAlways(), controls.setLabelsAlways),
    ),
  );
  if (tlc.kind === "error" && tlc !== controls.dismissed()) {
    items.push(message(`全探索できませんでした\n${tlc.message}`, () => controls.dismiss(tlc)));
  }
  if (state.notice !== null) {
    items.push(message(state.notice, () => commands.dispatch({ kind: "notice", text: null })));
  }
  return items.filter((item) => item !== null);
}

function tlcStatus(tlc: TlcView, violations: number): HTMLElement | null {
  switch (tlc.kind) {
    case "idle":
      return null;
    case "running":
      return html("span", { class: "status" }, html("span", { class: "spinner" }), "全探索中…");
    case "done": {
      const explored =
        tlc.states === null
          ? "全探索を終えました"
          : `${tlc.states.toLocaleString("ja-JP")} 状態を探索`;
      const summary = `${explored}、違反 ${violations} 件`;
      return html(
        "span",
        { class: "status" },
        tlc.message === null ? summary : `${summary} · ${tlc.message}`,
      );
    }
    case "error":
      return html("span", { class: "status" }, "全探索できませんでした");
    default: {
      const _exhaustive: never = tlc;
      return _exhaustive;
    }
  }
}

function message(text: string, onClose: () => void): HTMLElement {
  const close = button("×", onClose);
  close.setAttribute("aria-label", "閉じる");
  return html(
    "div",
    { class: "message", role: "status" },
    html("span", { class: "text" }, text),
    close,
  );
}

function section(title: string, ...body: readonly Child[]): Content[] {
  return [html("h3", {}, title), ...body.filter((child) => child !== null)];
}

function list(items: readonly Child[]): HTMLElement {
  return html("ul", {}, ...items.map((item) => html("li", {}, item)));
}

function formatTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString("ja-JP");
}

function panelOf(state: ViewState, commands: Commands): Content[] {
  const { graph, selection } = state;
  if (graph === null) return [html("p", { class: "hint" }, "サーバーから図を受け取っています…")];
  if (selection.kind === "many") return manyOf(state, graph, selection.ids, commands);
  const node =
    selection.kind === "node" ? graph.nodes.find((n) => n.id === selection.id) : undefined;
  if (node === undefined) {
    return [
      html(
        "p",
        { class: "hint" },
        "箱を選ぶと、ここに詳細が出ます。Shift+クリックで複数を選べます。",
      ),
      html(
        "p",
        { class: "hint" },
        "箱はドラッグで動かせます。背景のドラッグで画面を動かし、ホイールで拡大と縮小をします。",
      ),
      html(
        "p",
        { class: "hint" },
        "箱をダブルクリックすると中のファイルが開きます。もう一度ダブルクリックするか Escape で閉じます。",
      ),
    ];
  }
  return [
    html("h2", {}, node.id),
    isContainer(node)
      ? html("span", { class: "chip" }, "中の状態を囲む枠（ファイルなし）")
      : chip(rowOf(toneOf(node, graph.properties))),
    html(
      "div",
      { class: "tabs" },
      toggle("詳細", state.panelTab === "detail", () =>
        commands.dispatch({ kind: "tab", panel: "detail" }),
      ),
      toggle("モデル", state.panelTab === "model", () =>
        commands.dispatch({ kind: "tab", panel: "model" }),
      ),
    ),
    ...(state.panelTab === "model"
      ? modelOf(state, node, commands)
      : detailOf(state, graph, node, commands)),
  ];
}

/** The tab "詳細": the node as the scanner and the checkers know it, and what can be made of it. */
function detailOf(state: ViewState, graph: Graph, node: StateNode, commands: Commands): Content[] {
  const { status } = node;
  const touching = node.violations.flatMap((id) => graph.properties.filter((p) => p.id === id));
  const live = touching.filter(isLiveViolation);
  const guardOnly = touching.filter(isGuardOnly).length;
  const stale = touching.length - live.length - guardOnly;
  const notes = [
    ...(stale === 0 ? [] : [`古いモデルに対する結果 ${stale} 件`]),
    ...(guardOnly === 0 ? [] : [`ガードを無視したときだけの経路 ${guardOnly} 件`]),
  ];
  const tree = hierarchyOf(graph.nodes);
  const parent = tree.parentOf(node.id);
  const children = tree.childrenOf(node.id);
  const container = isContainer(node);
  return [
    node.desc === null ? null : html("p", {}, node.desc),
    children.length === 0
      ? null
      : html(
          "p",
          { class: "hint" },
          container
            ? "中の状態をまとめる枠です。遷移を書くには、この名前の @state を持つファイルを作ります。"
            : "この状態の @state-next は、中のすべての状態から出る遷移になります。",
        ),
    status.changedSinceReview
      ? html("p", { class: "alert" }, "承認時からの変更あり（hash 不一致）")
      : null,
    html(
      "dl",
      {},
      html("dt", {}, "ファイル"),
      html(
        "dd",
        {},
        ...(node.files.length === 0
          ? [container ? "なし（中の状態を囲む枠だけ）" : "なし（計画のみ）"]
          : node.files.map((file) => html("div", { class: "mono" }, file))),
      ),
      ...(parent === null ? [] : [html("dt", {}, "親"), html("dd", {}, parent)]),
      ...(children.length === 0 ? [] : [html("dt", {}, "子"), html("dd", {}, children.join("、"))]),
      html("dt", {}, "グループ"),
      html("dd", {}, node.group ?? "なし"),
      html("dt", {}, "最終変更"),
      html("dd", {}, formatTime(node.lastChangedAt)),
      html("dt", {}, "テスト"),
      html("dd", {}, status.tested ? "テスト済み" : "未テスト"),
      html("dt", {}, "スキャン"),
      html("dd", {}, node.findings.length === 0 ? "検出なし" : `検出 ${node.findings.length} 件`),
      html("dt", {}, "性質"),
      html(
        "dd",
        {},
        `${live.length === 0 ? "違反なし" : `違反 ${live.length} 件`}${notes.length === 0 ? "" : `（${notes.join("、")}）`}`,
      ),
      html("dt", {}, "証明"),
      html(
        "dd",
        {},
        `${PROOF[status.proof]}${status.requireProof && status.proof !== "passed" ? "（証明必須）" : ""}`,
      ),
    ),
    container
      ? null
      : html(
          "div",
          { class: "actions" },
          status.reviewed ? null : button("仕様を承認", () => commands.approve(node)),
          status.reviewed || status.changedSinceReview
            ? button("承認を取り消す", () => commands.revoke(node))
            : null,
        ),
    ...driftOf(state, graph, node, commands),
    ...generateOf("指示を生成", state, graph, [node.id], commands),
    ...section(
      "仕様",
      node.spec.length === 0
        ? html("p", { class: "hint" }, "@state-spec の記述はありません")
        : list(node.spec.map((line) => html("code", {}, line))),
    ),
    ...(touching.length === 0
      ? []
      : section("性質違反と反例", ...touching.flatMap((p) => propertyOf(p, state, commands)))),
    ...(node.findings.length === 0
      ? []
      : section(
          "検出",
          list(
            node.findings.map((finding) =>
              html(
                "span",
                {},
                `[${SEVERITY[finding.severity]}] ${finding.rule}: ${finding.message} `,
                html(
                  "span",
                  { class: "mono" },
                  finding.line === null ? finding.file : `${finding.file}:${finding.line}`,
                ),
              ),
            ),
          ),
        )),
    ...(node.risks.length === 0
      ? []
      : section(
          "リスク（AI の自己申告）",
          list(
            node.risks.map((risk) =>
              html("span", {}, `${risk.message} `, html("span", { class: "mono" }, risk.file)),
            ),
          ),
        )),
  ].filter((child) => child !== null);
}

const DRIFT_FIXES: readonly (readonly [DriftFix, string])[] = [
  ["remove-call", "宣言が正しい（呼び出しを消す）"],
  ["add-next", "コードが正しい（@state-next を足す）"],
];

/** The node's calls no `@state-next` declares, each with the person's choice of the side that is right. */
function driftOf(state: ViewState, graph: Graph, node: StateNode, commands: Commands): Content[] {
  const drifts = driftsFrom(graph, node.id);
  if (drifts.length === 0) return [];
  return section(
    "コードにだけある遷移（乖離）",
    ...drifts.map((drift, index) => {
      const chosen = fixOf(state.decisions, drift);
      const choices = DRIFT_FIXES.map(([fix, text]) => {
        const input = html("input", { type: "radio", name: `drift-${index}`, value: fix });
        input.checked = chosen === fix;
        input.addEventListener("change", () => {
          if (input.checked) {
            commands.dispatch({ kind: "decide-drift", from: drift.from, to: drift.to, fix });
          }
        });
        return html("label", {}, input, text);
      });
      return html(
        "div",
        { class: "drift" },
        html("p", {}, `→ ${drift.to} `, html("span", { class: "mono" }, drift.via.join("、"))),
        ...choices,
      );
    }),
  );
}

/** One button per kind that applies to at least one of `ids`, then the instruction made last. */
function generateOf(
  title: string,
  state: ViewState,
  graph: Graph,
  ids: readonly StateName[],
  commands: Commands,
): Content[] {
  const ready = state.templates !== null;
  const kinds = PROMPT_KINDS.map((kind) => ({
    kind,
    count: promptTargets(kind, graph, ids).length,
    blocker: promptBlocker(kind, state, ids),
  })).filter(({ count }) => ids.length > 1 || count > 0);
  const buttons = kinds.map(({ kind, count, blocker }) =>
    button(
      ids.length > 1 ? `${promptLabel(kind)}（${count}/${ids.length}）` : promptLabel(kind),
      () => commands.generate(kind),
      count === 0 || !ready || blocker !== null,
    ),
  );
  const waiting = kinds.flatMap(({ kind, count, blocker }) =>
    count === 0 || blocker === null
      ? []
      : [html("p", { class: "hint" }, `${promptLabel(kind)}: ${blocker}`)],
  );
  return [
    ...section(
      title,
      ready ? null : html("p", { class: "hint" }, "テンプレートを読み込み中…"),
      html("div", { class: "actions" }, ...buttons),
      ...waiting,
    ),
    ...(state.prompt === null ? [] : promptOf(state.prompt, commands)),
  ];
}

/** The text on the clipboard, in a box to copy from by hand when the clipboard refused it. */
function promptOf(prompt: Prompt, commands: Commands): Content[] {
  const text = html("textarea", {
    id: "prompt-output",
    readonly: "",
    rows: 12,
    "aria-label": "生成した指示",
  });
  text.value = prompt.text;
  return section(
    "生成した指示",
    html("p", { class: "hint" }, `${promptLabel(prompt.kind)}（${prompt.targets.length} ノード）`),
    text,
    html(
      "div",
      { class: "actions" },
      button("もう一度コピー", () => commands.copy(prompt.text)),
      button("閉じる", () => commands.dispatch({ kind: "dismiss-prompt" })),
    ),
  );
}

/** Several boxes selected: who they are, and what can be made of all of them at once. */
function manyOf(
  state: ViewState,
  graph: Graph,
  ids: readonly StateName[],
  commands: Commands,
): Content[] {
  return [
    html("h2", {}, `${ids.length} 個を選択中`),
    html(
      "div",
      { class: "actions" },
      ...ids.map((id) =>
        button(id, () => commands.dispatch({ kind: "select", id, extend: false })),
      ),
    ),
    ...generateOf("まとめて生成", state, graph, ids, commands),
  ];
}

const MODEL_GROUPS = [
  ["init", "初期状態"],
  ["out", "出ていく遷移"],
  ["in", "入ってくる遷移"],
  ["property", "性質"],
] as const;

/** The tab "モデル": the TLA+ of the last model that mentions this box, as generated. */
function modelOf(state: ViewState, node: StateNode, commands: Commands): Content[] {
  const { model } = state;
  switch (model.kind) {
    case "unknown":
      return [html("p", { class: "hint" }, "読み込み中…")];
    case "missing":
      return [
        html("p", {}, model.message),
        html("p", { class: "hint" }, "ヘッダの「全探索を実行」を押すとモデルが作られます。"),
      ];
    case "loaded": {
      const children =
        state.graph === null ? [] : hierarchyOf(state.graph.nodes).childrenOf(node.id);
      if (children.length > 0) {
        return [
          html(
            "p",
            {},
            `親の状態は TLA+ の状態になりません。中の状態（${children.join("、")}）を選ぶと、そのモデルが出ます`,
          ),
        ];
      }
      const slice = modelSlice(model.text, node.id);
      if (slice === null) {
        return [
          html("p", {}, "この状態は最後に生成したモデルにありません。全探索を実行し直してください"),
        ];
      }
      return [
        html("p", {}, `TLA+ での名前: ${slice.ident}`),
        ...MODEL_GROUPS.flatMap(([kind, title]) => {
          const blocks = slice.blocks.filter((block) => block.kind === kind);
          return blocks.length === 0
            ? []
            : section(title, ...blocks.map((block) => html("pre", {}, block.text)));
        }),
        html(
          "div",
          { class: "actions" },
          button(
            "このモデルを説明させる",
            () => commands.generate("explain-model"),
            state.templates === null,
          ),
        ),
        ...(state.prompt === null ? [] : promptOf(state.prompt, commands)),
      ];
    }
    default: {
      const _exhaustive: never = model;
      return _exhaustive;
    }
  }
}

/** The bottom dock's two tabs. The queue counts the boxes that are not settled yet. */
function dockTabsOf(state: ViewState, commands: Commands): Content[] {
  const waiting = state.graph === null ? 0 : reviewQueue(state.graph).length;
  return [
    toggle(`未レビュー一覧（${waiting}）`, state.dockTab === "queue", () =>
      commands.dispatch({ kind: "tab", dock: "queue" }),
    ),
    toggle("変更ログ", state.dockTab === "log", () =>
      commands.dispatch({ kind: "tab", dock: "log" }),
    ),
  ];
}

function dockListOf(state: ViewState, jump: (id: StateName) => void): Content[] {
  const { graph } = state;
  if (graph === null) return [html("p", { class: "hint" }, "サーバーから図を受け取っています…")];
  if (state.dockTab === "queue") {
    const queue = reviewQueue(graph);
    return queue.length === 0
      ? [html("p", { class: "hint" }, "未レビューの箱はありません")]
      : queue.map(({ node, tone }) =>
          html(
            "div",
            { class: "row" },
            chip(rowOf(tone)),
            button(node.id, () => jump(node.id)),
          ),
        );
  }
  if (state.history.length === 0) return [html("p", { class: "hint" }, "まだ変更はありません")];
  return [...state.history].reverse().map((entry) => logRow(entry, graph, jump));
}

const REASON = new Map([
  ["serve", "起動"],
  ["scan", "スキャン"],
  ["watch", "保存"],
  ["rescan", "再スキャン"],
]);

/** One entry of the change log: when, why, then each box and arrow it added, removed or changed. */
function logRow(entry: HistoryEntry, graph: Graph, jump: (id: StateName) => void): HTMLElement {
  const node = (sign: string, id: StateName): HTMLElement =>
    html(
      "span",
      { class: "change" },
      `${sign} `,
      graph.nodes.some((n) => n.id === id) ? button(id, () => jump(id)) : id,
    );
  const edge = (sign: string, ref: EdgeRef): HTMLElement =>
    html(
      "span",
      { class: "change" },
      `${sign} ${ref.type === "dep" ? "依存" : "遷移"} ${ref.from} → ${ref.to}${ref.event === null ? "" : `（on:${ref.event}）`}`,
    );
  return html(
    "div",
    { class: "row" },
    html("span", { class: "time" }, formatClock(entry.at)),
    html("span", { class: "reason" }, REASON.get(entry.reason) ?? entry.reason),
    ...entry.added.map((id) => node("+", id)),
    ...entry.removed.map((id) => node("−", id)),
    ...entry.updated.map((id) => node("~", id)),
    ...entry.addedEdges.map((ref) => edge("+", ref)),
    ...entry.removedEdges.map((ref) => edge("−", ref)),
  );
}

function formatClock(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleTimeString("ja-JP");
}

/** A button that stays pressed while its tab is the one shown. */
function toggle(text: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const element = button(text, onClick);
  element.setAttribute("aria-pressed", String(pressed));
  return element;
}

function propertyOf(property: PropertyResult, state: ViewState, commands: Commands): Content[] {
  const title = html(
    "p",
    {},
    html("strong", {}, property.id),
    property.description === null ? null : `　${property.description}`,
  );
  const checker = html("p", { class: "checker" }, checkedByLabel(property));
  if (property.staleModel === true) {
    return [
      title,
      checker,
      html("p", { class: "stale" }, "古いモデルに対する結果（今のモデルでは確かめていません）"),
    ];
  }
  const tlc = tlcLines(property).map((line) => html("p", { class: "checker" }, line));
  if (isGuardOnly(property)) return [title, checker, ...tlc];
  const replay = replayOf(state);
  const playing = replay?.property.id === property.id ? replay : null;
  const traces = property.counterexamples.map((trace, index) => {
    const label = `反例 ${index + 1}（${trace.steps.length} 歩${trace.loopStart === null ? "" : "、繰り返しあり"}）`;
    const chosen = playing !== null && playing.trace === trace;
    const pick = button(
      label,
      () => commands.dispatch({ kind: "replay", target: { property: property.id, index } }),
      chosen,
    );
    return chosen ? html("div", {}, pick, ...replayControls(playing, commands)) : pick;
  });
  return [title, checker, ...tlc, html("div", { class: "actions" }, ...traces)];
}

function replayControls(replay: Replay, commands: Commands): Content[] {
  const { trace, step, current, loopStart } = replay;
  const last = trace.steps.length - 1;
  const vars = Object.entries(current.vars).map(([name, value]) => `${name} = ${value}`);
  return [
    html(
      "div",
      { class: "steps" },
      button("◀", () => commands.dispatch({ kind: "step", delta: -1 }), step === 0),
      html("span", { class: "mono" }, `step ${step + 1}/${trace.steps.length}`),
      button("▶", () => commands.dispatch({ kind: "step", delta: 1 }), step === last),
    ),
    html("p", {}, `状態: ${current.state}`),
    html("p", {}, `イベント: ${stepEvent(step, current.event)}`),
    html("p", { class: "vars" }, vars.length === 0 ? "変数なし" : vars.join(", ")),
    loopStart === null
      ? null
      : html(
          "p",
          {},
          `↺ 繰り返し: step ${loopStart + 1} から step ${trace.steps.length} までを繰り返します${step >= loopStart ? "（いまは繰り返しの中）" : ""}`,
        ),
    html(
      "ol",
      {},
      ...trace.steps.map((s, index) =>
        html(
          "li",
          {},
          index === step ? html("strong", {}, s.state) : s.state,
          s.event === null ? null : `（${s.event}）`,
        ),
      ),
    ),
    html("p", { class: "hint" }, "← → キーでも 1 歩ずつ進めます"),
  ].filter((child) => child !== null);
}
