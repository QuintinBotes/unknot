import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../../runtime/context.mjs');
const { loadConfig } = await import('../../../runtime/policy/config.mjs');
const { startRun, endRun } = await import('../../../runtime/state/runs.mjs');
const { casGet, casPut } = await import('../../../runtime/state/cas.mjs');
const { verifyLedger } = await import('../../../runtime/state/ledger.mjs');
const { createBackup, readPassphraseFile, restoreBackup, safeRel, verifyBackup } = await import('../../../runtime/enterprise/backup.mjs');

const PASS = 'a long enough passphrase';
const KDF = { kdfN: 1 << 14 }; // the minimum the reader accepts; keeps the tests quick

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uk-bak-'));
  const base = join(dir, '.unknot');
  mkdirSync(join(base, 'campaigns'), { recursive: true });
  mkdirSync(join(base, 'slices'));
  writeFileSync(join(base, 'config.yaml'), 'version: 1\nmode: plan\n');
  writeFileSync(join(base, 'decisions.jsonl'), '{"decision":"accept"}\n');
  writeFileSync(join(base, 'campaigns', 'CMP-1.yaml'), 'id: CMP-1\n');
  writeFileSync(join(base, 'slices', 'UK-0001.yaml'), 'id: UK-0001\n');
  const ctx = openProject(dir, { create: true });
  const cfg = loadConfig(ctx);
  for (let i = 0; i < 3; i++) {
    const run = startRun(ctx, { command: 'map', actor: 'model:main', config: cfg.config, configDigest: cfg.digest });
    endRun(ctx, run.id, { outcome: 'completed' });
  }
  const digest = casPut(ctx, 'cached evidence '.repeat(1000), { label: 'evidence' });
  return { dir, ctx, digest };
}

const tmpFile = (name) => join(mkdtempSync(join(tmpdir(), 'uk-bakout-')), name);

test('create, verify, restore: the restored project opens and its ledger verifies', () => {
  const { ctx, digest } = fixture();
  const file = tmpFile('b.ukb');
  const made = createBackup(ctx, file, PASS, KDF);
  assert.ok(made.files >= 6 && made.ledger.count > 0);
  assert.equal(readFileSync(file, 'utf8').includes('cached evidence'), false, 'the archive is encrypted');
  assert.equal(readFileSync(file, 'utf8').includes(ctx.projectId), false, 'metadata is encrypted too');

  const v = verifyBackup(file, PASS);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.ledger.count, made.ledger.count);

  const target = join(mkdtempSync(join(tmpdir(), 'uk-restore-')), 'restored');
  const r = restoreBackup(file, PASS, target);
  assert.equal(r.project_id, ctx.projectId);
  assert.equal(r.keys_present, true, 'same machine: the key directory is still there');
  assert.equal(readFileSync(join(target, '.unknot/config.yaml'), 'utf8'), 'version: 1\nmode: plan\n');
  assert.ok(existsSync(join(target, '.unknot/campaigns/CMP-1.yaml')));
  assert.ok(existsSync(join(target, '.unknot/slices/UK-0001.yaml')));

  const restored = openProject(target);
  assert.equal(restored.projectId, ctx.projectId);
  assert.equal(verifyLedger(restored.store, restored.store.meta('audit_public_key')).ok, true);
  assert.equal(casGet(restored, digest).toString(), 'cached evidence '.repeat(1000));
});

test('a backup is consistent while the source keeps changing', () => {
  const { ctx } = fixture();
  const file = tmpFile('live.ukb');
  createBackup(ctx, file, PASS, KDF);
  const cfg = loadConfig(ctx);
  const run = startRun(ctx, { command: 'map', actor: 'model:main', config: cfg.config, configDigest: cfg.digest });
  endRun(ctx, run.id, { outcome: 'completed' });
  const v = verifyBackup(file, PASS);
  assert.equal(v.ok, true, 'later events do not break an earlier snapshot');
});

test('tampering, truncation and a wrong passphrase all fail verification', () => {
  const { ctx } = fixture();
  const file = tmpFile('t.ukb');
  createBackup(ctx, file, PASS, KDF);
  const good = readFileSync(file);

  // Flip one base64 character in the middle of the archive.
  const bad = Buffer.from(good);
  let i = Math.floor(bad.length / 2);
  while (!/[A-Za-z0-9]/.test(String.fromCharCode(bad[i]))) i++;
  bad[i] = bad[i] === 0x41 ? 0x42 : 0x41;
  const tampered = tmpFile('tampered.ukb');
  writeFileSync(tampered, bad);
  const t = verifyBackup(tampered, PASS);
  assert.equal(t.ok, false);
  assert.match(t.reason, /authentication|altered/);

  // Drop the manifest (last line): the archive is truncated.
  const lines = good.toString('utf8').trimEnd().split('\n');
  const truncated = tmpFile('truncated.ukb');
  writeFileSync(truncated, `${lines.slice(0, -1).join('\n')}\n`);
  const tr = verifyBackup(truncated, PASS);
  assert.equal(tr.ok, false);
  assert.match(tr.reason, /manifest|truncated/);

  // Remove a record from the middle: positions are authenticated.
  const dropped = tmpFile('dropped.ukb');
  writeFileSync(dropped, `${[...lines.slice(0, 2), ...lines.slice(3)].join('\n')}\n`);
  assert.equal(verifyBackup(dropped, PASS).ok, false);

  assert.equal(verifyBackup(file, 'not the right passphrase').ok, false);
  assert.equal(verifyBackup(file, PASS).ok, true, 'the untouched archive still verifies');

  // Restoring a bad archive leaves nothing behind.
  const target = join(mkdtempSync(join(tmpdir(), 'uk-restore-')), 'r');
  assert.throws(() => restoreBackup(tampered, PASS, target), (e) => e.code === 'UK_INTEGRITY');
  assert.ok(!existsSync(join(target, '.unknot')) || readdirSync(join(target, '.unknot')).length === 0);
});

test('restore refuses a non-empty target and never overwrites', () => {
  const { ctx } = fixture();
  const file = tmpFile('r.ukb');
  createBackup(ctx, file, PASS, KDF);
  const target = mkdtempSync(join(tmpdir(), 'uk-restore-'));
  writeFileSync(join(target, 'precious.txt'), 'keep me');
  assert.throws(() => restoreBackup(file, PASS, target), (e) => e.code === 'UK_STATE_CONFLICT');
  assert.equal(readFileSync(join(target, 'precious.txt'), 'utf8'), 'keep me');
  const empty = mkdtempSync(join(tmpdir(), 'uk-restore-'));
  restoreBackup(file, PASS, empty);
  assert.throws(() => restoreBackup(file, PASS, empty), (e) => e.code === 'UK_STATE_CONFLICT', 'a second restore into the same place is refused');
  assert.throws(() => createBackup(ctx, file, PASS, KDF), (e) => e.code === 'UK_STATE_CONFLICT', 'backups are not overwritten');
});

test('passphrase files must be private and long enough', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-pf-'));
  const f = join(dir, 'pass');
  writeFileSync(f, `${PASS}\n`, { mode: 0o644 });
  chmodSync(f, 0o644);
  assert.throws(() => readPassphraseFile(f), (e) => e.code === 'UK_POLICY_DENIED');
  chmodSync(f, 0o640);
  assert.throws(() => readPassphraseFile(f), (e) => e.code === 'UK_POLICY_DENIED');
  chmodSync(f, 0o600);
  assert.equal(readPassphraseFile(f), PASS, 'the trailing newline is stripped');
  writeFileSync(f, 'short\n', { mode: 0o600 });
  assert.throws(() => readPassphraseFile(f), (e) => e.code === 'UK_CONFIG_INVALID');
  assert.throws(() => readPassphraseFile(join(dir, 'missing')), (e) => e.code === 'UK_NOT_FOUND');
});

test('archive paths are confined to the project state layout', () => {
  for (const ok of ['state/unknot.db', 'config.yaml', 'decisions.jsonl', 'cas/sha256/ab/cdef', 'slices/UK-0001.yaml']) assert.equal(safeRel(ok), true, ok);
  for (const bad of ['../x', '/etc/passwd', 'cas/../../x', 'state/other.db', 'cas', 'worktrees/a', 'a\\b', 'cas//x', '', 'config.yaml/../x']) assert.equal(safeRel(bad), false, bad);
});
