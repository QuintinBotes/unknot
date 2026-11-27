// Config acceptance is signed with the project's key in UNKNOT_HOME (#215). Each test writes an
// acceptance into the store the way an attacker who can write `.unknot/state` but not sign
// would, and checks that it unlocks nothing and that doctor says so.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import * as K from '../helpers/kernel.mjs';
import { mkTmp } from '../helpers/tmp.mjs';

after(() => K.cleanup());

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const bin = new URL('../../bin/unknot', import.meta.url).pathname;
const helper = new URL('../helpers/no-sandbox.mjs', import.meta.url).pathname;
const { digest, canonicalJSON } = K.canonical;

const LOOSE = 'version: 1\nmode: assist\nsecurity:\n  require_os_sandbox: false\n';
const TIGHT = 'version: 1\nmode: plan\n';
const ROWS = ['accepted_config_text', 'accepted_config_digest', 'accepted_config_at', 'accepted_config_signature'];

const cli = (p, ...argv) => spawnSync(process.execPath, ['--import', helper, bin, ...argv, '--cwd', p.dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home, UNKNOT_TEST_HIDE_SANDBOX: '1' } });
const doctorCheck = (p) => JSON.parse(cli(p, 'doctor', '--json').stdout).checks.find((c) => c.name === 'config acceptance');
const rows = (p) => Object.fromEntries(ROWS.map((k) => [k, p.ctx.store.meta(k)]));
const setRows = (p, r) => p.ctx.store.tx(() => {
  for (const [k, v] of Object.entries(r)) {
    if (v == null) p.ctx.store.run('DELETE FROM meta WHERE key = ?', k);
    else p.ctx.store.meta(k, v);
  }
});

/** The loaded config must be the capped, unaccepted one, never LOOSE. */
function assertNotHonoured(p, text = LOOSE) {
  writeFileSync(p.ctx.paths.config, text);
  const loaded = K.configMod.loadConfig(p.ctx);
  assert.equal(loaded.acceptance, 'invalid', String(loaded.notice));
  assert.equal(loaded.config.mode, 'plan');
  assert.equal(K.configMod.acceptedConfigText(p.ctx), null);
  return loaded;
}

describe('forged acceptance rows unlock nothing', () => {
  // The #209 re-review exploit: leave .unknot/worktrees, remove .unknot/state, recreate the store
  // and write an acceptance of a config that opts out of the sandbox. exec must stay refused.
  test('a recreated store with forged rows does not run slice code unsandboxed (CLI)', () => {
    const p = K.makeProject({ config: 'version: 1\nmode: assist\n' });
    const mark = join(p.dir, 'ran');
    mkdirSync(join(p.ctx.paths.worktrees, 's1'), { recursive: true });
    writeFileSync(join(p.ctx.paths.worktrees, 's1', 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(mark)}, 'x')\n`);
    const forged = `${LOOSE}commands:\n  test_unit: [${JSON.stringify(process.execPath)}, .unknot/worktrees/s1/evil.js]\n`;
    writeFileSync(p.ctx.paths.config, forged);
    p.ctx.store.close?.();
    rmSync(p.ctx.paths.state, { recursive: true, force: true });
    const fresh = K.context.openProject(p.dir);
    fresh.store.close?.();
    const db = new DatabaseSync(p.ctx.paths.db);
    const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    put.run('accepted_config_text', forged);
    put.run('accepted_config_digest', digest(forged));
    db.close();

    const r = cli(p, 'exec', 'test_unit');
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /UK_SANDBOX_REQUIRED/);
    assert.doesNotMatch(r.stdout + r.stderr, /explicitly allowed/);
    assert.equal(existsSync(mark), false, 'the slice code did not run');
    const c = doctorCheck(p);
    assert.equal(c.level, 'warn');
    assert.match(c.detail, /carries no signature.*not honoured.*unknot config accept/);
  });

  test('a genuine signature over different text', () => {
    const p = K.makeProject({ config: TIGHT });
    setRows(p, { accepted_config_text: LOOSE, accepted_config_digest: digest(LOOSE) });
    const loaded = assertNotHonoured(p);
    assert.match(loaded.notice, /does not verify against this project's key/);
    // The text alone changed, the digest kept: the digest no longer matches the text.
    setRows(p, { accepted_config_digest: digest(TIGHT) });
    assertNotHonoured(p);
  });

  test("a signature by another project's key", () => {
    const other = K.makeProject({ config: LOOSE });
    const p = K.makeProject({ config: TIGHT });
    const at = new Date().toISOString();
    const statement = canonicalJSON({ type: 'unknot.config-acceptance/v1', project_id: p.ctx.projectId, root: p.ctx.root, digest: digest(LOOSE), at });
    const signature = K.keys.signText(K.keys.auditPrivateKey(other.ctx.projectId), statement);
    // Even with the in-force pointer in UNKNOT_HOME set to it, the key decides.
    writeFileSync(join(p.home, 'roots', createHash('sha256').update(p.ctx.root).digest('hex'), 'acceptance.json'), JSON.stringify({ project_id: p.ctx.projectId, signature }));
    setRows(p, { accepted_config_text: LOOSE, accepted_config_digest: digest(LOOSE), accepted_config_at: at, accepted_config_signature: signature });
    assertNotHonoured(p);
    // Another project's whole valid record, with this store claiming that project's id, is bound
    // to the other checkout's root and does not verify here either.
    setRows(p, rows(other));
    p.ctx.store.meta('project_id', other.ctx.projectId);
    assertNotHonoured({ ...p, ctx: { ...p.ctx, projectId: other.ctx.projectId } });
  });

  test('a replayed acceptance of an older config', () => {
    const p = K.makeProject({ config: LOOSE });
    const old = rows(p);
    K.configMod.recordAcceptedConfig(p.ctx, TIGHT, 'human:test');
    writeFileSync(p.ctx.paths.config, TIGHT);
    assert.equal(K.configMod.loadConfig(p.ctx).acceptance, 'accepted');
    setRows(p, old);
    assertNotHonoured(p);
    assert.ok(old.accepted_config_signature, 'the replayed acceptance was itself validly signed');
  });

  // Review of #219: the in-force acceptance was kept per project id, which the store chooses. A
  // store recreated under a new id left the old id's acceptance in force, so the old store put
  // back after the person re-accepted verified again.
  test('an older store put back after a re-accept under a new project id (CLI)', () => {
    const p = K.makeProject({ config: LOOSE });
    const saved = join(p.dir, '..', `${p.ctx.projectId}-state`);
    p.ctx.store.close();
    cpSync(p.ctx.paths.state, saved, { recursive: true });
    rmSync(p.ctx.paths.state, { recursive: true, force: true });
    const renewed = K.context.openProject(p.dir);
    assert.notEqual(renewed.projectId, p.ctx.projectId);
    writeFileSync(p.ctx.paths.config, TIGHT);
    K.configMod.recordAcceptedConfig(renewed, TIGHT, 'human:test');
    renewed.store.close();
    rmSync(p.ctx.paths.state, { recursive: true, force: true });
    cpSync(saved, p.ctx.paths.state, { recursive: true });
    writeFileSync(p.ctx.paths.config, LOOSE);
    const shown = JSON.parse(cli(p, 'config', 'show').stdout);
    assert.equal(shown.acceptance, 'invalid');
    assert.equal(shown.effective.mode, 'plan');
  });

  test('an older backup restored into the same checkout after a newer accept', async () => {
    const { createBackup, restoreBackup } = await import(new URL('../../runtime/enterprise/backup.mjs', import.meta.url).href);
    const p = K.makeProject({ config: LOOSE });
    const file = join(p.dir, '..', `${p.ctx.projectId}.ukb`);
    createBackup(p.ctx, file, 'a backup passphrase');
    p.ctx.store.close();
    rmSync(p.ctx.paths.state, { recursive: true, force: true });
    const renewed = K.context.openProject(p.dir);
    writeFileSync(p.ctx.paths.config, TIGHT);
    K.configMod.recordAcceptedConfig(renewed, TIGHT, 'human:test');
    renewed.store.close();
    const restored = join(p.dir, '..', `${p.ctx.projectId}-restored`);
    restoreBackup(file, 'a backup passphrase', restored);
    rmSync(p.ctx.paths.state, { recursive: true, force: true });
    cpSync(join(restored, '.unknot', 'state'), p.ctx.paths.state, { recursive: true });
    writeFileSync(p.ctx.paths.config, LOOSE);
    const back = K.context.openProject(p.dir);
    assert.equal(back.projectId, p.ctx.projectId, 'the backup brought its own project id');
    assertNotHonoured({ ...p, ctx: back });
    // A person accepting again in a terminal makes it valid.
    K.configMod.recordAcceptedConfig(back, LOOSE, 'human:test');
    assert.equal(K.configMod.loadConfig(back).acceptance, 'accepted');
  });

  test('a removed key in UNKNOT_HOME (CLI)', () => {
    const p = K.makeProject({ config: LOOSE });
    assert.equal(JSON.parse(cli(p, 'config', 'show').stdout).acceptance, 'accepted');
    rmSync(join(p.home, 'projects', p.ctx.projectId, 'audit.pem'));
    const shown = JSON.parse(cli(p, 'config', 'show').stdout);
    assert.equal(shown.acceptance, 'invalid');
    assert.equal(shown.effective.mode, 'plan');
    assert.match(doctorCheck(p).detail, /does not verify against this project's key/);
  });

  test('an acceptance from a release before #215 (no signature) is not honoured, and the person is told to accept once', () => {
    const p = K.makeProject({ config: LOOSE });
    setRows(p, { accepted_config_at: null, accepted_config_signature: null });
    const loaded = assertNotHonoured(p);
    assert.match(loaded.notice, /recorded by an earlier release.*unknot config accept/);
    const st = JSON.parse(cli(p, 'status', '--json').stdout);
    assert.match(JSON.stringify(st), /unknot config accept/);
  });

  // #222: the in-force record was kept per checkout path only, so after a checkout moved from A to
  // B and a stricter config was accepted at B, a copy of the pre-move store at A still verified.
  describe('a moved checkout', () => {
    const CMD = (mark) => `${LOOSE}commands:\n  test_unit: [${JSON.stringify(process.execPath)}, -e, ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(mark)}, 'x')`)}]\n`;
    const rootRecord = (home, root) => join(home, 'roots', createHash('sha256').update(root).digest('hex'), 'acceptance.json');

    /** Accept CMD at A, keep a copy of A, move A to B and accept TIGHT there. */
    function moveAndTighten({ putBackBeforeAccept }) {
      const mark = join(mkTmp(join(tmpdir(), 'uk-mark-')), 'ran');
      const p = K.makeProject({ config: CMD(mark) });
      const a = { dir: p.dir, home: p.home };
      // A write mode's traces, so an invalid acceptance keeps the OS sandbox required.
      mkdirSync(join(p.ctx.paths.worktrees, 's1'), { recursive: true });
      const r0 = cli(a, 'exec', 'test_unit');
      assert.equal(r0.status, 0, r0.stderr);
      assert.ok(existsSync(mark), 'the accepted config ran unsandboxed at A, as LOOSE allows');
      rmSync(mark);
      p.ctx.store.close();
      const saved = join(mkTmp(join(tmpdir(), 'uk-saved-')), 'a');
      cpSync(p.dir, saved, { recursive: true });
      const b = { dir: join(mkTmp(join(tmpdir(), 'uk-moved-')), 'b'), home: p.home };
      renameSync(p.dir, b.dir);
      if (putBackBeforeAccept) cpSync(saved, a.dir, { recursive: true });
      const moved = K.context.openProject(b.dir);
      assert.equal(moved.projectId, p.ctx.projectId, 'the moved store keeps its project id');
      writeFileSync(moved.paths.config, TIGHT);
      K.configMod.recordAcceptedConfig(moved, TIGHT, 'human:test');
      moved.store.close();
      if (!putBackBeforeAccept) cpSync(saved, a.dir, { recursive: true });
      return { a, b, mark, root: p.ctx.root };
    }

    function assertInvalidAtA({ a, b, mark }) {
      const shown = JSON.parse(cli(a, 'config', 'show').stdout);
      assert.equal(shown.acceptance, 'invalid');
      assert.equal(shown.effective.mode, 'plan');
      assert.match(doctorCheck(a).detail, /does not verify against this project's key.*superseded/);
      const r = cli(a, 'exec', 'test_unit');
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, /UK_SANDBOX_REQUIRED/);
      assert.equal(existsSync(mark), false, 'the old config did not run unsandboxed at A');
      assert.equal(JSON.parse(cli(b, 'config', 'show').stdout).acceptance, 'accepted', 'B keeps its own acceptance');
    }

    test('the pre-move store kept at the old path is superseded by the accept at the new one (CLI)', () => {
      const m = moveAndTighten({ putBackBeforeAccept: true });
      // A existed throughout, so its record under roots/ is still there: the per-project record decides.
      assert.ok(existsSync(rootRecord(m.a.home, m.root)), 'the old path still has its in-force record');
      assertInvalidAtA(m);
    });

    test('the pre-move store put back after the accept is superseded, and the gone path was pruned (CLI)', () => {
      const m = moveAndTighten({ putBackBeforeAccept: false });
      assert.equal(existsSync(rootRecord(m.a.home, m.root)), false, 'config accept pruned the record of a path that no longer existed');
      assertInvalidAtA(m);
    });

    test('pruning keeps the records of live checkouts, including one whose path cannot be read', () => {
      const live = K.makeProject({ config: LOOSE });
      // A checkout under a folder this process cannot search (permissions, or macOS privacy) still exists.
      const parent = mkTmp(join(tmpdir(), 'uk-locked-'));
      const hidden = join(parent, 'p');
      mkdirSync(hidden);
      const hiddenRecord = rootRecord(live.home, hidden);
      mkdirSync(join(hiddenRecord, '..'), { recursive: true });
      writeFileSync(hiddenRecord, JSON.stringify({ project_id: 'other', root: hidden, signature: 'x' }));
      const gonePath = join(mkTmp(join(tmpdir(), 'uk-gone-')), 'p');
      const goneRecord = rootRecord(live.home, gonePath);
      mkdirSync(join(goneRecord, '..'), { recursive: true });
      writeFileSync(goneRecord, JSON.stringify({ project_id: 'other', root: gonePath, signature: 'x' }));
      const other = K.makeProject();
      chmodSync(parent, 0o000);
      try {
        K.configMod.recordAcceptedConfig(other.ctx, LOOSE, 'human:test');
      } finally {
        chmodSync(parent, 0o755);
      }
      assert.ok(existsSync(rootRecord(live.home, live.ctx.root)), 'a live checkout keeps its record');
      assert.ok(existsSync(hiddenRecord), 'an unreadable checkout keeps its record');
      assert.equal(existsSync(goneRecord), false, 'a path that is gone is pruned');
    });
  });

  // #222 scenario 2: two different projects that used the same path in turn behave as in #215:
  // each fails closed once the other has accepted there, and one accept brings it back.
  test('two projects at one path in turn: each fails closed and is re-accepted once', () => {
    const p = K.makeProject({ config: LOOSE });
    const first = p.ctx;
    const firstState = join(mkTmp(join(tmpdir(), 'uk-first-')), 'state');
    first.store.close();
    cpSync(first.paths.state, firstState, { recursive: true });
    rmSync(first.paths.state, { recursive: true, force: true });
    const second = K.context.openProject(p.dir);
    assert.notEqual(second.projectId, first.projectId);
    writeFileSync(p.ctx.paths.config, TIGHT);
    K.configMod.recordAcceptedConfig(second, TIGHT, 'human:test');
    second.store.close();
    const secondState = join(mkTmp(join(tmpdir(), 'uk-second-')), 'state');
    cpSync(second.paths.state, secondState, { recursive: true });
    const swapTo = (state, text) => {
      rmSync(p.ctx.paths.state, { recursive: true, force: true });
      cpSync(state, p.ctx.paths.state, { recursive: true });
      writeFileSync(p.ctx.paths.config, text);
      return K.context.openProject(p.dir);
    };
    let back = swapTo(firstState, LOOSE);
    assertNotHonoured({ ...p, ctx: back });
    K.configMod.recordAcceptedConfig(back, LOOSE, 'human:test');
    assert.equal(K.configMod.loadConfig(back).acceptance, 'accepted');
    back.store.close();
    // The first project's re-accept supersedes the second's acceptance at this path in turn.
    back = swapTo(secondState, TIGHT);
    assert.equal(back.projectId, second.projectId);
    assert.equal(K.configMod.loadConfig(back).acceptance, 'invalid');
    K.configMod.recordAcceptedConfig(back, TIGHT, 'human:test');
    assert.equal(K.configMod.loadConfig(back).acceptance, 'accepted');
    back.store.close();
  });

  test('a genuine acceptance verifies', () => {
    const p = K.makeProject({ config: LOOSE });
    const loaded = K.configMod.loadConfig(p.ctx);
    assert.equal(loaded.acceptance, 'accepted');
    assert.equal(loaded.config.security.require_os_sandbox, false);
    assert.equal(doctorCheck(p).level, 'ok');
  });
});
