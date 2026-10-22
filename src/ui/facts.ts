import type { Drift, Graph, PropertyResult, StateName, StateNode } from "../core/types.js";
import { isLiveViolation } from "../core/verdict.js";
import type { DriftDecision, DriftFix, Selection } from "./state.js";

// Reads of the graph and the selection that state.ts, view.ts, prompt.ts and render.ts share. It
// imports no module of src/ui at run time: state.ts imports prompt.ts, so prompt.ts cannot import
// state.ts back.

/** The properties the node's `violations` name that are live violations, in file order. */
export function liveViolations(graph: Graph, node: StateNode): readonly PropertyResult[] {
  return node.violations.flatMap((id) =>
    graph.properties.filter((property) => property.id === id && isLiveViolation(property)),
  );
}

/** The drifts a node's code makes: the node is where both the call and `@state-next` live. */
export function driftsFrom(graph: Graph, id: StateName): readonly Drift[] {
  return graph.drift.filter((drift) => drift.from === id);
}

/** The side the person chose for this drift, or null before they choose. */
export function fixOf(
  decisions: readonly DriftDecision[],
  drift: Pick<Drift, "from" | "to">,
): DriftFix | null {
  return decisions.find((d) => d.from === drift.from && d.to === drift.to)?.fix ?? null;
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
