import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/database/', import.meta.url));

/** Read a fixture as text. */
export function fixture(rel) {
  return readFileSync(join(FIXTURES, rel), 'utf8');
}

/** All fixture files under a directory, as sorted repo-style relative paths. */
export function fixtureTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(join(FIXTURES, dir), p).split('\\').join('/'));
    }
  };
  walk(join(FIXTURES, dir));
  return out;
}

/** Census-style file entry. */
export function entry(path) {
  return { path, size: 0, language: null, kind: 'source', blob: 'x' };
}

export const nodes = (facts, type) => facts.filter((f) => f.kind === 'node' && (!type || f.type === type));
export const edges = (facts, type) => facts.filter((f) => f.kind === 'edge' && (!type || f.type === type));
export const ids = (facts, type) => nodes(facts, type).map((f) => f.id).sort();

/** Seeded PRNG (mulberry32) so fuzz failures reproduce. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
