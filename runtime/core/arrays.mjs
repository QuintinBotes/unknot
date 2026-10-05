// Array helpers that stay correct at repository scale. `a.push(...b)` and `Math.max(...b)`
// pass every element as a call argument and throw a RangeError beyond roughly 100k
// elements; at 100,000 files that silently dropped every cross-file link (benchmark run).

/** Append `items` to `target` in place; returns `target`. */
export function pushAll(target, items) {
  if (!items) return target;
  for (const x of items) target.push(x);
  return target;
}

/** Largest number in `values`, or `empty` when there are none. */
export function maxOf(values, empty = -Infinity) {
  let m = empty;
  let seen = false;
  for (const v of values) if (!seen || v > m) { m = v; seen = true; }
  return m;
}

/** Smallest number in `values`, or `empty` when there are none. */
export function minOf(values, empty = Infinity) {
  let m = empty;
  let seen = false;
  for (const v of values) if (!seen || v < m) { m = v; seen = true; }
  return m;
}
