#!/usr/bin/env node
// Cross-command consistency over one mapped repository: runs graph cycles, diagnose, decompose
// (dry run), the MCP graph_query and the API check against the shared derived facts, and prints
// every place they disagree. Exit status 1 when any do. Map the repository first
// (`unknot map`); diagnose records its findings in that repository's .unknot store, so run
// this on a copy, like scripts/dogfood.mjs.
//
// With --work DIR it instead checks the repositories scripts/accuracy.mjs maps into DIR
// (DIR/<name>@<sha>/src, the --work directory of that script): every repository of
// scripts/corpus.json (or --corpus FILE) not marked large, or with --quick the quick corpus, the
// same selection accuracy.mjs makes. That is the release gate and the scheduled quality run.
// Those checkouts are disposable, so they are checked in place. Exit status 1 when any
// repository disagrees or a selected one was not mapped (named, never skipped).
//
// Usage: node scripts/consistency.mjs <repo-path>
//        node scripts/consistency.mjs --work <accuracy work directory> [--quick] [--corpus FILE]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = () => {
  process.stderr.write('usage: node scripts/consistency.mjs <repo-path>   (the repository must have been mapped: unknot map)\n       node scripts/consistency.mjs --work <accuracy work directory> [--quick] [--corpus FILE]\n');
  process.exit(2);
};

const w = process.argv.indexOf('--work');
if (w !== -1 && !process.argv[w + 1]) usage();
const c = process.argv.indexOf('--corpus');
if (c !== -1 && !process.argv[c + 1]) usage();
let roots;
let failed = false;
if (w !== -1) {
  const work = resolve(process.argv[w + 1]);
  const corpus = JSON.parse(readFileSync(c !== -1 ? resolve(process.argv[c + 1]) : join(dirname(fileURLToPath(import.meta.url)), 'corpus.json'), 'utf8'));
  const quick = process.argv.includes('--quick');
  roots = [];
  for (const r of corpus.repositories.filter((x) => (quick ? x.quick : !x.large))) {
    const root = join(work, `${r.name}@${r.sha.slice(0, 12)}`, 'src');
    if (existsSync(join(root, '.unknot'))) roots.push(root);
    else {
      process.stdout.write(`MISSING ${r.name}: not mapped (no .unknot store in ${root}); map it with scripts/accuracy.mjs --work ${work}\n`);
      failed = true;
    }
  }
} else {
  if (!process.argv[2] || !existsSync(resolve(process.argv[2], '.unknot'))) usage();
  roots = [resolve(process.argv[2])];
}

const { openProject } = await import('../runtime/context.mjs');
const { checkConsistency } = await import('../runtime/graph/consistency.mjs');
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
