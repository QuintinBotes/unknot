import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSecrets } from '../../../runtime/core/redact.mjs';

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
