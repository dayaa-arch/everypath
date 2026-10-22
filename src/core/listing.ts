/** A warning names at most this many states and counts the rest, so it stays one readable line. */
export const LISTED = 10;

/** The first `LISTED` of `items` joined by `separator`, then 「ほか N 件」 for the rest. */
export function listed(items: readonly string[], separator: string): string {
  if (items.length <= LISTED) return items.join(separator);
  return `${items.slice(0, LISTED).join(separator)}${separator}ほか ${items.length - LISTED} 件`;
}
