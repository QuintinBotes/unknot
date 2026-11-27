import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSecrets, redact } from '../../../runtime/core/redact.mjs';

test('precise mode drops placeholders for findings; redaction stays conservative (unfamiliar-repository regressions)', () => {
  const placeholders = [
    `ghp_${'secret'.repeat(7)}`,
    'postgres://u:${BACKUP_DB_PASSWORD:-changeme-set-a-real-password}@db/x',
    'postgresql://app:secure_password_change_in_production@localhost/db',
  ];
  for (const t of placeholders) {
    assert.equal(findSecrets(t, { precise: true }).length, 0, t);
    assert.equal(findSecrets(t).length, 1, `redaction still covers ${t}`);
  }
  for (const t of ['postgresql://app:MySecretPass2024@db/x', 'ghp_aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5']) {
    assert.equal(findSecrets(t, { precise: true }).length, 1, t);
  }
});

test('findings ignore labelled fixtures, sequential fillers and optional-chain reads (fresh-audit regressions)', () => {
  for (const t of ["token: 'jira-token'", 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'const apiKey = signature?.apiKey;']) {
    assert.equal(findSecrets(t, { precise: true }).length, 0, t);
  }
  assert.equal(findSecrets("token: 'jira-token'").length, 1, 'redaction still covers labelled values');
});

test('a comparison or a scope operator after a credential word is no assignment', () => {
  const kinds = (t) => findSecrets(t, { precise: true }).map((h) => h.kind);
  const fake = ['Kx9v', 'Q2mL', 'p7Zr'].join(''); // built here so secret scanners do not flag the fixture
  assert.deepEqual(kinds('return $response == Password::RESET_LINK_SENT ? a : b;'), []);
  assert.deepEqual(kinds(`if (password === "${fake}") {}`), []);
  assert.deepEqual(kinds('$t = Token::fromHeaderValue($h);'), []);
  assert.deepEqual(kinds(`password = "${fake}"`), ['assigned-password']);
  assert.deepEqual(kinds(`password: ${fake}`), ['assigned-password']);
});

test('a value on the next line, in a YAML block scalar or indented under the key, is still a secret (#201)', () => {
  const fake = ['Kx9v', 'Q2mL', 'p7Zr'].join('');
  const kinds = (t) => findSecrets(t, { precise: true }).map((h) => h.kind);
  for (const t of [`token: |\n  ${fake}\n`, `password: >-\n  ${fake}\n`, `secret: |-\n    ${fake}\n`, `[db]\npassword =\n    ${fake}\n`]) {
    assert.equal(kinds(t).length, 1, t);
    assert.ok(!redact(t).text.includes(fake), `redacted: ${t}`);
  }
  const gh = `${'ghp_'}aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5`;
  assert.deepEqual(kinds(`api_token: |\n  ${gh}\n`), ['github-token']);
  assert.ok(!redact(`api_token: |\n  ${gh}\n`).text.includes(gh));
  // A next line that is a `key:` opens a nested mapping, and a value line needs indentation.
  for (const t of [`token:\n  nested: ${fake}\n`, `token:\n  "nested": ${fake}\n`, `password:\n${fake}\n`, 'launchdarkly-token:\n    description: "LaunchDarkly API access token"\n']) {
    assert.deepEqual(kinds(t), [], t);
  }
});
