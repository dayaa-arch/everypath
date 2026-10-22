// No imports on purpose: the viewer (a browser) and the server (Node) both load this file, and
// test/ui-boundaries.test.ts fails if it ever reaches for either.

export const PROMPT_KINDS = [
  "fix-counterexample",
  "fix-drift",
  "write-tests",
  "draw-model",
  "propose-properties",
  "explain-model",
] as const;

export type PromptKind = (typeof PROMPT_KINDS)[number];

/** One template per kind, whole. `override` is `.everypath/templates/<kind>.md` replacing the shipped one. */
export type PromptTemplates = Readonly<
  Record<PromptKind, { readonly text: string; readonly source: "default" | "override" }>
>;

/** A text value, or a list of scopes a `{{#NAME}}` section repeats over (each item sees the outer names too). */
export type Scope = { readonly [name: string]: string | readonly Scope[] };

const COMMENT = /<!--[\s\S]*?-->/g;
/** A section tag alone on its line takes the line break with it. */
const TAG_ON_ITS_OWN_LINE = /^(\{\{[#^/]\w+\}\})\n/gm;

/**
 * A small Mustache: `{{NAME}}`, `{{#NAME}}…{{/NAME}}` (once per item of a list, once for a text that
 * is not empty) and `{{^NAME}}…{{/NAME}}` (once for an empty text or list). `<!-- -->` is dropped.
 * A name `scope` does not have stays as written, so a typo shows in the output. Values are never read
 * as templates: everything is replaced in one pass over the template.
 */
export function fillTemplate(template: string, scope: Scope): string {
  const prepared = template.replace(COMMENT, "").replace(TAG_ON_ITS_OWN_LINE, "$1");
  return render(prepared, scope)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function render(template: string, scope: Scope): string {
  // Made here, not shared: a section's inner text is rendered from inside this replace's callback.
  const token = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}|\{\{(\w+)\}\}/g;
  return template.replace(
    token,
    (
      whole: string,
      mark: string | undefined,
      sectionName: string | undefined,
      inner: string | undefined,
      variableName: string | undefined,
    ) => {
      const name = sectionName ?? variableName;
      if (name === undefined || !Object.hasOwn(scope, name)) return whole;
      const value = scope[name];
      if (value === undefined) return whole;
      if (mark === undefined) return typeof value === "string" ? value : whole;
      const body = inner ?? "";
      if (mark === "#") {
        if (typeof value !== "string") {
          return value.map((item) => render(body, { ...scope, ...item })).join("");
        }
        return value === "" ? "" : render(body, scope);
      }
      const empty = typeof value === "string" ? value === "" : value.length === 0;
      return empty ? render(body, scope) : "";
    },
  );
}
