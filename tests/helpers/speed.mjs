// Time limits in tests are set for a reference machine; a slower or busier one (a shared CI
// runner) gets proportionally more. The machine is measured once per test file with a fixed
// workload that uses none of Unknot's own code, so a regression in the code under test cannot
// raise its own limit. A real blow-up (quadratic work, a hang) still fails: it grows with the
// input, not by a constant factor.

const REFERENCE_MS = 12;

function work() {
  const text = 'const orders = items.filter((i) => i.total > 10).map((i) => ({ id: i.id, sum: i.total * 2 }));\n'.repeat(3000);
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z_]\w*|\d+|[^\s\w]/g)) n += m[0].length;
  const map = new Map();
  for (let i = 0; i < 200000; i++) map.set(`k${i % 5000}`, i);
  return n + map.size;
}

let factor = null;

/** How much slower this machine is than the reference (at least 1). */
export function slower() {
  if (factor === null) {
    work();
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      work();
      best = Math.min(best, performance.now() - t0);
    }
    factor = Math.max(1, best / REFERENCE_MS);
  }
  return factor;
}

/** A limit in milliseconds, scaled to this machine. */
export const limit = (ms) => Math.round(ms * slower());
