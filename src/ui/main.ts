import type { PromptKind } from "../core/prompts.js";
import type { StateNode } from "../core/types.js";
import { parseLayout, toPersist } from "./layout.js";
import { parseHistory, parseTemplates } from "./parse.js";
import { mount } from "./render.js";
import { type Action, initialState, type ModelText, reduce } from "./state.js";
import type { Layout, ServerEvent } from "./wire.js";

const RETRY_MS = 2_000;

void main();

async function main(): Promise<void> {
  const saved = await loadLayout();
  let state = initialState(saved);
  let lastSaved = saved;
  let saving = false;
  const viewer = mount({
    dispatch,
    approve,
    revoke,
    runTlc,
    generate,
    copy: (text) => void copy(text),
  });
  viewer.show(state);
  connect();

  function dispatch(action: Action): void {
    const before = state;
    const next = reduce(state, action);
    if (next === state) return;
    state = next;
    viewer.show(state);
    void persist();
    if (before.panelTab !== "model" && next.panelTab === "model") void loadModel();
  }

  /** The server's first frame on every stream is the current graph, so a reconnect needs no catch-up. */
  function connect(): void {
    const source = new EventSource("/events");
    source.onmessage = (message) => {
      const event = readEvent(message.data);
      if (event === null) return;
      dispatch(event.type === "graph" ? { kind: "graph", event } : { kind: "tlc", event });
      if (event.type === "graph" && event.reason === "connect") {
        void Promise.all([loadHistory(), loadTemplates(), loadModel()]);
      }
      if (event.type === "tlc" && event.status !== "running") void loadModel();
    };
    source.onerror = () => {
      source.close();
      dispatch({ kind: "offline" });
      setTimeout(connect, RETRY_MS);
    };
  }

  /**
   * The only writer of layout.json. One PUT at a time; a refused or failed one is retried by the next
   * dispatch, and a successful one looks again for changes made while it was in flight.
   */
  async function persist(): Promise<void> {
    if (saving || state.graph === null) return;
    const body = toPersist({ saved: lastSaved, layout: state.layout, graph: state.graph });
    if (body === null) return;
    saving = true;
    const refused = await send("PUT", "/layout.json", body);
    saving = false;
    if (refused !== null) return;
    lastSaved = body;
    void persist();
  }

  /** The green arrives with the server's next graph event (SPEC §12.2). */
  async function approve(node: StateNode): Promise<void> {
    const path = `/review/${encodeURIComponent(node.id)}`;
    dispatch({ kind: "notice", text: await send("POST", path, { note: "", hash: node.hash }) });
  }

  async function revoke(node: StateNode): Promise<void> {
    dispatch({
      kind: "notice",
      text: await send("DELETE", `/review/${encodeURIComponent(node.id)}`),
    });
  }

  /** Progress arrives as tlc events; only a refusal (409) or a failure is answered here. */
  async function runTlc(): Promise<void> {
    dispatch({ kind: "notice", text: await send("POST", "/check/tlc", {}) });
  }

  /**
   * The reducer builds the text in the click's own task, and the clipboard write follows in that
   * same task: a browser allows it only while the click is still being handled.
   */
  function generate(kind: PromptKind): void {
    const before = state.prompt;
    dispatch({ kind: "generate", prompt: kind });
    if (state.prompt !== null && state.prompt !== before) void copy(state.prompt.text);
  }

  async function copy(text: string): Promise<void> {
    const count = state.prompt?.text === text ? `（${state.prompt.targets.length} ノード）` : "";
    const copied = await navigator.clipboard.writeText(text).then(
      () => true,
      () => copyBySelection(text),
    );
    dispatch({
      kind: "notice",
      text: copied
        ? `クリップボードにコピーしました${count}`
        : "クリップボードに書けませんでした。下の欄から写してください",
    });
  }

  async function loadHistory(): Promise<void> {
    const response = await get("/history.json");
    if (response?.ok !== true) return;
    dispatch({ kind: "history", entries: parseHistory(await response.json().catch(() => null)) });
  }

  async function loadTemplates(): Promise<void> {
    const response = await get("/templates.json");
    if (response?.ok !== true) return;
    const templates = parseTemplates(await response.json().catch(() => null));
    if (templates !== null) dispatch({ kind: "templates", templates });
  }

  async function loadModel(): Promise<void> {
    dispatch({ kind: "model", model: await readModel() });
  }
}

const GET_FAILED = "サーバーに届きませんでした。everypath serve が動いているか確かめてください";

function get(path: string): Promise<Response | null> {
  return fetch(path, { cache: "no-store" }).catch(() => null);
}

/** GET /tla/Model.tla: the text, or why there is none (404 before the first full search). */
async function readModel(): Promise<ModelText> {
  const response = await get("/tla/Model.tla");
  if (response === null) return { kind: "missing", message: GET_FAILED };
  const text = await response.text().catch(() => "");
  if (response.ok) return { kind: "loaded", text };
  const message = text.trim();
  return {
    kind: "missing",
    message: message === "" ? `サーバーが ${response.status} を返しました` : message,
  };
}

/** GET /layout.json through parseLayout. Retries until the server answers; a broken body is empty. */
async function loadLayout(): Promise<Layout> {
  for (;;) {
    const response = await fetch("/layout.json", { cache: "no-store" }).catch(() => null);
    if (response?.ok) return parseLayout(await response.json().catch(() => ({})));
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/**
 * One SSE `data:` line. Only the envelope is checked: the graph inside comes from the server that
 * served this page, built from the same types. A frame that is not an event is dropped.
 */
function readEvent(data: unknown): ServerEvent | null {
  if (typeof data !== "string") return null;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  return isServerEvent(event) ? event : null;
}

function isServerEvent(value: unknown): value is ServerEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if (value.type === "graph") {
    return "graph" in value && typeof value.graph === "object" && value.graph !== null;
  }
  return (
    value.type === "tlc" &&
    "status" in value &&
    (value.status === "running" || value.status === "done" || value.status === "error")
  );
}

/**
 * Every write carries `content-type: application/json` (the server refuses any other; the browser adds
 * Origin). Resolves null on 2xx, else the server's own message, or one of ours when it never answered.
 */
async function send(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<string | null> {
  try {
    const response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) return null;
    const text = (await response.text()).trim();
    return text === "" ? `サーバーが ${response.status} を返しました` : text;
  } catch {
    return GET_FAILED;
  }
}

/**
 * Some browsers deny `clipboard-write` to a page they embed while still honouring the older copy
 * command inside the same click, so that is tried before the person is asked to copy by hand.
 */
function copyBySelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
