// Temporary directories for tests. Every one is removed when the test process
// exits, whether the tests passed or failed. node --test runs each file in its
// own process, so this is per-file. UNKNOT_KEEP_TMP=1 keeps them and prints paths.
import { chmodSync, mkdtempSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const dirs = [];

function makeWritable(p) {
  try {
    const st = lstatSync(p);
    if (!st.isDirectory()) return;
    chmodSync(p, 0o700);
    for (const n of readdirSync(p)) makeWritable(join(p, n));
  } catch { /* already gone */ }
}

process.on('exit', () => {
  for (const d of dirs) {
    if (process.env.UNKNOT_KEEP_TMP === '1') { process.stderr.write(`kept ${d}\n`); continue; }
    try { rmSync(d, { recursive: true, force: true }); } catch {
      makeWritable(d);
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

/** Same as fs.mkdtempSync(prefix), but registers the directory for removal. */
export function mkTmp(prefix) {
  const d = mkdtempSync(prefix);
  dirs.push(d);
  return d;
}
