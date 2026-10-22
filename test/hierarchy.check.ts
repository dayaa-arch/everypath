import type { parseStateName } from "../src/core/expr.js";
import type { Flat, FlatModel, LeafExpr } from "../src/core/flatten.js";
import type { checkProperties } from "../src/core/properties.js";
import type { generateTla } from "../src/core/tla/generate.js";
import type { Graph, Leaf, PropExpr, StateName } from "../src/core/types.js";

// Type-level only, like types.check.ts: `npm run typecheck` compiles it and `npm test` never loads it.
type Parsed<R extends { readonly ok: boolean }> =
  Extract<R, { readonly ok: true }> extends { readonly value: infer V } ? V : never;
type IsNever<T> = [T] extends [never] ? true : false;

declare const home: Parsed<ReturnType<typeof parseStateName>>;
declare const graph: Graph;
declare const flat: Flat;
declare const model: FlatModel;
declare const leaf: Leaf;
declare const unlowered: PropExpr;

export const ok1: Parameters<typeof checkProperties>[0] = flat;
export const ok2: Parameters<typeof generateTla>[0] = flat;
export const leafIsAState: StateName = leaf;
export const leafIsInhabited: IsNever<Leaf> = false;

// @ts-expect-error the quick check reads a flattened model, never the graph
export const rawToBfs: Parameters<typeof checkProperties>[0] = graph;
// @ts-expect-error TLA+ generation reads a flattened model, never the graph
export const rawToTla: Parameters<typeof generateTla>[0] = graph;
// @ts-expect-error a state name is not a leaf: only hierarchy.ts says which states are leaves
export const named: Leaf = home;
// @ts-expect-error an expression that has not been lowered still names states, not leaves
export const raw: LeafExpr = unlowered;
// @ts-expect-error a FlatModel is made by flattenModel alone: a literal lacks its brand
export const forged: FlatModel = {
  hierarchy: model.hierarchy,
  states: model.states,
  real: model.real,
  arcs: model.arcs,
  initial: model.initial,
  vars: model.vars,
  events: model.events,
  deps: model.deps,
  groups: model.groups,
};
