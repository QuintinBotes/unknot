import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bumpPin } from '../../../scripts/bump-claude-pin.mjs';

const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const live = readFileSync(new URL('../../../.github/workflows/live.yml', import.meta.url), 'utf8');
const compat = readFileSync(new URL('../../../COMPATIBILITY.md', import.meta.url), 'utf8');
const pin = (t) => t.match(/claude-code@(\d+\.\d+\.\d+)/)[1];

test('bump pin: a newer version rewrites both files to the same pin', () => {
  const a = bumpPin(ci, '2.1.999');
  const b = bumpPin(live, '2.1.999');
  assert.equal(pin(a), '2.1.999');
  assert.equal(pin(b), '2.1.999');
  assert.match(a, /claude-code@latest plugin validate/);
  assert.equal(pin(bumpPin(compat, '2.1.999')), '2.1.999', 'the tested profile in COMPATIBILITY.md moves with the pin');
});

test('bump pin: equal, older and unparsable versions change nothing', () => {
  for (const v of [pin(ci), '2.0.1', '2.1.2-beta.1', 'latest', '', '2.1']) {
    assert.equal(bumpPin(ci, v), ci, v);
    assert.equal(bumpPin(live, v), live, v);
  }
});

test('bump pin: compares numbers, not strings', () => {
  assert.equal(pin(bumpPin(ci, '2.1.1000')), '2.1.1000');
});
