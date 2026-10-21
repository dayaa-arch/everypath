import { createHash } from "node:crypto";
import { basename, posix, resolve } from "node:path";
import { type Notes, readNotes } from "./annotations.js";
import { sanitizeStateName } from "./expr.js";
import { type ImportContext, resolveImports } from "./imports.js";
import { resolveNext, type VarTable } from "./model.js";
import { checkProperties, violationsOf } from "./properties.js";
import { withTlcResults } from "./tla/result.js";
import type {
  DepEdge,
  Edge,
  EdgeRef,
  EventName,
  Finding,
  FlowEdge,
  Graph,
  HistoryEntry,
  ModelVar,
  PropertiesFile,
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
  readonly notes: Notes;
  readonly warnings: readonly ScanWarning[];
};

/** A file that becomes part of a node, with that node's id. */
type Member = { readonly file: FileFacts; readonly id: StateName };

/**
 * SPEC §8. Reads the repository and folds it into the graph without writing anything. The TLA+ lane
 * starts here because `graph.json` holds property results but not the definitions they came from.
 * `history` is the line a scan would append; it does not depend on property results. TLC's last
 * verdicts (`result.json`) are an input like any other, so every graph carries them.
 */
export async function analyze(
  root: string,
  options: ScanOptions = {},
): Promise<{
  readonly graph: Graph;
  readonly properties: PropertiesFile;
  readonly history: HistoryEntry | null;
}> {
  const workspace = await readWorkspace(resolve(root));
  const context: ImportContext = {
    files: new Set(workspace.sources.map((source) => source.path)),
    aliases: workspace.config.aliases,
  };
  const facts = workspace.sources.map((source) => extractFacts(source, context));
  const graph = fold(workspace, facts, options.now ?? new Date());
  return {
    graph,
    properties: workspace.properties,
    history: diff(workspace.previous, graph, options.reason ?? "scan"),
  };
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
    notes,
    warnings,
  };
}

/**
 * SPEC §8.6 to 9, 11 and 12: every decision that needs more than one file. Pure, so the disk is read
 * before it and written after it.
 */
function fold(workspace: Workspace, facts: readonly FileFacts[], now: Date): Graph {
  const at = now.toISOString();
  const members = assignIds(
    facts.filter((file) => !file.notes.hidden && (workspace.config.includeTests || !file.isTest)),
    basename(workspace.root),
  );
  const model = collectModel(members);
  const flows = collectFlows(members, new Map(model.vars.map((decl) => [decl.name, decl])));
  const edges = [...collectDeps(members), ...flows.edges].sort(compareEdges);
  const built = collectNodes(members, flows.edges, {
    tested: testedFiles(facts),
    findings: groupBy([...workspace.findings].sort(compareFindings), (finding) => finding.file),
    approvals: workspace.approvals,
    previous: workspace.previous,
    at,
  });
  const graphModel = {
    initial: model.initial,
    vars: model.vars,
    events: [...new Set([...model.events, ...flows.events])].sort(compareText),
  };
  const shape = { nodes: built, edges, model: graphModel };
  const checked = checkProperties(shape, workspace.properties, at);
  const settled = withTlcResults(shape, workspace.properties, checked.properties, workspace.tlc);
  const violations = violationsOf(settled.properties);
  const nodes = built.map((node) => ({ ...node, violations: violations.get(node.id) ?? [] }));
  const real = nodes.filter((node) => !node.status.planned);

  return {
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
      planned: nodes.length - real.length,
      unreviewed: real.filter((node) => !node.status.reviewed).length,
    },
    nodes,
    edges,
    model: graphModel,
    properties: settled.properties,
    warnings: [
      ...workspace.warnings,
      ...facts.flatMap((file) => file.warnings),
      ...model.warnings,
      ...flows.warnings,
      ...checked.warnings,
      ...settled.warnings,
    ].sort(compareWarnings),
  };
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
  let initial: { id: StateName; file: string } | null = null;

  for (const { file, id } of members) {
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

    if (file.notes.initial === null) continue;
    if (initial === null) {
      initial = { id, file: file.path };
    } else if (initial.id !== id) {
      warnings.push(
        warningAt(
          file.path,
          file.notes.initial,
          `@state-initial が複数の状態にあります。先の ${initial.file} の ${initial.id} を使います`,
        ),
      );
    }
  }
  return {
    vars: [...declared.values()].map(({ decl }) => decl),
    events,
    initial: initial?.id ?? null,
    warnings,
  };
}

/** One edge per `(from, to, text)`; every file that declares it goes to `via`. */
function collectFlows(members: readonly Member[], vars: VarTable) {
  const warnings: ScanWarning[] = [];
  const events = new Set<EventName>();
  const merged = new Map<string, { edge: Omit<FlowEdge, "via">; via: Set<string> }>();

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
          },
          via: new Set([file.path]),
        });
      }
    }
  }
  const edges = [...merged.values()].map(
    ({ edge, via }): FlowEdge => ({ ...edge, via: [...via].sort(compareText) }),
  );
  return { edges, events, warnings };
}

/** File-level imports folded into node-level deps. A node never depends on itself. */
function collectDeps(members: readonly Member[]): DepEdge[] {
  const nodeOf = new Map(members.map(({ file, id }) => [file.path, id]));
  const merged = new Map<string, { from: StateName; to: StateName; via: Set<string> }>();
  for (const { file, id } of members) {
    for (const target of file.imports) {
      const to = nodeOf.get(target);
      if (to === undefined || to === id) continue;
      const key = JSON.stringify([id, to]);
      const known = merged.get(key);
      if (known !== undefined) known.via.add(file.path);
      else merged.set(key, { from: id, to, via: new Set([file.path]) });
    }
  }
  return [...merged.values()].map(({ from, to, via }) => ({
    type: "dep",
    from,
    to,
    via: [...via].sort(compareText),
  }));
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

/** A flow target no file claims becomes a node with no files: `planned`. */
function collectNodes(
  members: readonly Member[],
  flows: readonly FlowEdge[],
  context: NodeContext,
): StateNode[] {
  const filesById = new Map(
    [...groupBy(members, ({ id }) => id)].map(([id, group]) => [id, group.map(({ file }) => file)]),
  );
  for (const { to } of flows) {
    if (!filesById.has(to)) filesById.set(to, []);
  }
  return [...filesById]
    .map(([id, files]) => buildNode(id, files, context))
    .sort((a, b) => compareText(a.id, b.id));
}

function buildNode(id: StateName, files: readonly FileFacts[], context: NodeContext): StateNode {
  const hash = sha1(files.map((file) => file.bytes));
  const approved = context.approvals.get(id);
  const findings = files.flatMap((file) => context.findings.get(file.path) ?? []);
  const before = context.previous?.nodes.get(id);
  const descriptions = files.flatMap((file) => file.notes.desc);
  return {
    id,
    group: files.find((file) => file.notes.group !== null)?.notes.group ?? null,
    desc: descriptions.length > 0 ? descriptions.join(" ") : null,
    files: files.map((file) => file.path),
    lines: files.reduce((sum, file) => sum + file.lines, 0),
    hash,
    status: {
      tested: files.length > 0 && files.every((file) => context.tested.has(file.path)),
      vuln: findings.length > 0,
      wip: files.some((file) => file.notes.wip),
      planned: files.length === 0,
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

function edgeRef(edge: Edge): EdgeRef {
  return {
    type: edge.type,
    from: edge.from,
    to: edge.to,
    event: edge.type === "flow" ? edge.event : null,
  };
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
  const newRefs = refsByKey(graph.edges.map(edgeRef));
  const addedEdges = [...newRefs].filter(([key]) => !oldRefs.has(key)).map(([, ref]) => ref);
  const removedEdges = [...oldRefs].filter(([key]) => !newRefs.has(key)).map(([, ref]) => ref);

  if ([added, removed, updated, addedEdges, removedEdges].every((list) => list.length === 0)) {
    return null;
  }
  return { at: graph.generatedAt, reason, added, removed, updated, addedEdges, removedEdges };
}
