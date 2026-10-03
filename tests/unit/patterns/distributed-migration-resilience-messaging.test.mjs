import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYAML } from '../../../runtime/core/yaml.mjs';
import { validateArtifact } from '../../../runtime/core/schema.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CATEGORIES = ['distributed', 'migration', 'resilience', 'messaging'];

const vocabulary = new Set();
for (const line of readFileSync(join(root, 'patterns', 'README.md'), 'utf8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const first = line.split('|')[1] ?? '';
  for (const m of first.matchAll(/`([a-z0-9_.]+)`/g)) vocabulary.add(m[1]);
}

const ids = new Set();
test('vocabulary table parsed', () => assert.ok(vocabulary.has('messaging.dlq') && vocabulary.size > 50));

for (const cat of CATEGORIES) {
  const dir = join(root, 'patterns', cat);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  test(`${cat}: has cards`, () => assert.ok(files.length > 0));
  for (const f of files) {
    test(`${cat}/${f}`, () => {
      const card = parseYAML(readFileSync(join(dir, f), 'utf8'));
      const r = validateArtifact('pattern-card', card);
      assert.equal(r.valid, true, JSON.stringify(r.errors));
      assert.equal(card.category, cat);
      assert.equal(card.id, `${cat}.${f.replace(/\.yaml$/, '')}`);
      assert.ok(!ids.has(card.id), `duplicate id ${card.id}`);
      ids.add(card.id);
      assert.ok(card.contraindications.length >= 1, 'needs a contraindication');
      assert.ok(card.removal_recipe?.length >= 1 && card.removal_recipe.every((s) => s.trim()), 'needs removal_recipe');
      for (const key of ['applicability_signals', 'preconditions', 'contraindications']) {
        for (const s of card[key]) {
          if (s.predicate) assert.ok(vocabulary.has(s.predicate.metric), `unknown metric ${s.predicate.metric}`);
        }
      }
    });
  }
}
