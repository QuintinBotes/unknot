// Structural checks for the architecture, domain, decomposition and frontend pattern cards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYAML } from '../../../runtime/core/yaml.mjs';
import { validateArtifact } from '../../../runtime/core/schema.mjs';

const PATTERNS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'patterns');
const CATEGORIES = ['architecture', 'domain', 'decomposition', 'frontend'];
const COUNTS = { architecture: 35, domain: 20, decomposition: 10, frontend: 9 };

const vocabulary = new Set();
for (const line of readFileSync(join(PATTERNS, 'README.md'), 'utf8').split('\n')) {
  if (!line.startsWith('| `')) continue;
  const first = line.split('|')[1];
  for (const m of first.matchAll(/`([a-z_]+\.[a-z0-9_]+)`/g)) vocabulary.add(m[1]);
}

const cards = [];
for (const cat of CATEGORIES) {
  for (const file of readdirSync(join(PATTERNS, cat)).filter((f) => f.endsWith('.yaml')).sort()) {
    cards.push({ cat, file, card: parseYAML(readFileSync(join(PATTERNS, cat, file), 'utf8')) });
  }
}

const conditions = (c) => [...c.applicability_signals, ...c.preconditions, ...c.contraindications];

test('vocabulary table was parsed', () => {
  assert.ok(vocabulary.size >= 75);
  assert.ok(vocabulary.has('boundary.shared_table_writers'));
});

test('card counts per category', () => {
  for (const cat of CATEGORIES) {
    assert.equal(cards.filter((c) => c.cat === cat).length, COUNTS[cat], cat);
  }
});

test('every card validates and file name, id and category agree', () => {
  const ids = new Set();
  for (const { cat, file, card } of cards) {
    const r = validateArtifact('pattern-card', card);
    assert.ok(r.valid, `${cat}/${file}: ${JSON.stringify(r.errors?.slice(0, 3))}`);
    assert.equal(card.category, cat, `${file} category`);
    assert.equal(card.id, `${cat}.${file.replace(/\.yaml$/, '')}`, `${file} id`);
    assert.ok(!ids.has(card.id), `duplicate id ${card.id}`);
    ids.add(card.id);
  }
});

test('every predicate metric is in the README vocabulary', () => {
  for (const { card } of cards) {
    for (const cond of conditions(card)) {
      if (!cond.predicate) continue;
      assert.ok(vocabulary.has(cond.predicate.metric), `${card.id}: unknown metric ${cond.predicate.metric}`);
    }
  }
});

test('lists are non-trivially populated and condition ids are unique per card', () => {
  for (const { card } of cards) {
    for (const k of ['forces', 'benefits', 'liabilities', 'introduced_complexity', 'transformations', 'removal_recipe', 'proof_obligations', 'rollback_strategies']) {
      assert.ok(card[k].length >= 1 && card[k].length <= 5, `${card.id}.${k}`);
    }
    const ids = conditions(card).map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `${card.id}: duplicate condition id`);
  }
});

test('decomposition cards cover T0..T9 exactly once', () => {
  const dec = cards.filter((c) => c.cat === 'decomposition').map((c) => c.card);
  assert.deepEqual(dec.map((c) => c.treatment).sort(), ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']);
  const byId = Object.fromEntries(dec.map((c) => [c.treatment, c.id]));
  assert.deepEqual(byId, {
    T0: 'decomposition.retain', T1: 'decomposition.modularize-in-place', T2: 'decomposition.extract-module',
    T3: 'decomposition.strangler-fig-extraction', T4: 'decomposition.branch-by-abstraction-seam',
    T5: 'decomposition.parallel-change-contract', T6: 'decomposition.database-decomposition',
    T7: 'decomposition.micro-frontend-by-route', T8: 'decomposition.frontend-modular-monolith',
    T9: 'decomposition.backend-for-frontend',
  });
  for (const c of cards.filter((x) => x.cat !== 'decomposition')) assert.equal(c.card.treatment, undefined);
});

test('T0 has no contraindications and T3 has at least five hard predicate contraindications', () => {
  const dec = Object.fromEntries(cards.filter((c) => c.cat === 'decomposition').map((c) => [c.card.treatment, c.card]));
  assert.equal(dec.T0.contraindications.length, 0);
  const hard = dec.T3.contraindications.filter((c) => c.hard === true && c.predicate);
  assert.ok(hard.length >= 5, `T3 hard contraindications: ${hard.length}`);
  const t3 = new Set(dec.T3.contraindications.map((c) => c.id));
  for (const id of ['cross-boundary-transactions', 'shared-table-writers', 'low-ownership-alignment', 'chatty-boundary', 'outbound-dependencies', 'not-robust']) {
    assert.ok(t3.has(id), `T3 missing ${id}`);
  }
  const pre = new Set(dec.T3.preconditions.map((c) => c.id));
  assert.ok(pre.has('requests-interceptable') && pre.has('traces-available'));
});

test('T6 states that dropping legacy objects is a separate human-gated irreversible slice', () => {
  const t6 = cards.find((c) => c.card.treatment === 'T6').card;
  const text = [...t6.architecture_invariants, ...t6.transformations].join(' ').toLowerCase();
  assert.ok(text.includes('drop') && text.includes('separate') && text.includes('irreversible') && text.includes('human-gated'));
});
