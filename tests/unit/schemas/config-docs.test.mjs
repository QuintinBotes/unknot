// docs/configuration.md documents every config key (CONTRIBUTING: config keys change the schema,
// the defaults and that page together). Checked by name: each key appears inside backticks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

test('every key in the config schema is named in docs/configuration.md', () => {
  const doc = read('docs/configuration.md');
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
  assert.ok(keys.length > 100);
  const named = (leaf) => new RegExp(`\`[^\`\\n]*\\b${leaf}\\b[^\`\\n]*\``).test(doc);
  assert.deepEqual(keys.filter((k) => !named(k.split('.').pop())), []);
});
