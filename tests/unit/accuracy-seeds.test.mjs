import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SEED_DIR, SEEDED_LANGUAGES, seedsFor } from '../../scripts/lib/accuracy-seeds.mjs';

test('every seeded language plants a cycle, a dead function and a long function under the seed directory', () => {
  for (const language of SEEDED_LANGUAGES) {
    const spec = seedsFor(language, '/nonexistent');
    for (const p of Object.keys(spec.files)) assert.ok(p.startsWith(`${SEED_DIR}/`), p);
    const seeds = spec.expect.map((e) => e.seed);
    for (const s of ['cycle', 'dead-function', 'long-function']) assert.ok(seeds.includes(s), `${language} ${s}`);
    for (const e of spec.expect) for (const p of e.paths) assert.ok(p in spec.files);
  }
  assert.ok(seedsFor('java', '/x').expect.some((e) => e.seed === 'unused-injected-member'));
  assert.equal(seedsFor('cobol', '/x'), null);
});

test('the corpus pins every repository to a full commit SHA and names unique repositories', () => {
  const { repositories } = JSON.parse(readFileSync(new URL('../../scripts/corpus.json', import.meta.url), 'utf8'));
  const names = new Set();
  for (const r of repositories) {
    assert.match(r.sha, /^[0-9a-f]{40}$/, r.name);
    assert.match(r.url, /^https:\/\/github\.com\//);
    assert.ok(!names.has(r.name));
    names.add(r.name);
  }
  assert.ok(repositories.filter((r) => r.quick).length === 2);
  for (const language of ['csharp', 'java', 'python', 'ruby', 'php', 'go', 'typescript']) assert.ok(repositories.some((r) => r.language === language), language);
});
