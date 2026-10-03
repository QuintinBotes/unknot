// Shared test plumbing: loads a fixture directory like the census would, runs extract on
// every file the adapter claims, links, and builds a Graph.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import adapter from '../../../../adapters/language/javascript/index.mjs';
import { matchAny } from '../../../../runtime/core/glob.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', '..', '..', 'fixtures', 'js');

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Reads every file under a fixture into a Map of repo-relative POSIX path to text. */
export function loadFixture(name) {
  const root = join(FIXTURES, name);
  const files = new Map();
  for (const full of walk(root)) files.set(relative(root, full).split('\\').join('/'), readFileSync(full, 'utf8'));
  return files;
}

export function censusEntry(path, text) {
  const isTest = /(\.(test|spec)\.|(^|\/)__tests__\/|(^|\/)tests?\/)/.test(path);
  return { path, size: text.length, language: null, kind: isTest ? 'test' : 'source', blob: String(text.length) };
}

/** Runs extract on a map of path to text and then link. Returns facts, per-file facts and a Graph. */
export function runAdapter(texts) {
  const files = new Map();
  const factsByFile = new Map();
  for (const [path, text] of [...texts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const entry = censusEntry(path, text);
    files.set(path, entry);
    if (!matchAny(path, adapter.capabilities.files)) continue;
    const facts = adapter.extract(entry, text, { options: {} });
    for (const f of facts) assertFact(f);
    factsByFile.set(path, facts);
  }
  const linked = adapter.link({ files, factsByFile, options: {} });
  for (const f of linked) assertFact(f);
  const all = [...factsByFile.values()].flat().concat(linked);
  return { files, factsByFile, linked, facts: all, graph: Graph.fromFacts(all) };
}

export function runFixture(name) {
  return runAdapter(loadFixture(name));
}

/** Extract a single in-memory file and return its facts. */
export function extractOne(path, text, kind = 'source') {
  const entry = { path, size: text.length, language: null, kind, blob: 'x' };
  return adapter.extract(entry, text, { options: {} });
}

export function moduleAttrs(facts, path) {
  return facts.find((f) => f.kind === 'node' && f.id === `module:${path}`).attrs;
}

export function fnAttrs(facts, id) {
  const n = facts.find((f) => f.kind === 'node' && f.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n.attrs;
}

export function edgeList(graph, type) {
  return graph.edges(type).map((e) => `${e.from} -> ${e.to}`).sort();
}
