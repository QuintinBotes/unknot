import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYAML } from '../../../runtime/core/yaml.mjs';
import { validateArtifact } from '../../../runtime/core/schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CATEGORIES = ['code', 'anti-pattern', 'database', 'infrastructure'];
// Database cards that neither delete nor move data (constraint and process changes only).
const NON_DESTRUCTIVE_DB = new Set(['database.replace-app-validation-with-constraint', 'database.standardize-migrations']);

const readme = readFileSync(join(ROOT, 'patterns', 'README.md'), 'utf8');
const VOCAB = new Set([...readme.matchAll(/`([a-z0-9_]+\.[a-z0-9_]+)`/g)].map((m) => m[1]));

const cards = [];
for (const category of CATEGORIES) {
  const dir = join(ROOT, 'patterns', category);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    cards.push({ category, file, card: parseYAML(readFileSync(join(dir, file), 'utf8')) });
  }
}

const conditions = (card) => [...card.applicability_signals, ...card.preconditions, ...card.contraindications];

test('vocabulary was parsed from the README', () => {
  assert.ok(VOCAB.has('index.scans') && VOCAB.has('plan.deletes') && VOCAB.has('symbol.references'));
});

test('every category has cards', () => {
  for (const category of CATEGORIES) assert.ok(cards.some((c) => c.category === category), category);
});

test('ids are unique', () => {
  const ids = cards.map((c) => c.card.id);
  assert.equal(new Set(ids).size, ids.length);
});

for (const { category, file, card } of cards) {
  test(`${category}/${file}`, () => {
    const r = validateArtifact('pattern-card', card);
    assert.ok(r.valid, JSON.stringify(r.errors));
    assert.equal(card.category, category);
    assert.equal(card.id, `${category}.${file.replace(/\.yaml$/, '')}`);

    for (const c of conditions(card)) {
      if (c.predicate) assert.ok(VOCAB.has(c.predicate.metric), `unknown metric ${c.predicate.metric} in ${card.id}`);
    }

    if (category === 'code') {
      assert.ok(card.introduction_recipe.length > 0, 'introduction_recipe');
      assert.ok(card.removal_recipe.length > 0, 'removal_recipe');
    }

    if (category === 'database' && !NON_DESTRUCTIVE_DB.has(card.id)) {
      const hard = card.contraindications.some(
        (c) => c.hard === true && c.predicate && c.predicate.metric === 'backup.restore_tested' && c.predicate.op === '==' && c.predicate.value === 0,
      );
      assert.ok(hard, `${card.id} needs a hard backup.restore_tested == 0 contraindication`);
    }
  });
}
