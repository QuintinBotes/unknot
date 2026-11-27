// The pull request body of `unknot pr` (#151): rendered only from the proof bundle, sections in
// order, repository text quoted as data, long sections collapsed, secrets redacted.

import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { mkTmp } from '../../helpers/tmp.mjs';
import { renderPullRequestBody } from '../../../runtime/verify/bundle.mjs';

const BUNDLE = new URL('../../fixtures/pr-bundle/', import.meta.url).pathname;
const GOLDEN = new URL('../../fixtures/pr-bundle.expected.md', import.meta.url);

test('pr body: matches the golden file for the fixture bundle', () => {
  assert.equal(renderPullRequestBody(BUNDLE), readFileSync(GOLDEN, 'utf8'));
});

test('pr body: every section of the review summary, in order', () => {
  const body = renderPullRequestBody(BUNDLE);
  const order = ['## Objective', '## Why this change belongs', '## Conventions that apply', '## Ran and passed', '## Ran and failed', '## Not run, and why', '## Evidence gaps and uncertainties', '## Security delta', '## How to revert'];
  const at = order.map((h) => body.indexOf(h));
  assert.ok(at.every((i) => i >= 0), `missing: ${order.filter((_, k) => at[k] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.match(body, /F-0001 \(complex-function\)/, 'the finding that says why');
  assert.match(body, /\[OBSERVED\] cyclomatic 9/, 'its evidence');
  assert.match(body, /PO-3 behaviour-review: .*\(waits for a person to attest it\)/);
  assert.match(body, /\[documented\] Never edit generated files \(src\/AGENTS.md:3, scope src\)/, 'the slice convention report (#155)');
});

test('pr body: repository text is quoted, long sections collapse, secrets are redacted', () => {
  const body = renderPullRequestBody(BUNDLE);
  // Text with a ``` run is fenced with a longer fence, so it cannot close the block.
  assert.match(body, /````text\nF-0001[^]*<img src=x>\n````/);
  assert.match(body, /<details><summary>16 lines<\/summary>/);
  assert.doesNotMatch(body, /AKIAIOSFODNN7EXAMPLE/);
  assert.match(body, /\[REDACTED:aws-access-key-id\]/);
  assert.doesNotMatch(body, /stale/);
});

test('pr body: a re-patched slice says its verification is stale', () => {
  const body = renderPullRequestBody(BUNDLE, { stale: 'sha256:bbbb' });
  assert.match(body.split('\n')[0], /WARNING/);
  assert.match(body, /patched again after its verification \(diff `sha256:bbbb`, verified `sha256:aaaa`\)[^]*stale until `unknot verify S-0001`/);
});

test('pr body: a bundle whose verification.json was overwritten before #183 asks for a new verify', () => {
  const dir = mkTmp('pr-old-bundle-');
  cpSync(BUNDLE, dir, { recursive: true });
  writeFileSync(join(dir, 'verification.json'), JSON.stringify({ slice: 'S-0001', state: 'REVIEW_READY', diff_hash: 'sha256:aaaa', results: [], waiting_for_human: [] }));
  assert.throws(() => renderPullRequestBody(dir), (e) => e.code === 'UK_STATE_CONFLICT' && /unknot verify S-0001/.test(e.message));
});
