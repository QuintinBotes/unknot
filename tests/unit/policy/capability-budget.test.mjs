import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../../helpers/kernel.mjs';

const { issueCapability, verifyToken, capabilityForAgent, revokeCapabilities, profileFor, PROFILES } = K.capability;
const { charge, checkWallClock, checkDiffBudget, LIMIT_FOR } = K.budget;

after(() => K.cleanup());

const code = (c) => (e) => e?.code === c;
const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

describe('profiles', () => {
  test('only refactorer and documentation-curator have write globs', () => {
    for (const [name, prof] of Object.entries(PROFILES)) {
      const writes = prof.write.length > 0;
      assert.equal(writes, name === 'refactorer' || name === 'documentation-curator', name);
      assert.equal(prof.ops.includes('fs.write'), writes, name);
    }
  });

  test('profileFor maps unknot: prefix, unknown types and missing types to foreign', () => {
    assert.equal(profileFor('unknot:refactorer').name, 'refactorer');
    assert.equal(profileFor('refactorer').name, 'refactorer');
    assert.equal(profileFor('general-purpose').name, 'foreign');
    assert.equal(profileFor('Explore').name, 'foreign');
    assert.equal(profileFor('unknot:not-a-real-agent').name, 'foreign');
    assert.deepEqual(profileFor('Explore').ops, ['fs.read']);
    assert.equal(profileFor(undefined).name, 'foreign');
  });

  test('agent types named like Object.prototype members map to foreign, not to a profile without ops',
    {},
    () => {
      for (const t of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'unknot:constructor']) {
        const prof = profileFor(t);
        assert.equal(prof.name, 'foreign', t);
        assert.ok(Array.isArray(prof.ops), t);
      }
    });

  test('analysis profiles never get unknot.cli, verify only verify', () => {
    assert.ok(!PROFILES.cartographer.ops.includes('unknot.cli'));
    assert.ok(PROFILES.verifier.ops.includes('unknot.verify'));
    assert.ok(!PROFILES.refactorer.ops.includes('unknot.verify'));
  });
});

describe('capability tokens', () => {
  const p = K.makeProject();
  const { run } = K.startTestRun(p);
  const issue = (over = {}) => issueCapability(p.ctx, { run_id: run.id, agent_id: 'ag1', agent_type: 'unknot:refactorer', ops: ['fs.write', 'fs.read'], write: ['<worktree-scope>'], ...over });

  test('issue then verify round-trips the grant and logs capability.issued', () => {
    const { token, grant } = issue();
    assert.deepEqual(verifyToken(p.ctx, token), grant);
    assert.deepEqual(grant.ops, ['fs.read', 'fs.write'], 'ops are sorted');
    assert.equal(grant.run_id, run.id);
    assert.equal(grant.environment, 'local');
    const ev = K.ledger.readEvents(p.ctx.store, { type: 'capability.issued' }).at(-1);
    assert.equal(ev.capability_id, grant.id);
    assert.equal(ev.actor, 'hook:SubagentStart');
    assert.deepEqual(ev.payload.write, ['<worktree-scope>']);
  });

  test('each token has a unique id; ttl sets the expiry', () => {
    K.clock.setClock(() => new Date('2030-01-01T00:00:00Z'));
    const a = issue({ ttl: '30m' });
    const b = issue();
    assert.notEqual(a.grant.id, b.grant.id);
    assert.equal(a.grant.expires_at, '2030-01-01T00:30:00.000Z');
    assert.equal(b.grant.expires_at, '2030-01-01T02:00:00.000Z');
    K.clock.resetClock();
  });

  test('malformed tokens are rejected', () => {
    for (const t of ['', 'nodot', '.', 'a.', '.b', undefined, null, 'a.b.c', '🙂.🙂']) {
      assert.throws(() => verifyToken(p.ctx, t), code('UK_POLICY_DENIED'), String(t));
    }
  });

  test('a flipped signature byte is rejected', () => {
    const { token } = issue();
    const [payload, sig] = token.split('.');
    for (const i of [0, 10, sig.length - 1]) assert.throws(() => verifyToken(p.ctx, `${payload}.${flip(sig, i)}`), (e) => e.code === 'UK_POLICY_DENIED' && /signature/.test(e.message));
    assert.throws(() => verifyToken(p.ctx, `${payload}.${sig.slice(0, -2)}`), code('UK_POLICY_DENIED'));
    assert.throws(() => verifyToken(p.ctx, `${payload}.${sig}xx`), code('UK_POLICY_DENIED'));
  });

  test('privilege escalation by editing the payload (ops/write) invalidates the HMAC', () => {
    const { token, grant } = issue({ ops: ['fs.read'], write: [] });
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...grant, ops: ['fs.read', 'fs.write'], write: ['**'] })).toString('base64url');
    assert.throws(() => verifyToken(p.ctx, `${forged}.${sig}`), (e) => e.code === 'UK_POLICY_DENIED' && /signature/.test(e.message));
  });

  test('re-signing with the wrong key (another project) is rejected', () => {
    const other = K.makeProject();
    const { token } = issueCapability(other.ctx, { run_id: 'run-x', agent_id: 'a', agent_type: 'x', ops: ['fs.read'] });
    assert.throws(() => verifyToken(p.ctx, token), (e) => e.code === 'UK_POLICY_DENIED' && /signature/.test(e.message));
  });

  test('a token whose grant row was never stored (or was removed) is rejected', () => {
    const { token, grant } = issue();
    p.ctx.store.run('DELETE FROM capabilities WHERE id = ?', grant.id);
    assert.throws(() => verifyToken(p.ctx, token), (e) => e.code === 'UK_POLICY_DENIED' && /never issued/.test(e.message));
  });

  test('revoked tokens are rejected', () => {
    const { token, grant } = issue({ agent_id: 'rev1' });
    assert.equal(revokeCapabilities(p.ctx, { run_id: run.id, agent_id: 'rev1' }), 1);
    assert.throws(() => verifyToken(p.ctx, token), (e) => e.code === 'UK_POLICY_DENIED' && /revoked/.test(e.message));
    const ev = K.ledger.readEvents(p.ctx.store, { type: 'capability.revoked' }).at(-1);
    assert.equal(ev.capability_id, grant.id);
    assert.equal(revokeCapabilities(p.ctx, { run_id: run.id, agent_id: 'rev1' }), 0, 'idempotent');
  });

  test('expired tokens are rejected, valid just before expiry', () => {
    K.clock.setClock(() => new Date('2030-01-01T00:00:00Z'));
    const { token, grant } = issue({ ttl: '10m', agent_id: 'exp1' });
    K.clock.setClock(() => new Date(new Date(grant.expires_at).getTime() - 1));
    assert.doesNotThrow(() => verifyToken(p.ctx, token));
    K.clock.setClock(() => new Date(grant.expires_at));
    assert.throws(() => verifyToken(p.ctx, token), (e) => e.code === 'UK_POLICY_DENIED' && /expired/.test(e.message));
    assert.equal(capabilityForAgent(p.ctx, run.id, 'exp1'), null);
    K.clock.resetClock();
  });

  test('capabilityForAgent returns the live grant for exactly that agent in that run', () => {
    const { grant } = issue({ agent_id: 'only-me' });
    assert.equal(capabilityForAgent(p.ctx, run.id, 'only-me').id, grant.id);
    assert.equal(capabilityForAgent(p.ctx, run.id, 'someone-else'), null);
    assert.equal(capabilityForAgent(p.ctx, 'run-other', 'only-me'), null);
    revokeCapabilities(p.ctx, { run_id: run.id, agent_id: 'only-me' });
    assert.equal(capabilityForAgent(p.ctx, run.id, 'only-me'), null);
  });

  test('revoking one agent leaves the others', () => {
    const a = issue({ agent_id: 'ra' });
    const b = issue({ agent_id: 'rb' });
    revokeCapabilities(p.ctx, { run_id: run.id, agent_id: 'ra' });
    assert.throws(() => verifyToken(p.ctx, a.token));
    assert.doesNotThrow(() => verifyToken(p.ctx, b.token));
  });

  test('the ledger remains valid after all this', () => {
    assert.equal(K.ledger.verifyLedger(p.ctx.store, p.ctx.store.meta('audit_public_key')).ok, true);
  });
});

describe('budgets', () => {
  const mk = (limits) => {
    const p = K.makeProject();
    const { run } = K.startTestRun(p, { over: { limits } });
    return { p, run };
  };

  test('charge accumulates up to the limit and throws UK_BUDGET_EXCEEDED past it', () => {
    const { p, run } = mk({ max_tool_calls: 3 });
    assert.equal(charge(p.ctx, run, 'tool_calls'), 1);
    assert.equal(charge(p.ctx, run, 'tool_calls'), 2);
    assert.equal(charge(p.ctx, run, 'tool_calls'), 3);
    assert.throws(() => charge(p.ctx, run, 'tool_calls'), (e) => e.code === 'UK_BUDGET_EXCEEDED' && e.run_id === run.id && e.details.limit === 3 && e.details.total === 4);
  });

  test('a breach records a budget.breach event with counter, total and limit', () => {
    const { p, run } = mk({ max_commands: 1 });
    charge(p.ctx, run, 'commands');
    assert.equal(K.ledger.readEvents(p.ctx.store, { type: 'budget.breach' }).length, 0);
    assert.throws(() => charge(p.ctx, run, 'commands', 2, { agentId: 'agX', actor: 'hook:PreToolUse' }), (e) => e.code === 'UK_BUDGET_EXCEEDED');
    const [ev] = K.ledger.readEvents(p.ctx.store, { type: 'budget.breach' });
    assert.deepEqual(ev.payload, { counter: 'commands', total: 3, limit: 1, agent_id: 'agX' });
    assert.deepEqual(ev.budget, { max_commands: 1 });
    assert.equal(ev.actor, 'hook:PreToolUse');
    assert.equal(ev.run_id, run.id);
    assert.equal(K.ledger.verifyLedger(p.ctx.store).ok, true);
  });

  test('once breached, every further charge keeps failing', () => {
    const { p, run } = mk({ max_files_read: 1 });
    charge(p.ctx, run, 'files_read');
    for (let i = 0; i < 3; i++) assert.throws(() => charge(p.ctx, run, 'files_read'), (e) => e.code === 'UK_BUDGET_EXCEEDED');
    assert.equal(K.ledger.readEvents(p.ctx.store, { type: 'budget.breach' }).length, 3);
  });

  test('a zero limit blocks the first charge (network disabled)', () => {
    const { p, run } = mk({ max_network_requests: 0 });
    assert.throws(() => charge(p.ctx, run, 'network_requests'), (e) => e.code === 'UK_BUDGET_EXCEEDED');
  });

  test('null limits and counters without a limit never throw', () => {
    const { p, run } = mk({ max_turns: null });
    for (let i = 0; i < 5; i++) charge(p.ctx, run, 'turns');
    assert.equal(charge(p.ctx, run, 'made_up_counter', 1000), 1000);
  });

  test('counters are per run and per agent', () => {
    const { p, run } = mk({ max_tool_calls: 100 });
    charge(p.ctx, run, 'tool_calls', 2, { agentId: 'a' });
    charge(p.ctx, run, 'tool_calls', 3, { agentId: 'b' });
    assert.equal(p.ctx.store.counters(run.id).tool_calls, 5);
    assert.equal(p.ctx.store.counters(`${run.id}:a`).tool_calls, 2);
    assert.equal(p.ctx.store.counters(`${run.id}:b`).tool_calls, 3);
    const { run: run2 } = K.startTestRun(p);
    assert.equal(p.ctx.store.counters(run2.id).tool_calls, undefined);
  });

  test('LIMIT_FOR names real config limits', () => {
    for (const [counter, key] of Object.entries(LIMIT_FOR)) assert.ok(key in K.DEFAULT_CONFIG.limits, `${counter} -> ${key}`);
  });

  test('checkWallClock', () => {
    const start = new Date('2030-01-01T00:00:00Z');
    const run = { started_at: start.toISOString(), budget: { max_runtime_minutes: 30 } };
    assert.equal(checkWallClock(run, new Date(start.getTime() + 29 * 60000)).ok, true);
    assert.equal(checkWallClock(run, new Date(start.getTime() + 30 * 60000)).ok, true, 'boundary is inclusive');
    const over = checkWallClock(run, new Date(start.getTime() + 31 * 60000));
    assert.equal(over.ok, false);
    assert.equal(over.limit, 30);
    assert.equal(checkWallClock({ ...run, budget: {} }, new Date(start.getTime() + 1e9)).ok, true);
    assert.equal(checkWallClock({ ...run, budget: { max_runtime_minutes: null } }).ok, true);
  });

  test('checkDiffBudget', () => {
    const limits = { max_changed_files: 3, max_diff_lines: 100 };
    assert.deepEqual(checkDiffBudget(limits, { files: 3, lines: 100 }), { ok: true, problems: [] });
    const a = checkDiffBudget(limits, { files: 4, lines: 10 });
    assert.equal(a.ok, false);
    assert.match(a.problems[0], /changed files 4 > max_changed_files 3/);
    const b = checkDiffBudget(limits, { files: 1, lines: 101 });
    assert.match(b.problems[0], /diff lines 101 > max_diff_lines 100/);
    assert.equal(checkDiffBudget(limits, { files: 9, lines: 999 }).problems.length, 2);
    assert.equal(checkDiffBudget({ max_changed_files: null, max_diff_lines: null }, { files: 1e6, lines: 1e9 }).ok, true);
    assert.equal(checkDiffBudget({}, { files: 5, lines: 5 }).ok, true);
    assert.equal(checkDiffBudget({ max_changed_files: 0 }, { files: 1, lines: 0 }).ok, false);
  });
});
