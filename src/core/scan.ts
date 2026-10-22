import { createHash } from "node:crypto";
import { basename, posix, resolve } from "node:path";
import { type Notes, readNotes } from "./annotations.js";
import { sanitizeStateName } from "./expr.js";
import { type DeclaredFlow, type Flat, type FlatArc, type FlatModel, flatten } from "./flatten.js";
import {
  type Hierarchy,
  type HierarchyProblem,
  hierarchyOf,
  MAX_DEPTH,
  type ParentClaim,
  resolveHierarchy,
  type TreeNode,
} from "./hierarchy.js";
import { type ImportContext, resolveImports } from "./imports.js";
import { resolveNext, type VarTable } from "./model.js";
import { checkProperties, violationsOf } from "./properties.js";
import { navigationPaths, resolveRoute, routeTable } from "./routes.js";
import { withTlcResults } from "./tla/result.js";
import type {
  DepEdge,
  Drift,
  Edge,
  EdgeRef,
  EventName,
  Finding,
  FlowEdge,
  Graph,
  HistoryEntry,
  ModelVar,
  ObservedEdge,
  ScanWarning,
  StateName,
  StateNode,
  VarName,
} from "./types.js";
import {
  type Previous,
  readWorkspace,
  type Source,
  type Workspace,
  writeWorkspace,
} from "./workspace.js";

export type ScanOptions = {
  /** The clock for `generatedAt`, `lastChangedAt` and history. Tests pin it. */
  readonly now?: Date;
  readonly reason?: string;
};

const TEST_PATH = /(^|[/._-])(test|tests|spec|specs|__tests__)([/._-]|$)/i;
const INDEX_STEMS: ReadonlySet<string> = new Set(["index", "__init__", "main"]);

/** What one source file contributes, before it meets any other file. */
type FileFacts = {
  readonly path: string;
  /** Raw bytes: `hash` is defined over them, not over decoded text. */
  readonly bytes: Buffer;
  readonly lines: number;
  readonly isTest: boolean;
  readonly imports: readonly string[];
  /** Route paths the file navigates to with a literal. */
  readonly navigations: readonly string[];
  readonly notes: Notes;
  readonly warnings: readonly ScanWarning[];
};

/** A file that becomes part of a node, with that node's id. */
type Member = { readonly file: FileFacts; readonly id: StateName };

type Link = { readonly from: StateName; readonly to: StateName; readonly via: readonly string[] };

/**
 * SPEC §8. Reads the repository and folds it into the graph without writing anything. The TLA+ lane
 * starts here because `graph.json` holds property results but not the definitions they came from:
 * `flat` is the statechart with its properties as the checking lanes read it. `history` is the line a
 * scan would append; it does not depend on property results. TLC's last verdicts (`result.json`) are
 * an input like any other, so every graph carries them.
 */
export async function analyze(
  root: string,
  options: ScanOptions = {},
): Promise<{
  readonly graph: Graph;
  readonly flat: Flat;
  readonly history: HistoryEntry | null;
}> {
  const workspace = await readWorkspace(resolve(root));
  const context: ImportContext = {
    files: new Set(workspace.sources.map((source) => source.path)),
    aliases: workspace.config.aliases,
  };
  const facts = workspace.sources.map((source) => extractFacts(source, context));
  const { graph, flat } = fold(workspace, facts, options.now ?? new Date());
  return { graph, flat, history: diff(workspace.previous, graph, options.reason ?? "scan") };
}

/** SPEC §8. `analyze`, then writes `.everypath/graph.json` and, if something changed, `history.jsonl`. */
export async function scan(root: string, options: ScanOptions = {}): Promise<Graph> {
  return (await scanWithHistory(root, options)).graph;
}

/**
 * `scan` that also returns the history line, which the server sends as an event's `diff`. The graph
 * it writes is always the one it just analyzed, so no caller can write an older one.
 */
export async function scanWithHistory(
  root: string,
  options: ScanOptions = {},
): Promise<{ readonly graph: Graph; readonly history: HistoryEntry | null }> {
  const { graph, history } = await analyze(root, options);
  await writeWorkspace(graph.root, graph, history);
  return { graph, history };
}

/**
 * The server's rescan: `scanWithHistory`, except that a graph equal to `last` but for the times every
 * scan renews writes nothing and answers `null`. Nothing a viewer reads changed, so there is nothing
 * to send; the server's own writes to `review.json` and `result.json` end here when they come back.
 */
export async function rescanWithHistory(
  root: string,
  last: Graph,
  options: ScanOptions = {},
): Promise<{ readonly graph: Graph; readonly history: HistoryEntry | null } | null> {
  const { graph, history } = await analyze(root, options);
  if (lasting(graph) === lasting(last)) return null;
  await writeWorkspace(graph.root, graph, history);
  return { graph, history };
}

/**
 * The graph without `generatedAt` and the quick check's `checkedAt`, which is the same instant: what
 * every scan renews. A TLC verdict keeps the `checkedAt` of its run, so a new run still counts.
 */
function lasting(graph: Graph): string {
  const properties = graph.properties.map((result) =>
    result.checkedAt === graph.generatedAt ? { ...result, checkedAt: null } : result,
  );
  return JSON.stringify({ ...graph, generatedAt: null, properties });
}

/** One file's bytes to its facts. Pure and per file, so every cross-file decision waits for `fold`. */
function extractFacts({ path, bytes }: Source, context: ImportContext): FileFacts {
  const content = bytes.toString("utf8");
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const { notes, warnings } = readNotes(path, lines);
  return {
    path,
    bytes,
    lines: lines.length,
    isTest: TEST_PATH.test(path),
    imports: resolveImports(path, content, context),
    navigations: navigationPaths(path, content),
    notes,
    warnings,
  };
}

/**
 * SPEC §8.5 to 9, 11 and 12: every decision that needs more than one file. Pure, so the disk is read
 * before it and written after it.
 */
function fold(
  workspace: Workspace,
  facts: readonly FileFacts[],
  now: Date,
): { readonly graph: Graph; readonly flat: Flat } {
  const at = now.toISOString();
  const members = assignIds(
    facts.filter((file) => !file.notes.hidden && (workspace.config.includeTests || !file.isTest)),
    basename(workspace.root),
  );
  const model = collectModel(members);
  const flows = collectFlows(members, new Map(model.vars.map((decl) => [decl.name, decl])));
  const tree = collectTree(members, flows.edges);
  const hierarchy = hierarchyOf(tree.nodes);
  const deps = collectDeps(members);
  const built = collectNodes(members, tree.nodes, hierarchy, {
    tested: testedFiles(facts),
    findings: groupBy([...workspace.findings].sort(compareFindings), (finding) => finding.file),
    approvals: workspace.approvals,
    previous: workspace.previous,
    at,
  });
  const graphModel = {
    initial: tree.rootInitial,
    vars: model.vars,
    events: [...new Set([...model.events, ...flows.events])].sort(compareText),
  };
  const flat = flatten(
    { nodes: built, flows: flows.edges, deps, model: graphModel },
    workspace.properties,
  );
  const observed = collectObserved(members);
  const { flowEdges, observedEdges, drift } = checkDrift(flows.edges, observed.links, flat.model);
  const edges = [...deps, ...flowEdges, ...observedEdges].sort(compareEdges);
  const checked = checkProperties(flat, at);
  const properties = withTlcResults(flat, checked.properties, workspace.tlc);
  const violations = violationsOf(properties);
  const nodes = built.map((node) => ({ ...node, violations: violations.get(node.id) ?? [] }));
  const real = nodes.filter((node) => !node.status.planned && node.container !== true);

  const graph: Graph = {
    version: 1,
    generatedAt: at,
    root: workspace.root,
    findingsSource: workspace.findingsSource,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      tested: real.filter((node) => node.status.tested).length,
      untested: real.filter((node) => !node.status.tested).length,
      vuln: nodes.filter((node) => node.status.vuln).length,
      wip: nodes.filter((node) => node.status.wip).length,
      planned: nodes.filter((node) => node.status.planned).length,
      unreviewed: real.filter((node) => !node.status.reviewed).length,
    },
    nodes,
    edges,
    model: graphModel,
    properties,
    drift,
    warnings: [
      ...workspace.warnings,
      ...facts.flatMap((file) => file.warnings),
      ...model.warnings,
      ...flows.warnings,
      ...observed.warnings,
      ...tree.warnings,
      ...flat.ambiguous.map((id) => ambiguityWarning(id, hierarchy, tree.locate)),
      ...checked.warnings,
    ].sort(compareWarnings),
  };
  return { graph, flat };
}

function stemOf(path: string): string {
  return posix.basename(path, posix.extname(path));
}

function directoryOf(path: string): string {
  const directory = posix.dirname(path);
  return directory === "." ? "" : directory;
}

/** The file name, or the directory name for `index`, `__init__` and `main`. */
function nameId(path: string, rootName: string): StateName {
  if (!INDEX_STEMS.has(stemOf(path))) return sanitizeStateName(stemOf(path));
  const directory = directoryOf(path);
  return sanitizeStateName(directory === "" ? rootName : posix.basename(directory));
}

/** The whole path, so `src/a/utils.ts` and `lib/b/utils.ts` become `src_a_utils` and `lib_b_utils`. */
function pathId(path: string, rootName: string): StateName {
  if (!INDEX_STEMS.has(stemOf(path))) {
    return sanitizeStateName(path.slice(0, path.length - posix.extname(path).length));
  }
  const directory = directoryOf(path);
  return sanitizeStateName(directory === "" ? rootName : directory);
}

/**
 * A file's id is its `@state`, else a name taken from its path. Files that share a `@state` share a
 * node by design. Files without one that share a name across directories fall back to path ids.
 */
function assignIds(files: readonly FileFacts[], rootName: string): Member[] {
  const claims = files.map((file) => ({
    file,
    explicit: file.notes.name !== null,
    id: file.notes.name ?? nameId(file.path, rootName),
  }));
  const directoriesById = new Map<StateName, Set<string>>();
  for (const { file, explicit, id } of claims) {
    if (explicit) continue;
    directoriesById.set(id, (directoriesById.get(id) ?? new Set()).add(directoryOf(file.path)));
  }
  return claims.map(({ file, explicit, id }) => ({
    file,
    id: !explicit && (directoriesById.get(id)?.size ?? 0) > 1 ? pathId(file.path, rootName) : id,
  }));
}

function warningAt(file: string, line: number, message: string): ScanWarning {
  return { file, line, message, detail: null };
}

/** SPEC §8.8b. Where files disagree, the first file in path order wins and the later one is warned. */
function collectModel(members: readonly Member[]) {
  const warnings: ScanWarning[] = [];
  const declared = new Map<VarName, { file: string; line: number; decl: ModelVar }>();
  const events = new Set<EventName>();

  for (const { file } of members) {
    for (const { line, value } of file.notes.vars) {
      const first = declared.get(value.name);
      if (first === undefined) {
        declared.set(value.name, { file: file.path, line, decl: value });
      } else if (JSON.stringify(first.decl) !== JSON.stringify(value)) {
        warnings.push(
          warningAt(
            file.path,
            line,
            `変数 ${value.name} の宣言が ${first.file}:${first.line} と食い違います。先の宣言を使います`,
          ),
        );
      }
    }
    for (const event of file.notes.events) events.add(event.value);
  }
  return { vars: [...declared.values()].map(({ decl }) => decl), events, warnings };
}

/** Where a warning about a parent points: its own file, else the first `@state-parent` that names it. */
type Locate = (id: StateName) => { readonly file: string | null; readonly line: number | null };

/**
 * SPEC §5 `@state-parent` and `@state-initial`. Every state a file or a transition names, with the
 * parent and entry it ended up with. The rules are all in `resolveHierarchy`; this feeds it the claims
 * in file order and words what it did not use.
 */
function collectTree(members: readonly Member[], flows: readonly DeclaredFlow[]) {
  const claims = members.flatMap(({ file, id }): ParentClaim[] => {
    const claimed = file.notes.parent;
    return claimed === null
      ? []
      : [{ node: id, parent: claimed.value, file: file.path, line: claimed.line }];
  });
  const resolved = resolveHierarchy({
    nodes: [...members.map(({ id }) => id), ...flows.map(({ to }) => to)],
    parents: claims,
    initials: members.flatMap(({ file, id }) =>
      file.notes.initial === null ? [] : [{ node: id, file: file.path, line: file.notes.initial }],
    ),
  });
  const owned = new Set(members.map(({ id }) => id));
  const locate: Locate = (id) => {
    const own = members.find((member) => member.id === id);
    if (own !== undefined) return { file: own.file.path, line: null };
    const claim = claims.find((candidate) => candidate.parent === id);
    return { file: claim?.file ?? null, line: claim?.line ?? null };
  };
  const unclaimed = [...new Set(resolved.nodes.flatMap(({ parent }) => parent ?? []))]
    .filter((id) => !owned.has(id))
    .sort(compareText);
  return {
    nodes: resolved.nodes,
    rootInitial: resolved.rootInitial,
    locate,
    warnings: [
      ...resolved.problems.map(describeProblem),
      ...unclaimed.map((id) => {
        const { file, line } = locate(id);
        return {
          file,
          line,
          message: `${id} を @state で名乗るファイルがありません。中の状態を囲む枠だけを描きます。${id} に遷移を書くなら、そのファイルに @state ${id} を書いてください`,
          detail: null,
        };
      }),
    ],
  };
}

function describeProblem(problem: HierarchyProblem): ScanWarning {
  switch (problem.kind) {
    case "parent-conflict": {
      const { kept, dropped } = problem;
      return warningAt(
        dropped.file,
        dropped.line,
        `${dropped.node} の @state-parent が ${kept.file}:${kept.line} の ${kept.parent} と食い違います。先の ${kept.parent} を使います`,
      );
    }
    case "parent-cycle": {
      const [claim] = problem.claims;
      return warningAt(
        claim.file,
        claim.line,
        `@state-parent が輪になっています（${problem.members.join(" → ")}）。この輪の親は使いません`,
      );
    }
    case "parent-too-deep":
      return warningAt(
        problem.claim.file,
        problem.claim.line,
        `${problem.claim.node} の入れ子が深すぎます（親は ${MAX_DEPTH} 段まで）。この @state-parent は使いません`,
      );
    case "initial-conflict": {
      const { kept, dropped, level } = problem;
      return warningAt(
        dropped.file,
        dropped.line,
        level === null
          ? `@state-initial が複数の状態にあります。先の ${kept.file} の ${kept.node} を使います`
          : `${level} の中に @state-initial が複数あります。先の ${kept.file} の ${kept.node} を使います`,
      );
    }
  }
}

/** A parent something enters, with several children and none marked: `flatten` enters them all. */
function ambiguityWarning(id: StateName, hierarchy: Hierarchy, locate: Locate): ScanWarning {
  const children = hierarchy.childrenOf(id).join("、");
  return {
    ...locate(id),
    message: `${id} の子（${children}）のどれにも @state-initial がありません。${id} への遷移はすべての子に入るとみなします。入る子に @state-initial を書いてください`,
    detail: null,
  };
}

/** One edge per `(from, to, text)`; every file that declares it goes to `via`. */
function collectFlows(members: readonly Member[], vars: VarTable) {
  const warnings: ScanWarning[] = [];
  const events = new Set<EventName>();
  const merged = new Map<string, { edge: Omit<DeclaredFlow, "via">; via: Set<string> }>();

  for (const { file, id } of members) {
    for (const decl of file.notes.nexts) {
      const resolved = resolveNext(decl, vars);
      if (resolved.problem !== null) {
        warnings.push({
          file: file.path,
          line: decl.line,
          message: resolved.problem.message,
          detail: resolved.problem.detail,
        });
      }
      if (resolved.event !== null) events.add(resolved.event);

      const key = JSON.stringify([id, decl.to, decl.text]);
      const known = merged.get(key);
      if (known !== undefined) {
        known.via.add(file.path);
      } else {
        merged.set(key, {
          edge: {
            type: "flow",
            from: id,
            to: decl.to,
            event: resolved.event,
            guard: resolved.guard,
            set: resolved.set,
            text: decl.text,
            declared: true,
          },
          via: new Set([file.path]),
        });
      }
    }
  }
  const edges = [...merged.values()].map(
    ({ edge, via }): DeclaredFlow => ({ ...edge, via: [...via].sort(compareText) }),
  );
  return { edges, events, warnings };
}

/** One link per `(from, to)`, in first-seen order. `via` is every file that gave the pair. */
function mergeLinks(
  entries: readonly { readonly from: StateName; readonly to: StateName; readonly file: string }[],
): Link[] {
  const merged = new Map<string, { from: StateName; to: StateName; via: Set<string> }>();
  for (const { from, to, file } of entries) {
    const key = JSON.stringify([from, to]);
    const known = merged.get(key);
    if (known !== undefined) known.via.add(file);
    else merged.set(key, { from, to, via: new Set([file]) });
  }
  return [...merged.values()].map(({ from, to, via }) => ({
    from,
    to,
    via: [...via].sort(compareText),
  }));
}

/** File-level imports folded into node-level deps. A node never depends on itself. */
function collectDeps(members: readonly Member[]): DepEdge[] {
  const nodeOf = new Map(members.map(({ file, id }) => [file.path, id]));
  const entries = members.flatMap(({ file, id }) =>
    file.imports.flatMap((target) => {
      const to = nodeOf.get(target);
      return to === undefined || to === id ? [] : [{ from: id, to, file: file.path }];
    }),
  );
  return mergeLinks(entries).map((link) => ({ type: "dep", ...link }));
}

/** SPEC §8.5. Literal navigations resolved through `@state-route`, from the node of the calling file. */
function collectObserved(members: readonly Member[]) {
  const routes = routeTable(
    members.flatMap(({ file, id }) =>
      file.notes.routes.map(({ line, value }) => ({
        file: file.path,
        line,
        route: value,
        state: id,
      })),
    ),
  );
  const entries = members.flatMap(({ file, id }) =>
    file.navigations.flatMap((path) => {
      const to = resolveRoute(routes.table, path);
      return to === null ? [] : [{ from: id, to, file: file.path }];
    }),
  );
  return { links: mergeLinks(entries), warnings: routes.warnings };
}

/**
 * Compares the code with the declaration on the arcs of the flat model: code shows no event or guard.
 * A call no arc takes is drift. A flow no call takes is only unobserved, because a missing call proves
 * nothing. An arc takes a call when it leaves a leaf inside the caller, under a `@state-next` whose
 * source holds the caller and whose target holds the callee, so a parent's transition an inner one
 * shadowed takes no call from that leaf. When the caller is already inside that target (a parent's
 * self-loop, a move up to an ancestor), the arc must land inside the callee: re-entering lands where
 * entering does. Without `@state-parent` this is `(from, to)` equality.
 */
function checkDrift(
  declared: readonly DeclaredFlow[],
  observed: readonly Link[],
  { arcs, hierarchy }: FlatModel,
) {
  const arcsOf = groupBy(arcs, (arc) => arc.declared);
  const bySource = groupBy(declared, (edge) => edge.from);
  const takes = (arc: FlatArc, { from, to }: Link): boolean =>
    hierarchy.contains(from, arc.from) &&
    (hierarchy.contains(arc.declared.to, from)
      ? hierarchy.contains(to, arc.to)
      : hierarchy.contains(arc.declared.to, to));
  const taken = new Set<DeclaredFlow>();
  const undeclared = observed.filter((link) => {
    const flows = [link.from, ...hierarchy.ancestorsOf(link.from)]
      .flatMap((source) => bySource.get(source) ?? [])
      .filter((edge) => (arcsOf.get(edge) ?? []).some((arc) => takes(arc, link)));
    for (const edge of flows) taken.add(edge);
    return flows.length === 0;
  });
  return {
    flowEdges: declared.map((edge): FlowEdge => ({ ...edge, observed: taken.has(edge) })),
    observedEdges: undeclared.map(
      (link): ObservedEdge => ({ type: "observed", ...link, declared: false, observed: true }),
    ),
    drift: undeclared
      .map((link): Drift => ({ kind: "observed-not-declared", ...link }))
      .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to)),
  };
}

/** Files a test imports, plus files that say `@state-tested`. Test files count whether or not they are nodes. */
function testedFiles(facts: readonly FileFacts[]): ReadonlySet<string> {
  const tested = new Set<string>();
  for (const file of facts) {
    if (file.notes.tested) tested.add(file.path);
    if (file.isTest) for (const target of file.imports) tested.add(target);
  }
  return tested;
}

/** What a node needs from outside its own files. */
type NodeContext = {
  readonly tested: ReadonlySet<string>;
  readonly findings: ReadonlyMap<string, readonly Finding[]>;
  readonly approvals: ReadonlyMap<string, string>;
  readonly previous: Previous | null;
  readonly at: string;
};

/**
 * Every state of the tree. One no file claims has no files: a container when it has children, else a
 * flow target not written yet (`planned`).
 */
function collectNodes(
  members: readonly Member[],
  tree: readonly TreeNode[],
  hierarchy: Hierarchy,
  context: NodeContext,
): StateNode[] {
  const filesById = new Map(
    [...groupBy(members, ({ id }) => id)].map(([id, group]) => [id, group.map(({ file }) => file)]),
  );
  return tree
    .map((place) => {
      const files = filesById.get(place.id) ?? [];
      const container = files.length === 0 && hierarchy.childrenOf(place.id).length > 0;
      return buildNode(place, files, container, context);
    })
    .sort((a, b) => compareText(a.id, b.id));
}

function buildNode(
  { id, parent, initialChild }: TreeNode,
  files: readonly FileFacts[],
  container: boolean,
  context: NodeContext,
): StateNode {
  const hash = sha1(files.map((file) => file.bytes));
  const approved = context.approvals.get(id);
  const findings = files.flatMap((file) => context.findings.get(file.path) ?? []);
  const before = context.previous?.nodes.get(id);
  const descriptions = files.flatMap((file) => file.notes.desc);
  return {
    id,
    ...(parent === undefined ? {} : { parent }),
    ...(initialChild === undefined ? {} : { initialChild }),
    ...(container ? { container } : {}),
    group: files.find((file) => file.notes.group !== null)?.notes.group ?? null,
    desc: descriptions.length > 0 ? descriptions.join(" ") : null,
    files: files.map((file) => file.path),
    lines: files.reduce((sum, file) => sum + file.lines, 0),
    hash,
    status: {
      tested: files.length > 0 && files.every((file) => context.tested.has(file.path)),
      vuln: findings.length > 0,
      wip: files.some((file) => file.notes.wip),
      planned: files.length === 0 && !container,
      requireProof: files.some((file) => file.notes.requireProof),
      proof: "none",
      reviewed: approved === hash,
      changedSinceReview: approved !== undefined && approved !== hash,
    },
    spec: files.flatMap((file) => file.notes.specs),
    risks: files.flatMap((file) =>
      file.notes.risks.map((message) => ({ file: file.path, message })),
    ),
    findings,
    violations: [],
    lastChangedAt: before !== undefined && before.hash === hash ? before.lastChangedAt : context.at,
  };
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) groups.set(key(item), [item]);
    else group.push(item);
  }
  return groups;
}

function sha1(parts: readonly Buffer[]): string {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/** UTF-16 code unit order, never locale order, so one input gives one JSON on every machine. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEdges(a: Edge, b: Edge): number {
  const event = (edge: Edge): string => (edge.type === "flow" ? (edge.event ?? "") : "");
  const text = (edge: Edge): string => (edge.type === "flow" ? edge.text : "");
  return (
    compareText(a.type, b.type) ||
    compareText(a.from, b.from) ||
    compareText(a.to, b.to) ||
    compareText(event(a), event(b)) ||
    compareText(text(a), text(b))
  );
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    compareText(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareText(a.rule, b.rule) ||
    compareText(a.message, b.message)
  );
}

function compareWarnings(a: ScanWarning, b: ScanWarning): number {
  return compareText(a.file ?? "", b.file ?? "") || (a.line ?? 0) - (b.line ?? 0);
}

/**
 * History records no drift: the viewer and `readWorkspace` read flow and dep refs only. The file
 * change that makes or ends a drift is in `updated` already.
 */
function edgeRef(edge: Edge): EdgeRef[] {
  if (edge.type === "observed") return [];
  return [
    {
      type: edge.type,
      from: edge.from,
      to: edge.to,
      event: edge.type === "flow" ? edge.event : null,
    },
  ];
}

/** Flows that differ only in guard or set share a ref, so history records a change of shape, not of text. */
function refsByKey(refs: readonly EdgeRef[]): Map<string, EdgeRef> {
  return new Map(refs.map((ref) => [JSON.stringify([ref.type, ref.from, ref.to, ref.event]), ref]));
}

/** The history line for this scan, or `null` when no node or edge was added, removed or changed. */
function diff(previous: Previous | null, graph: Graph, reason: string): HistoryEntry | null {
  const before = previous?.nodes ?? new Map<StateName, { hash: string }>();
  const current = new Set(graph.nodes.map((node) => node.id));
  const added = graph.nodes.filter((node) => !before.has(node.id)).map((node) => node.id);
  const updated = graph.nodes
    .filter((node) => {
      const old = before.get(node.id);
      return old !== undefined && old.hash !== node.hash;
    })
    .map((node) => node.id);
  const removed = [...before.keys()].filter((id) => !current.has(id)).sort(compareText);

  const oldRefs = refsByKey(previous?.edges ?? []);
  const newRefs = refsByKey(graph.edges.flatMap(edgeRef));
  const addedEdges = [...newRefs].filter(([key]) => !oldRefs.has(key)).map(([, ref]) => ref);
  const removedEdges = [...oldRefs].filter(([key]) => !newRefs.has(key)).map(([, ref]) => ref);

  if ([added, removed, updated, addedEdges, removedEdges].every((list) => list.length === 0)) {
    return null;
  }
  return { at: graph.generatedAt, reason, added, removed, updated, addedEdges, removedEdges };
}
