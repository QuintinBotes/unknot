#!/usr/bin/env node
// Cross-command consistency over one mapped repository: runs graph cycles, diagnose, decompose
// (dry run), the MCP graph_query and the API check against the shared derived facts, and prints
// every place they disagree. Exit status 1 when any do. Map the repository first
// (`unknot map`); diagnose records its findings in that repository's .unknot store, so run
// this on a copy, like scripts/dogfood.mjs.
//
// With --work DIR it instead checks every repository that scripts/accuracy.mjs mapped into DIR
// (DIR/<name>@<sha>/src, the --work directory of that script), which is the scheduled quality run.
// Those checkouts are disposable, so they are checked in place. Exit status 1 when any
// repository disagrees; 2 when none was mapped.
//
// Usage: node scripts/consistency.mjs <repo-path>
//        node scripts/consistency.mjs --work <accuracy work directory>

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const usage = () => {
  process.stderr.write('usage: node scripts/consistency.mjs <repo-path>   (the repository must have been mapped: unknot map)\n       node scripts/consistency.mjs --work <accuracy work directory>\n');
  process.exit(2);
};

const w = process.argv.indexOf('--work');
if (w !== -1 && !process.argv[w + 1]) usage();
let roots;
if (w !== -1) {
  const work = resolve(process.argv[w + 1]);
  roots = existsSync(work)
    ? readdirSync(work).sort().map((d) => join(work, d, 'src')).filter((d) => existsSync(join(d, '.unknot')))
    : [];
  if (!roots.length) {
    process.stderr.write(`no mapped repository under ${work}\n`);
    process.exit(2);
  }
} else {
  if (!process.argv[2] || !existsSync(resolve(process.argv[2], '.unknot'))) usage();
  roots = [resolve(process.argv[2])];
}

const { openProject } = await import('../runtime/context.mjs');
const { checkConsistency } = await import('../runtime/graph/consistency.mjs');
let failed = false;
for (const root of roots) {
  if (w !== -1) process.stdout.write(`== ${root}\n`);
  const ctx = openProject(root);
  if (!ctx.store.meta('generation')) {
    process.stderr.write(`no graph in ${root}: run unknot map first\n`);
    process.exit(2);
  }
  const t0 = Date.now();
  const { disagreements, counts } = await checkConsistency(ctx);
  process.stdout.write(`looked at ${Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')} (${Date.now() - t0} ms)\n`);
  if (!disagreements.length) process.stdout.write('no disagreement\n');
  for (const d of disagreements) process.stdout.write(`DISAGREE [${d.check}] ${d.detail}\n`);
  if (disagreements.length) failed = true;
}
process.exit(failed ? 1 : 0);
