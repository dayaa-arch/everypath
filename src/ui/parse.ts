import { PROMPT_KINDS, type PromptKind, type PromptTemplates } from "../core/prompts.js";
import type { EdgeRef, HistoryEntry } from "../core/types.js";

// The two bodies the viewer reads besides the graph: `/history.json` and `/templates.json`. Both come
// from the server that served the page, but a person can edit `history.jsonl` and the templates by
// hand, so what does not have the expected shape is dropped here, before the reducer sees it.

type Json = { readonly [key: string]: unknown };

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** The entries of `/history.json` that are well formed, in the order sent. Anything else is `[]`. */
export function parseHistory(value: unknown): readonly HistoryEntry[] {
  return Array.isArray(value) ? value.flatMap((item) => parseEntry(item) ?? []) : [];
}

function parseEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) return null;
  const { at, reason, added, removed, updated } = value;
  const addedEdges = parseEdges(value.addedEdges);
  const removedEdges = parseEdges(value.removedEdges);
  if (typeof at !== "string" || typeof reason !== "string") return null;
  if (!isStrings(added) || !isStrings(removed) || !isStrings(updated)) return null;
  if (addedEdges === null || removedEdges === null) return null;
  // The ids are the server's own. The page cannot mint a StateName (core/expr is not importable here).
  return { at, reason, added, removed, updated, addedEdges, removedEdges } as HistoryEntry;
}

function parseEdges(value: unknown): readonly EdgeRef[] | null {
  if (!Array.isArray(value)) return null;
  const edges: EdgeRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { type, from, to, event = null } = item;
    if ((type !== "flow" && type !== "dep") || typeof from !== "string" || typeof to !== "string") {
      return null;
    }
    if (event !== null && typeof event !== "string") return null;
    edges.push({ type, from, to, event } as EdgeRef);
  }
  return edges;
}

/** `/templates.json` when it holds a text and a source for every kind, else `null`. */
export function parseTemplates(value: unknown): PromptTemplates | null {
  if (!isRecord(value)) return null;
  const entries: [PromptKind, PromptTemplates[PromptKind]][] = [];
  for (const kind of PROMPT_KINDS) {
    const template = value[kind];
    if (!isRecord(template)) return null;
    const { text, source } = template;
    if (typeof text !== "string" || (source !== "default" && source !== "override")) return null;
    entries.push([kind, { text, source }]);
  }
  // Every kind was read above, in PROMPT_KINDS order.
  return Object.fromEntries(entries) as PromptTemplates;
}
