import type { StateName } from "../core/types.js";

/** What a block of `Model.tla` is to the state being looked at. */
export type ModelBlock = {
  readonly kind: "init" | "out" | "in" | "property";
  /** The block as generated, comment lines included. */
  readonly text: string;
};

/** `\* S6 = ログイン`: how `generateTla` names a state in the comment above `States ==`. */
const STATE_COMMENT = /^\\\* (\S+) = (.*)$/;
const PROPERTY_COMMENT = "\\* everypath.properties.json";

/**
 * The TLA+ definitions that mention one state of the generated `Model.tla`: `Init` when it is an
 * entry, each action leaving it (a self-loop counts here only) and entering it, and each property
 * that names it. `null` when the model does not know the state, for instance because it was
 * generated before the state was added. Reads what `generateTla` writes (blocks apart by a blank
 * line, one `\* …` comment above each definition), not TLA+ in general.
 */
export function modelSlice(
  tla: string,
  id: StateName,
): { readonly ident: string; readonly blocks: readonly ModelBlock[] } | null {
  const text = tla.replace(/\r\n/g, "\n");
  const ident = identOf(text, id);
  if (ident === null) return null;
  const quoted = `"${ident}"`;
  const blocks = text
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/\n={4,}\s*$/, "").trim())
    .filter((block) => block.includes(quoted))
    .flatMap((block): ModelBlock[] => {
      // The header blocks (the name comments with `States ==`, `Events ==`, `TypeOK`…) name the
      // state too, but have none of the lines that make a block an Init, an action or a property.
      const kind = kindOf(
        block.split("\n").map((line) => line.trim()),
        ident,
      );
      return kind === null ? [] : [{ kind, text: block }];
    });
  return { ident, blocks };
}

function identOf(tla: string, id: StateName): string | null {
  for (const line of tla.split("\n")) {
    if (line.startsWith("States ==")) return null;
    const named = STATE_COMMENT.exec(line);
    if (named?.[2] === id) return named[1] ?? null;
  }
  return null;
}

function kindOf(lines: readonly string[], ident: string): ModelBlock["kind"] | null {
  if (lines[0]?.startsWith(PROPERTY_COMMENT)) return "property";
  if (lines.find((line) => !line.startsWith("\\*"))?.startsWith("Init ==")) return "init";
  if (lines.includes(`/\\ state = "${ident}"`)) return "out";
  if (lines.includes(`/\\ state' = "${ident}"`)) return "in";
  return null;
}
