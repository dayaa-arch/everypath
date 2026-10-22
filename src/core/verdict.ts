import type { PropertyResult, ReviewMark } from "./types.js";

// Which property results a person has to act on. The exit code of `check`, the red boxes of the
// viewer and the marks of `export --mermaid` all read these two, so they never disagree. Loaded by
// the viewer too, so it reads nothing but types.

/**
 * A quick-check violation whose path TLC, on the model this graph describes, found no behavior to
 * take: it is open only with the guards ignored. `graph.json` still holds the quick check's verdict.
 */
export function isGuardOnly(property: PropertyResult): boolean {
  const { result, tlc } = property;
  return result === "violated" && tlc?.result === "ok" && tlc.staleModel !== true;
}

/** Violated on the current model, and not a path TLC cleared. */
export function isLiveViolation(property: PropertyResult): boolean {
  return property.result === "violated" && property.staleModel !== true && !isGuardOnly(property);
}

/**
 * What resolves a conflict. An unreadable record blocks the node whatever is approved after it, so
 * the reader is sent to that file; otherwise approving or revoking again settles it.
 */
export function conflictRemedy(review: { readonly conflict: readonly ReviewMark[] }): string {
  const unreadable = review.conflict.flatMap((mark) =>
    mark.kind === "unreadable" ? [mark.file] : [],
  );
  return unreadable.length > 0
    ? `読めない記録 ${unreadable.join("、")} を git で元に戻すか消してください（承認し直しても解けません）`
    : "ビューアで内容を確かめ、承認し直すか取り消してください";
}
