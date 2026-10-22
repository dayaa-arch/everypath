import type { Leaf, NonEmpty, StateName, StateNode } from "./types.js";

// The one place that knows what `@state-parent` and a per-level `@state-initial` mean. It imports
// nothing but types, so the viewer may load it (test/ui-boundaries.test.ts).

/** A state may have this many ancestors: a tree four levels deep. Deeper is a typo or a cycle in the making. */
export const MAX_DEPTH = 3;

/** What graph.json keeps of the tree. A `StateNode` is one. */
export type TreeNode = Pick<StateNode, "id" | "parent" | "initialChild">;

/**
 * The tree of states, read-only and total: an unknown name has no leaf, no child and no ancestor.
 * Three questions carry meaning and each has one answer here: `within` (what a parent's name covers
 * in a property, and where a transition declared on it leaves from), `enter` (where a transition into
 * it lands) and `subtree` (what a dependency question about it covers). The rest is navigation.
 */
export type Hierarchy = {
  readonly has: (id: StateName) => boolean;
  /** Top-level states, in id order. */
  readonly roots: readonly StateName[];
  /** Every leaf, in id order: the states of the flat model. */
  readonly leaves: readonly Leaf[];
  readonly parentOf: (id: StateName) => StateName | null;
  /** In id order. Empty for a leaf. */
  readonly childrenOf: (id: StateName) => readonly StateName[];
  /** Nearest first. */
  readonly ancestorsOf: (id: StateName) => readonly StateName[];
  /** `outer` is `inner` or one of its ancestors. */
  readonly contains: (outer: StateName, inner: StateName) => boolean;
  /** The nearest state that is an ancestor of both, `null` for the top level. */
  readonly commonAncestor: (a: StateName, b: StateName) => StateName | null;
  readonly isLeaf: (id: StateName) => id is Leaf;
  /** The child entering `id` goes to: the one `@state-initial` marks, else the only child, else `null`. */
  readonly initialChild: (id: StateName) => StateName | null;
  /** The leaves at or under `id`, in id order. */
  readonly within: (id: StateName) => readonly Leaf[];
  /** The leaves a transition into `id` lands on, in id order. Never empty for a known name. */
  readonly enter: (id: StateName) => readonly Leaf[];
  /**
   * The states with several children and no `@state-initial` that entering `id` passes through, in id
   * order. `enter` lands on every child of each: a path is never hidden, and the warning names the fix.
   */
  readonly ambiguousEntries: (id: StateName) => readonly StateName[];
  /** `id` and every state under it, in id order. */
  readonly subtree: (id: StateName) => readonly StateName[];
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Each key's value computed once per tree: the questions are pure and asked once per edge. */
function memo<T>(compute: (id: StateName) => T): (id: StateName) => T {
  const known = new Map<StateName, T>();
  return (id) => {
    const cached = known.get(id);
    if (cached !== undefined) return cached;
    const value = compute(id);
    known.set(id, value);
    return value;
  };
}

/**
 * Builds the tree from the `parent` links. The scanner has validated them (`resolveHierarchy`), but a
 * hand-edited graph.json must not hang or overflow the viewer, so a link to an unknown state, to
 * itself, on a cycle or too deep is ignored here as well.
 */
export function hierarchyOf(nodes: readonly TreeNode[]): Hierarchy {
  const ids = [...new Set(nodes.map((node) => node.id))].sort(compare);
  const known = new Set(ids);
  const links = new Map<StateName, StateName>();
  const marks = new Map<StateName, StateName>();
  for (const { id, parent, initialChild } of nodes) {
    if (parent !== undefined && parent !== id && known.has(parent)) links.set(id, parent);
    if (initialChild !== undefined) marks.set(id, initialChild);
  }
  for (const id of onCycles(ids, links)) links.delete(id);
  cutTooDeep(ids, links);

  const children = new Map<StateName, StateName[]>();
  for (const id of ids) {
    const parent = links.get(id);
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const childrenOf = (id: StateName): readonly StateName[] => children.get(id) ?? [];
  const isLeaf = (id: StateName): id is Leaf => known.has(id) && !children.has(id);
  const leaves = ids.filter(isLeaf);
  const rank = new Map(leaves.map((leaf, index) => [leaf, index]));
  const inOrder = (found: readonly Leaf[]): readonly Leaf[] =>
    [...new Set(found)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

  const ancestorsOf = (id: StateName): readonly StateName[] => {
    const up: StateName[] = [];
    for (let at = links.get(id); at !== undefined; at = links.get(at)) up.push(at);
    return up;
  };
  const initialChild = (id: StateName): StateName | null => {
    const kids = childrenOf(id);
    const marked = marks.get(id);
    if (marked !== undefined && kids.includes(marked)) return marked;
    return kids.length === 1 ? (kids[0] ?? null) : null;
  };
  const within: (id: StateName) => readonly Leaf[] = memo((id) => {
    if (!known.has(id)) return [];
    return isLeaf(id) ? [id] : inOrder(childrenOf(id).flatMap(within));
  });
  const enter: (id: StateName) => readonly Leaf[] = memo((id) => {
    if (!known.has(id)) return [];
    if (isLeaf(id)) return [id];
    const mark = initialChild(id);
    return inOrder((mark === null ? childrenOf(id) : [mark]).flatMap(enter));
  });
  const ambiguousEntries: (id: StateName) => readonly StateName[] = memo((id) => {
    if (!known.has(id) || isLeaf(id)) return [];
    const mark = initialChild(id);
    if (mark !== null) return ambiguousEntries(mark);
    return [...new Set([id, ...childrenOf(id).flatMap(ambiguousEntries)])].sort(compare);
  });
  const subtree: (id: StateName) => readonly StateName[] = memo((id) =>
    known.has(id) ? [id, ...childrenOf(id).flatMap(subtree)].sort(compare) : [],
  );

  return {
    has: (id) => known.has(id),
    roots: ids.filter((id) => !links.has(id)),
    leaves,
    parentOf: (id) => links.get(id) ?? null,
    childrenOf,
    ancestorsOf,
    contains: (outer, inner) => outer === inner || ancestorsOf(inner).includes(outer),
    commonAncestor: (a, b) => {
      const above = new Set(ancestorsOf(a));
      return ancestorsOf(b).find((id) => above.has(id)) ?? null;
    },
    isLeaf,
    initialChild,
    within,
    enter,
    ambiguousEntries,
    subtree,
  };
}

/** The states whose parent chain comes back to themselves. */
function onCycles(
  ids: readonly StateName[],
  links: ReadonlyMap<StateName, StateName>,
): Set<StateName> {
  const cyclic = new Set<StateName>();
  const settled = new Set<StateName>();
  for (const start of ids) {
    const path: StateName[] = [];
    const seen = new Set<StateName>();
    let at: StateName | undefined = start;
    while (at !== undefined && !settled.has(at) && !seen.has(at)) {
      seen.add(at);
      path.push(at);
      at = links.get(at);
    }
    if (at !== undefined && seen.has(at)) {
      for (const member of path.slice(path.indexOf(at))) cyclic.add(member);
    }
    for (const id of path) settled.add(id);
  }
  return cyclic;
}

/**
 * Deletes from `links` (acyclic) each link that puts a state more than `MAX_DEPTH` below a root. Only
 * the shallowest layer that is too deep loses its links; what is under a cut state is measured again
 * from it. One pass from the roots down, so a chain costs its length. Returns the cut states, layer by
 * layer, each layer in id order.
 */
function cutTooDeep(ids: readonly StateName[], links: Map<StateName, StateName>): StateName[] {
  const children = new Map<StateName, StateName[]>();
  for (const id of ids) {
    const parent = links.get(id);
    if (parent === undefined) continue;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [id]);
    else siblings.push(id);
  }
  const cut: { readonly id: StateName; readonly layer: number }[] = [];
  const queue = ids.filter((id) => !links.has(id)).map((id) => ({ id, depth: 0, layer: 0 }));
  for (const { id, depth, layer } of queue) {
    for (const child of children.get(id) ?? []) {
      if (depth < MAX_DEPTH) {
        queue.push({ id: child, depth: depth + 1, layer });
        continue;
      }
      links.delete(child);
      cut.push({ id: child, layer: layer + 1 });
      queue.push({ id: child, depth: 0, layer: layer + 1 });
    }
  }
  return cut.sort((a, b) => a.layer - b.layer || compare(a.id, b.id)).map(({ id }) => id);
}

/** One file's `@state-parent`. */
export type ParentClaim = {
  readonly node: StateName;
  readonly parent: StateName;
  readonly file: string;
  readonly line: number;
};

/** One file's `@state-initial`, by the node the file belongs to. */
export type InitialClaim = {
  readonly node: StateName;
  readonly file: string;
  readonly line: number;
};

/** Why part of the annotations was not used. Each becomes one warning; none stops a scan (R-04). */
export type HierarchyProblem =
  | { readonly kind: "parent-conflict"; readonly kept: ParentClaim; readonly dropped: ParentClaim }
  | {
      /** A state that is its own ancestor. Every link on the cycle is dropped; a self-parent is a cycle of one. */
      readonly kind: "parent-cycle";
      readonly members: NonEmpty<StateName>;
      readonly claims: NonEmpty<ParentClaim>;
    }
  | { readonly kind: "parent-too-deep"; readonly claim: ParentClaim }
  | {
      /** Two siblings, or two top-level states, marked `@state-initial`. The first claim is kept. */
      readonly kind: "initial-conflict";
      /** The parent whose children disagree, `null` for the top level. */
      readonly level: StateName | null;
      readonly kept: InitialClaim;
      readonly dropped: InitialClaim;
    };

/**
 * SPEC §5 `@state-parent` and `@state-initial`, resolved together because the second is relative to
 * the first: `@state-initial` marks the entry of the level its state sits on. `nodes` is every state a
 * file or a transition names; a parent none of them is gets added. Claims are in file order and the
 * first wins wherever claims disagree. Total: nothing here throws.
 */
export function resolveHierarchy(input: {
  readonly nodes: Iterable<StateName>;
  readonly parents: readonly ParentClaim[];
  readonly initials: readonly InitialClaim[];
}): {
  readonly nodes: readonly TreeNode[];
  readonly rootInitial: StateName | null;
  readonly problems: readonly HierarchyProblem[];
} {
  const problems: HierarchyProblem[] = [];
  const kept = new Map<StateName, ParentClaim>();
  for (const claim of input.parents) {
    const first = kept.get(claim.node);
    if (first === undefined) kept.set(claim.node, claim);
    else if (first.parent !== claim.parent) {
      problems.push({ kind: "parent-conflict", kept: first, dropped: claim });
    }
  }
  const named = new Set(input.nodes);
  const ids = [...new Set([...named, ...[...kept.values()].map((claim) => claim.parent)])].sort(
    compare,
  );
  const links = new Map([...kept].map(([node, claim]) => [node, claim.parent] as const));

  const cyclic = onCycles(ids, links);
  const reported = new Set<StateName>();
  for (const id of ids) {
    if (!cyclic.has(id) || reported.has(id)) continue;
    const members: StateName[] = [];
    for (
      let at: StateName | undefined = id;
      at !== undefined && !reported.has(at);
      at = links.get(at)
    ) {
      reported.add(at);
      members.push(at);
    }
    const [first, ...rest] = members.sort(compare);
    const [claim, ...others] = members.flatMap((member) => kept.get(member) ?? []);
    if (first !== undefined && claim !== undefined) {
      problems.push({
        kind: "parent-cycle",
        members: [first, ...rest],
        claims: [claim, ...others],
      });
    }
  }
  for (const id of cyclic) links.delete(id);

  for (const id of cutTooDeep(ids, links)) {
    const claim = kept.get(id);
    if (claim !== undefined) problems.push({ kind: "parent-too-deep", claim });
  }

  const marks = new Map<StateName | null, InitialClaim>();
  for (const claim of input.initials) {
    const level = links.get(claim.node) ?? null;
    const first = marks.get(level);
    if (first === undefined) marks.set(level, claim);
    else if (first.node !== claim.node) {
      problems.push({ kind: "initial-conflict", level, kept: first, dropped: claim });
    }
  }

  const parents = new Set(links.values());
  return {
    nodes: ids
      .filter((id) => named.has(id) || parents.has(id))
      .map((id): TreeNode => {
        const parent = links.get(id);
        const mark = parents.has(id) ? marks.get(id)?.node : undefined;
        return {
          id,
          ...(parent === undefined ? {} : { parent }),
          ...(mark === undefined ? {} : { initialChild: mark }),
        };
      }),
    rootInitial: marks.get(null)?.node ?? null,
    problems,
  };
}
