// docs/configuration.md documents every config key (CONTRIBUTING: config keys change the schema,
// the defaults and that page together). Checked by name: each key's last segment appears inside a code span.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

const schemaKeys = () => {
  const keys = [];
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node?.properties ?? {})) {
      keys.push([...path, k].join('.'));
      walk(v, [...path, k]);
    }
    if (node?.items) walk(node.items, path);
    if (typeof node?.additionalProperties === 'object') walk(node.additionalProperties, path);
  };
  walk(JSON.parse(read('schemas/config.schema.json')), []);
  return keys;
};

// Spans are paired in order, so prose between two spans never counts as code.
const undocumented = (doc, keys) => {
  const spans = doc.match(/`[^`\n]+`/g) ?? [];
  return keys.filter((k) => !spans.some((s) => new RegExp(`\\b${k.split('.').pop()}\\b`).test(s)));
};

test('every key in the config schema is named in docs/configuration.md', () => {
  const keys = schemaKeys();
  assert.ok(keys.length > 100);
  assert.deepEqual(undocumented(read('docs/configuration.md'), keys), []);
});

test('a key the page names only in prose between code spans is undocumented', () => {
  const doc = read('docs/configuration.md');
  const row = 'owner?, source?, quote?}`, where `source` is where the driver was stated (a URL or document) and `quote` the sentence';
  assert.ok(doc.includes(row));
  // "never edited as source." still sits between `[]` and `**/vendor/**` elsewhere on the page.
  const without = doc.replace(row, 'owner?, quote?}`, where `quote` is the sentence');
  assert.deepEqual(undocumented(without, ['decomposition.drivers.source']), ['decomposition.drivers.source']);
});
