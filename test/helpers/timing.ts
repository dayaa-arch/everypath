/**
 * The fastest of three timings of `work`, in ms, with the last result. A busy machine only slows a
 * run down, so the minimum is the closest to the code's own cost and keeps limits from failing under load.
 */
export function fastestOf<T>(work: () => T): { readonly ms: number; readonly result: T } {
  let best = Number.POSITIVE_INFINITY;
  const time = (): T => {
    const started = performance.now();
    const result = work();
    best = Math.min(best, performance.now() - started);
    return result;
  };
  time();
  time();
  const result = time();
  return { ms: best, result };
}
