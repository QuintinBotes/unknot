// Test helpers: load the k8s fixture tree as a fake census and run the adapter over it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import adapter from '../../../../adapters/infrastructure/k8s/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';

export const ROOT = fileURLToPath(new URL('../../../fixtures/k8s/', import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Census-like entries for every fixture file, with repo-relative POSIX paths. */
export function census() {
  return walk(ROOT).map((p) => ({ path: relative(ROOT, p).split(sep).join('/'), kind: 'config', size: statSync(p).size }));
}

export const read = (path) => readFileSync(join(ROOT, path), 'utf8');

export function extractFile(path) {
  const facts = adapter.extract({ path, kind: 'config' }, read(path), {});
  facts.forEach(assertFact);
  return facts;
}

export function extractAll() {
  const factsByFile = new Map();
  for (const e of census()) factsByFile.set(e.path, extractFile(e.path));
  return factsByFile;
}

export const flat = (m) => [...m.values()].flat();
export const nodes = (facts, type) => facts.filter((f) => f.kind === 'node' && (!type || f.type === type));
export const edges = (facts, type) => facts.filter((f) => f.kind === 'edge' && (!type || f.type === type));
export const node = (facts, id) => {
  const hits = facts.filter((f) => f.kind === 'node' && f.id === id);
  // Merge like the graph does so assertions see the combined attrs.
  return hits.length ? { ...hits[0], attrs: Object.assign({}, ...hits.map((h) => h.attrs)) } : undefined;
};
export const hasEdge = (facts, type, from, to) => facts.some((f) => f.kind === 'edge' && f.type === type && f.from === from && f.to === to);

export function linked() {
  const factsByFile = extractAll();
  const files = new Map(census().map((e) => [e.path, e]));
  const out = adapter.link({ files, factsByFile, options: {} });
  out.forEach(assertFact);
  return [...flat(factsByFile), ...out];
}
