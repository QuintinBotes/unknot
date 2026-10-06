#!/usr/bin/env node
// Cross-command consistency over one mapped repository: runs graph cycles, diagnose, decompose
// (dry run), the MCP graph_query and the API check against the shared derived facts, and prints
// every place they disagree. Exit status 1 when any do. Map the repository first
// (`unknot map`); diagnose records its findings in that repository's .unknot store, so run
// this on a copy, like scripts/dogfood.mjs.
//
// Usage: node scripts/consistency.mjs <repo-path>

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(resolve(root, '.unknot'))) {
  process.stderr.write('usage: node scripts/consistency.mjs <repo-path>   (the repository must have been mapped: unknot map)\n');
  process.exit(2);
}

const { openProject } = await import('../runtime/context.mjs');
const { checkConsistency } = await import('../runtime/graph/consistency.mjs');
const ctx = openProject(root);
if (!ctx.store.meta('generation')) {
  process.stderr.write('no graph: run unknot map first\n');
  process.exit(2);
}
const t0 = Date.now();
const { disagreements, counts } = await checkConsistency(ctx);
process.stdout.write(`looked at ${Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')} (${Date.now() - t0} ms)\n`);
if (!disagreements.length) process.stdout.write('no disagreement\n');
for (const d of disagreements) process.stdout.write(`DISAGREE [${d.check}] ${d.detail}\n`);
process.exit(disagreements.length ? 1 : 0);
