// Shared fixture loader for the generic adapter tests: walks a fixture project, runs
// extract() on every file the adapter claims, then link() over the per-file facts exactly
// as the builder would.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import adapter from '../../../../adapters/language/generic/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', '..', '..', 'fixtures', 'generic');

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Extract + link one fixture project. */
export function loadFixture(name) {
  const root = join(FIXTURES, name);
  const files = new Map();
  const factsByFile = new Map();
  for (const full of walk(root)) {
    const path = relative(root, full).split(sep).join('/');
    const text = readFileSync(full, 'utf8');
    const entry = { path, size: text.length, language: null, kind: 'source', blob: path };
    files.set(path, entry);
    const facts = adapter.extract(entry, text, { commit: 'test', options: {} });
    facts.forEach(assertFact);
    if (facts.length) factsByFile.set(path, facts);
  }
  const linked = adapter.link({ files, factsByFile, options: {}, resolve: null });
  linked.forEach(assertFact);
  const all = [...[...factsByFile.values()].flat(), ...linked];
  const node = (id) => all.find((f) => f.kind === 'node' && f.id === id);
  const edges = (type, from, to) => all.filter((f) => f.kind === 'edge' && f.type === type
    && (from === undefined || f.from === from) && (to === undefined || f.to === to));
  const hasEdge = (type, from, to) => edges(type, from, to).length > 0;
  return { root, files, factsByFile, linked, all, node, edges, hasEdge, text: (p) => readFileSync(join(root, p), 'utf8') };
}

/** 1-based line of the first line containing `needle`. */
export function lineOf(text, needle) {
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  return i + 1;
}

/** Deterministic PRNG (mulberry32) so fuzz failures reproduce. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
