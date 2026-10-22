import { parseEventName, parseStateName, parseVarDecl } from "./expr.js";
import { parseRoute, type Route } from "./routes.js";
import type { EventName, ModelVar, ParseWarning, ScanWarning, StateName } from "./types.js";

/** Lines read for tags (SPEC §5). */
const TAG_WINDOW = 60;

/** `@state` is the node-name tag only before whitespace, `:` or `：`, so `@state-next` is never taken for it. */
const TAG_PATTERN =
  /(?<![\p{L}\p{M}\p{Nd}_])(?<tag>@state-[\p{L}\p{Nd}_]+(?:-[\p{L}\p{Nd}_]+)*|@state(?=[\s:：]|$))/u;
const COMMENT_CLOSER = /\*\/|"""|'''/;
const NAME_SEPARATOR = /^\s*[:：]/;
const CLAUSE_MARKER = /\s(?<key>on|if|set):/g;
const MARKERS = ["on", "if", "set"] as const;
type Marker = (typeof MARKERS)[number];

type Located<T> = { readonly line: number; readonly value: T };

/** One `@state-next` split into its clauses. Guard and assignment text is not parsed yet. */
export type NextDecl = {
  readonly line: number;
  /** Everything after the tag. Declarations with equal text are one edge. */
  readonly text: string;
  readonly to: StateName;
  readonly on: string | null;
  readonly guard: string | null;
  readonly set: string | null;
};

type Draft = {
  name: StateName | null;
  hidden: boolean;
  tested: boolean;
  wip: boolean;
  requireProof: boolean;
  /** Line of `@state-initial`. */
  initial: number | null;
  group: string | null;
  desc: string[];
  risks: string[];
  specs: string[];
  events: Located<EventName>[];
  vars: Located<ModelVar>[];
  nexts: NextDecl[];
  routes: Located<Route>[];
  /** `@state-parent`: the state this file's state is inside. Checked against the rest by `scan`. */
  parent: Located<StateName> | null;
};

/** What one file's annotations declare, before any of it is checked against the rest of the repository. */
export type Notes = {
  readonly [K in keyof Draft]: Draft[K] extends (infer Item)[] ? readonly Item[] : Draft[K];
};

type Report = (message: string, detail?: ParseWarning) => void;

type TagContext = {
  readonly draft: Draft;
  readonly value: string;
  readonly line: number;
  readonly report: Report;
};

type TagSpec = {
  readonly repeatable: boolean;
  readonly needsValue: boolean;
  readonly apply: (context: TagContext) => void;
};

const rejected = (tag: string, warning: ParseWarning): string =>
  `${tag} を解釈できません: ${warning.message}`;

/** A tag that only switches something on; any text after it is ignored. */
const flag = (apply: (draft: Draft, line: number) => void): TagSpec => ({
  repeatable: false,
  needsValue: false,
  apply: ({ draft, line }) => apply(draft, line),
});

/** A repeatable tag whose value is kept as written. */
const list = (key: "desc" | "risks" | "specs"): TagSpec => ({
  repeatable: true,
  needsValue: true,
  apply: ({ draft, value }) => {
    draft[key].push(value);
  },
});

const TAGS: ReadonlyMap<string, TagSpec> = new Map<string, TagSpec>([
  [
    "@state",
    {
      repeatable: false,
      needsValue: true,
      apply: ({ draft, value, report }) => {
        const name = parseStateName(value);
        if (name.ok) draft.name = name.value;
        else report(rejected("@state", name.warning), name.warning);
      },
    },
  ],
  [
    "@state-next",
    {
      repeatable: true,
      needsValue: true,
      apply: ({ draft, value, line, report }) => {
        const { target, clauses } = splitClauses(value);
        const to = parseStateName(target);
        if (!to.ok) {
          report(rejected("@state-next", to.warning), to.warning);
          return;
        }
        draft.nexts.push({
          line,
          text: value,
          to: to.value,
          on: clauses.on,
          guard: clauses.if,
          set: clauses.set,
        });
      },
    },
  ],
  [
    "@state-var",
    {
      repeatable: true,
      needsValue: true,
      apply: ({ draft, value, line, report }) => {
        const decl = parseVarDecl(value);
        if (decl.ok) draft.vars.push({ line, value: decl.value });
        else report(rejected("@state-var", decl.warning), decl.warning);
      },
    },
  ],
  [
    "@state-event",
    {
      repeatable: true,
      needsValue: true,
      apply: ({ draft, value, line, report }) => {
        let problem: ParseWarning | null = null;
        for (const part of value.split(",")) {
          const event = parseEventName(part);
          if (event.ok) draft.events.push({ line, value: event.value });
          else problem ??= event.warning;
        }
        if (problem !== null) report(rejected("@state-event", problem), problem);
      },
    },
  ],
  [
    "@state-route",
    {
      repeatable: true,
      needsValue: true,
      apply: ({ draft, value, line, report }) => {
        const route = parseRoute(value);
        if (route.ok) draft.routes.push({ line, value: route.value });
        else report(rejected("@state-route", route.warning), route.warning);
      },
    },
  ],
  [
    "@state-parent",
    {
      repeatable: false,
      needsValue: true,
      apply: ({ draft, value, line, report }) => {
        const parent = parseStateName(value);
        if (parent.ok) draft.parent = { line, value: parent.value };
        else report(rejected("@state-parent", parent.warning), parent.warning);
      },
    },
  ],
  [
    "@state-initial",
    flag((draft, line) => {
      draft.initial = line;
    }),
  ],
  [
    "@state-tested",
    flag((draft) => {
      draft.tested = true;
    }),
  ],
  [
    "@state-hidden",
    flag((draft) => {
      draft.hidden = true;
    }),
  ],
  [
    "@state-group",
    {
      repeatable: false,
      needsValue: true,
      apply: ({ draft, value }) => {
        draft.group = value;
      },
    },
  ],
  ["@state-desc", list("desc")],
  ["@state-risk", list("risks")],
  ["@state-spec", list("specs")],
  [
    "@state-status",
    {
      repeatable: false,
      needsValue: true,
      apply: ({ draft, value, report }) => {
        if (value === "wip" || value === "draft") draft.wip = true;
        else report(`@state-status は wip か draft です: ${value}`);
      },
    },
  ],
  [
    "@state-require",
    {
      repeatable: false,
      needsValue: true,
      apply: ({ draft, value, report }) => {
        if (value === "proof") draft.requireProof = true;
        else report(`@state-require は proof だけです: ${value}`);
      },
    },
  ],
]);

/** `lines` are the file's lines, already split. Only the first 60 are read. */
export function readNotes(
  file: string,
  lines: readonly string[],
): { readonly notes: Notes; readonly warnings: readonly ScanWarning[] } {
  const draft: Draft = {
    name: null,
    hidden: false,
    tested: false,
    wip: false,
    requireProof: false,
    initial: null,
    group: null,
    desc: [],
    risks: [],
    specs: [],
    events: [],
    vars: [],
    nexts: [],
    routes: [],
    parent: null,
  };
  const warnings: ScanWarning[] = [];
  const seen = new Set<string>();

  for (const [index, text] of lines.slice(0, TAG_WINDOW).entries()) {
    const found = TAG_PATTERN.exec(text);
    const tag = found?.groups?.tag;
    if (found === null || tag === undefined) continue;
    const line = index + 1;
    const report: Report = (message, detail) => {
      warnings.push({ file, line, message, detail: detail ?? null });
    };

    const spec = TAGS.get(tag);
    if (spec === undefined) {
      report(`未知のタグです: ${tag}`);
      continue;
    }
    if (!spec.repeatable && seen.has(tag)) {
      report(`${tag} は 1 ファイルに 1 回だけです`);
      continue;
    }
    const value = tagValue(tag, text.slice(found.index + found[0].length));
    if (spec.needsValue && value === "") {
      report(`${tag} に値がありません`);
      continue;
    }
    seen.add(tag);
    spec.apply({ draft, value, line, report });
  }

  return { notes: draft, warnings };
}

/** The text after the tag, up to a comment closer, without the `:` that may follow `@state`. */
function tagValue(tag: string, rest: string): string {
  const text = tag === "@state" ? rest.replace(NAME_SEPARATOR, "") : rest;
  const closer = text.search(COMMENT_CLOSER);
  return (closer < 0 ? text : text.slice(0, closer)).trim();
}

/**
 * `STATE [on:E] [if:G] [set:S]`. Each marker counts once, at its first occurrence; a repeat stays in
 * the clause before it and fails that clause's parse.
 */
function splitClauses(text: string): {
  readonly target: string;
  readonly clauses: Readonly<Record<Marker, string | null>>;
} {
  const markers = new Map<Marker, RegExpExecArray>();
  for (const match of text.matchAll(CLAUSE_MARKER)) {
    const key = MARKERS.find((marker) => marker === match.groups?.key);
    if (key !== undefined && !markers.has(key)) markers.set(key, match);
  }
  const ordered = [...markers];
  const clauses: Record<Marker, string | null> = { on: null, if: null, set: null };
  ordered.forEach(([key, match], index) => {
    const end = ordered[index + 1]?.[1].index ?? text.length;
    clauses[key] = text.slice(match.index + match[0].length, end).trim();
  });
  const target = text.slice(0, ordered[0]?.[1].index ?? text.length).trim();
  return { target, clauses };
}
