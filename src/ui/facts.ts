import type { Graph, PropertyResult, StateName, StateNode } from "../core/types.js";
import type { Selection } from "./state.js";

// Reads of the graph and the selection that state.ts, view.ts, prompt.ts and render.ts share. It
// imports types only: state.ts imports prompt.ts, so prompt.ts cannot import state.ts back.

/** SPEC §11: a TLC verdict on a model that has changed since the run marks no node. */
export function isLiveViolation(property: PropertyResult): boolean {
  return property.result === "violated" && property.staleModel !== true;
}

/** The properties the node's `violations` name that are violated on the current model, in file order. */
export function liveViolations(graph: Graph, node: StateNode): readonly PropertyResult[] {
  return node.violations.flatMap((id) =>
    graph.properties.filter((property) => property.id === id && isLiveViolation(property)),
  );
}

/** The selected node ids, in the order they were picked. */
export function selectedIds(selection: Selection): readonly StateName[] {
  switch (selection.kind) {
    case "none":
      return [];
    case "node":
      return [selection.id];
    case "many":
      return selection.ids;
    default: {
      const _exhaustive: never = selection;
      return _exhaustive;
    }
  }
}
