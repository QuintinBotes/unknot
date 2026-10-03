// Shared helpers for the IaC adapter tests: load fixtures, run extract + link like the builder.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import adapter from '../../../../adapters/infrastructure/iac/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/iac/', import.meta.url));

export const read = (rel) => readFileSync(join(FIXTURES, rel), 'utf8');
export const readJSON = (rel) => JSON.parse(read(rel));

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** Run the adapter over a fixture subtree the way the builder does; paths are relative to `sub`. */
export function mapFixture(sub) {
  const base = join(FIXTURES, sub);
  const factsByFile = new Map();
  const files = new Map();
  for (const abs of walk(base)) {
    const path = relative(base, abs).split('\\').join('/');
    const entry = { path };
    const facts = adapter.extract(entry, readFileSync(abs, 'utf8'), {});
    facts.forEach(assertFact);
    factsByFile.set(path, facts);
    files.set(path, entry);
  }
  const linked = adapter.link({ files, factsByFile, options: {} });
  linked.forEach(assertFact);
  const all = [...factsByFile.values()].flat().concat(linked);
  return {
    all,
    factsByFile,
    // Several facts may describe one node (extract + link); merge their attrs the way the graph does.
    node: (id) => {
      const hits = all.filter((f) => f.kind === 'node' && f.id === id);
      return hits.length ? { ...hits[0], attrs: Object.assign({}, ...hits.map((h) => h.attrs)) } : undefined;
    },
    nodes: (type) => all.filter((f) => f.kind === 'node' && f.type === type),
    edges: (type, from, to) => all.filter((f) => f.kind === 'edge' && (!type || f.type === type) && (!from || f.from === from) && (!to || f.to === to)),
  };
}
