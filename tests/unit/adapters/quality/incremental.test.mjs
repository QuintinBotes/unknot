// The clone linker re-pairs only modules a change can reach, and its result equals a full link
// (#88, FR-001/FR-002). Random fingerprints over a small hash alphabet put many posting lists
// around MAX_POSTINGS (20), the bound a change can push a list over or under.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter, { EXTRACTOR as EX } from '../../../../adapters/quality/index.mjs';
import { prov } from '../../../../runtime/graph/facts.mjs';

/** mulberry32, so a failure reproduces. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const moduleFact = (path, fps) => ({ kind: 'node', id: `module:${path}`, type: 'module', name: path, path, attrs: { fingerprints: fps, fp_lines: 400 }, provenance: prov({ source_type: 'ast', source_ref: `${path}:1`, extractor: EX, confidence: 'medium' }) });
// A module is three segments drawn from a shared pool; a segment is ten consecutive hashes, so two
// modules holding one share a run of lines (a clone), and each hash's posting list is about as long
// as the number of modules holding its segment.
const fpsOf = (rnd, n, pool) => Array.from({ length: n }, () => Math.floor(rnd() * pool)).flatMap((seg, s) => Array.from({ length: 10 }, (_, i) => [seg * 100 + i, (s * 10 + i) * 2 + 1, (s * 10 + i) * 2 + 6]));

/** One link over `tree` (path → fingerprints), with or without incremental state. */
function link(tree, incremental) {
  const factsByFile = new Map(Object.entries(tree).map(([p, fps]) => [p, [moduleFact(p, fps.map((x) => [...x]))]]));
  const files = new Map(Object.keys(tree).map((p) => [p, { path: p, kind: 'source' }]));
  const stats = {};
  const out = adapter.link({ files, factsByFile, options: {}, stats, incremental });
  return { out: JSON.parse(JSON.stringify(out)), stats };
}

test('an incremental clone link equals a full one across random edits, deletions and additions', () => {
  let clones = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = prng(seed);
    const pool = 8 + Math.floor(rnd() * 6);
    let tree = {};
    for (let i = 0; i < 60; i++) tree[`m${i}.js`] = fpsOf(rnd, 3, pool);
    let saved = null;
    let prevTree = null;
    for (let round = 0; round < 4; round++) {
      const next = { ...tree };
      const changed = new Set();
      for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
        const p = `m${Math.floor(rnd() * 70)}.js`;
        changed.add(p);
        if (rnd() < 0.2 && next[p]) delete next[p];
        else next[p] = fpsOf(rnd, 3, pool);
      }
      const inc = saved && {
        changed,
        previous: saved,
        previousFacts: (p) => (prevTree[p] ? [moduleFact(p, prevTree[p])] : []),
        save(d) { this.data = d; },
      };
      const full = link(next, { changed: null, previous: null, previousFacts: () => [], save() {} });
      const got = inc ? link(next, inc) : full;
      assert.deepEqual(got.out, full.out, `seed ${seed} round ${round}`);
      clones += full.out.length;
      if (inc) assert.ok(got.stats.link.quality.relinked <= full.stats.link.quality.relinked);
      // The next round starts from what this one saved.
      const state = { changed: null, previous: null, previousFacts: () => [], save(d) { this.data = d; } };
      link(next, state);
      saved = JSON.parse(JSON.stringify(state.data));
      prevTree = next;
      tree = next;
    }
  }
  assert.ok(clones > 100, `the fixture makes clones (${clones})`);
});
