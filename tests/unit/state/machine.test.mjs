import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../../helpers/kernel.mjs';

const { STATES, TRANSITIONS, canTransition, transitionSlice, replaySliceStates } = K.machine;
const { verifyLedger, readEvents } = K.ledger;

after(() => K.cleanup());

const code = (c) => (e) => e?.code === c;

describe('state machine transition table', () => {
  test('every state has a table row and every target is a known state', () => {
    for (const s of STATES) assert.ok(TRANSITIONS[s], s);
    for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) assert.ok(STATES.includes(to), `${from}->${to}`);
  });

  test('ABANDONED is terminal; ACCEPTED can only roll back', () => {
    assert.deepEqual([...TRANSITIONS.ABANDONED], []);
    assert.deepEqual([...TRANSITIONS.ACCEPTED], ['ROLLED_BACK']);
  });

  test('no shortcut from PLANNED to PATCHING or ACCEPTED (approval gate)', () => {
    assert.equal(canTransition('PLANNED', 'PATCHING'), false);
    assert.equal(canTransition('PLANNED', 'ACCEPTED'), false);
    assert.equal(canTransition('PATCHING', 'ACCEPTED'), false);
    assert.equal(canTransition('PATCHING', 'REVIEW_READY'), false);
    assert.equal(canTransition('VERIFYING', 'ACCEPTED'), false);
    assert.equal(canTransition('AWAITING_APPROVAL', 'PATCHING'), true);
  });

  test('canTransition is false for unknown states', () => {
    assert.equal(canTransition('NOPE', 'PLANNED'), false);
    assert.equal(canTransition('PLANNED', 'NOPE'), false);
  });

  test('tables are frozen', () => {
    assert.throws(() => TRANSITIONS.PLANNED.push('ACCEPTED'));
    assert.throws(() => { 'use strict'; TRANSITIONS.NEW = []; });
  });
});

describe('transitionSlice', () => {
  const p = K.makeProject();

  test('all (from, to) pairs: allowed succeed, disallowed throw UK_STATE_CONFLICT and change nothing', () => {
    let allowed = 0;
    let denied = 0;
    for (const from of STATES) {
      for (const to of STATES) {
        const slice = K.insertSlice(p.ctx, { state: from });
        const before = p.ctx.store.get('SELECT COUNT(*) AS n FROM events').n;
        if (canTransition(from, to)) {
          const out = transitionSlice(p.ctx, { slice, to, actor: 'runtime:test', reason: 'matrix' });
          assert.equal(out.state, to, `${from}->${to}`);
          assert.equal(out.version, slice.version + 1);
          assert.equal(p.ctx.store.get('SELECT COUNT(*) AS n FROM events').n, before + 1);
          allowed++;
        } else {
          assert.throws(() => transitionSlice(p.ctx, { slice, to, actor: 'runtime:test', reason: 'matrix' }), code('UK_STATE_CONFLICT'), `${from}->${to}`);
          assert.equal(K.loadSlice(p.ctx, slice.id).state, from);
          assert.equal(p.ctx.store.get('SELECT COUNT(*) AS n FROM events').n, before, 'no event for a refused transition');
          denied++;
        }
      }
    }
    assert.ok(allowed > 30 && denied > 200);
    assert.equal(verifyLedger(p.ctx.store, p.ctx.store.meta('audit_public_key')).ok, true);
  });

  test('unknown target state is UK_SCHEMA_INVALID', () => {
    const slice = K.insertSlice(p.ctx, { state: 'PLANNED' });
    assert.throws(() => transitionSlice(p.ctx, { slice, to: 'DONE', actor: 'runtime:t', reason: 'x' }), code('UK_SCHEMA_INVALID'));
    assert.throws(() => transitionSlice(p.ctx, { slice, to: undefined, actor: 'runtime:t', reason: 'x' }), code('UK_SCHEMA_INVALID'));
  });

  test('a failing guard throws UK_POLICY_DENIED and records nothing', () => {
    const slice = K.insertSlice(p.ctx, { state: 'AWAITING_APPROVAL' });
    const before = p.ctx.store.get('SELECT COUNT(*) AS n FROM events').n;
    assert.throws(
      () => transitionSlice(p.ctx, { slice, to: 'PATCHING', actor: 'runtime:t', reason: 'x', guards: [() => ({ ok: true, id: 'a' }), () => ({ ok: false, id: 'approvals', detail: 'missing code-owner' })] }),
      (e) => e.code === 'UK_POLICY_DENIED' && /missing code-owner/.test(e.message) && e.slice_id === slice.id,
    );
    assert.equal(K.loadSlice(p.ctx, slice.id).state, 'AWAITING_APPROVAL');
    assert.equal(K.loadSlice(p.ctx, slice.id).version, slice.version);
    assert.equal(p.ctx.store.get('SELECT COUNT(*) AS n FROM events').n, before);
  });

  test('all guards are evaluated and every failure is reported', () => {
    const slice = K.insertSlice(p.ctx, { state: 'AWAITING_APPROVAL' });
    let ran = 0;
    const g = (id) => () => (ran++, { ok: false, id });
    assert.throws(() => transitionSlice(p.ctx, { slice, to: 'PATCHING', actor: 'runtime:t', reason: 'x', guards: [g('one'), g('two')] }), (e) => /one/.test(e.message) && /two/.test(e.message));
    assert.equal(ran, 2);
  });

  test('guards on an illegal edge never run (state conflict wins)', () => {
    const slice = K.insertSlice(p.ctx, { state: 'PLANNED' });
    let ran = false;
    assert.throws(() => transitionSlice(p.ctx, { slice, to: 'PATCHING', actor: 'runtime:t', reason: 'x', guards: [() => ((ran = true), { ok: true, id: 'g' })] }), code('UK_STATE_CONFLICT'));
    assert.equal(ran, false);
  });

  test('passing guards are recorded in the transition event', () => {
    const slice = K.insertSlice(p.ctx, { state: 'AWAITING_APPROVAL' });
    transitionSlice(p.ctx, { slice, to: 'PATCHING', actor: 'human:q', reason: 'approved', run_id: 'run-x', guards: [() => ({ ok: true, id: 'approvals.fresh' })] });
    const ev = readEvents(p.ctx.store, { sliceId: slice.id }).at(-1);
    assert.equal(ev.type, 'state.transition');
    assert.equal(ev.actor, 'human:q');
    assert.equal(ev.run_id, 'run-x');
    assert.deepEqual([ev.payload.entity, ev.payload.from, ev.payload.to, ev.payload.reason], ['slice', 'AWAITING_APPROVAL', 'PATCHING', 'approved']);
    assert.equal(ev.payload.guards[0].id, 'approvals.fresh');
  });

  test('stale optimistic update fails with UK_STATE_CONFLICT and leaves no event', () => {
    const stale = K.insertSlice(p.ctx, { state: 'PLANNED' });
    transitionSlice(p.ctx, { slice: stale, to: 'AWAITING_APPROVAL', actor: 'runtime:t', reason: 'first' });
    const before = readEvents(p.ctx.store, { sliceId: stale.id }).length;
    // `stale` still says PLANNED / version 1; a concurrent writer already moved the row.
    assert.throws(() => transitionSlice(p.ctx, { slice: stale, to: 'NEEDS_REPLAN', actor: 'runtime:t', reason: 'second' }), code('UK_STATE_CONFLICT'));
    assert.equal(K.loadSlice(p.ctx, stale.id).state, 'AWAITING_APPROVAL');
    assert.equal(readEvents(p.ctx.store, { sliceId: stale.id }).length, before);
  });

  test('a stale object cannot replay an already-applied transition', () => {
    const slice = K.insertSlice(p.ctx, { state: 'PLANNED' });
    transitionSlice(p.ctx, { slice, to: 'AWAITING_APPROVAL', actor: 'runtime:t', reason: 'one' });
    assert.throws(() => transitionSlice(p.ctx, { slice, to: 'AWAITING_APPROVAL', actor: 'runtime:t', reason: 'again' }), code('UK_STATE_CONFLICT'));
  });

  test('actor format is enforced by the ledger and rolls the update back', () => {
    const slice = K.insertSlice(p.ctx, { state: 'PLANNED' });
    assert.throws(() => transitionSlice(p.ctx, { slice, to: 'AWAITING_APPROVAL', actor: 'root', reason: 'x' }), code('UK_SCHEMA_INVALID'));
    assert.equal(K.loadSlice(p.ctx, slice.id).state, 'PLANNED');
    assert.equal(K.loadSlice(p.ctx, slice.id).version, 1);
  });

  test('replaySliceStates rebuilds the projection from the ledger', () => {
    const q = K.makeProject();
    const a = K.insertSlice(q.ctx, { state: 'DIAGNOSED' });
    const b = K.insertSlice(q.ctx, { state: 'MAPPED' });
    let s = transitionSlice(q.ctx, { slice: a, to: 'PLANNED', actor: 'runtime:t', reason: 'r' });
    s = transitionSlice(q.ctx, { slice: s, to: 'AWAITING_APPROVAL', actor: 'runtime:t', reason: 'r' });
    s = transitionSlice(q.ctx, { slice: s, to: 'PATCHING', actor: 'runtime:t', reason: 'r' });
    s = transitionSlice(q.ctx, { slice: s, to: 'VERIFYING', actor: 'runtime:t', reason: 'r' });
    transitionSlice(q.ctx, { slice: b, to: 'ABANDONED', actor: 'runtime:t', reason: 'r' });
    // a failed transition must not appear in the replay
    assert.throws(() => transitionSlice(q.ctx, { slice: a, to: 'ACCEPTED', actor: 'runtime:t', reason: 'r' }));
    const replay = replaySliceStates(q.ctx.store);
    assert.equal(replay.get(a.id), 'VERIFYING');
    assert.equal(replay.get(b.id), 'ABANDONED');
    for (const row of q.ctx.store.all('SELECT id, state FROM slices')) assert.equal(replay.get(row.id), row.state);
  });

  test('replay ignores run-entity transitions', () => {
    const q = K.makeProject();
    const { run } = K.startTestRun(q);
    K.runs.setRunState(q.ctx, run.id, 'PAUSED', 'test');
    assert.equal(replaySliceStates(q.ctx.store).size, 0);
  });
});

describe('store primitives', () => {
  const q = K.makeProject();

  test('update() on a missing id is UK_NOT_FOUND; on a non-versioned table a TypeError; bad column a TypeError', () => {
    assert.throws(() => q.ctx.store.update('slices', 'UK-9999', 1, { state: 'x' }), code('UK_NOT_FOUND'));
    assert.throws(() => q.ctx.store.update('events', 'x', 1, { type: 'a.b' }), TypeError);
    const s = K.insertSlice(q.ctx);
    assert.throws(() => q.ctx.store.update('slices', s.id, 1, { 'state; DROP TABLE slices': 'x' }), TypeError);
    assert.throws(() => q.ctx.store.insert('slices; DROP TABLE x', { a: 1 }), TypeError);
  });

  test('update() with a stale version fails and bumps nothing', () => {
    const s = K.insertSlice(q.ctx);
    q.ctx.store.update('slices', s.id, 1, { risk: 'high' });
    assert.throws(() => q.ctx.store.update('slices', s.id, 1, { risk: 'low' }), (e) => e.code === 'UK_STATE_CONFLICT' && e.details.found === 2);
    assert.equal(K.loadSlice(q.ctx, s.id).risk, 'high');
  });

  test('nested tx: inner failure rolls back only the inner work', () => {
    q.ctx.store.tx(() => {
      q.ctx.store.bump('s', 'outer', 1);
      assert.throws(() => q.ctx.store.tx(() => {
        q.ctx.store.bump('s', 'inner', 1);
        throw new Error('inner');
      }), /inner/);
    });
    assert.deepEqual(q.ctx.store.counters('s'), { outer: 1 });
  });

  test('nextId is monotonic and zero-padded; bump accumulates', () => {
    assert.equal(q.ctx.store.nextId('F'), 'F-0001');
    assert.equal(q.ctx.store.nextId('F'), 'F-0002');
    assert.equal(q.ctx.store.nextId('G', 6), 'G-000001');
    assert.equal(q.ctx.store.bump('x', 'y', 2), 2);
    assert.equal(q.ctx.store.bump('x', 'y', 3), 5);
  });
});

describe('runs', () => {
  test('a second concurrent run is refused unless superseding', () => {
    const q = K.makeProject();
    const cfg = K.cfg();
    const r1 = K.runs.startRun(q.ctx, { command: 'map', actor: 'human:t', config: cfg, configDigest: 'sha256:c' });
    assert.throws(() => K.runs.startRun(q.ctx, { command: 'map', actor: 'human:t', config: cfg, configDigest: 'sha256:c' }), (e) => e.code === 'UK_STATE_CONFLICT' && e.run_id === r1.id);
    const r2 = K.runs.startRun(q.ctx, { command: 'diagnose', actor: 'human:t', config: cfg, configDigest: 'sha256:c', supersede: true });
    assert.equal(K.runs.getRun(q.ctx.store, r1.id).outcome, 'superseded');
    assert.equal(K.runs.activeRun(q.ctx.store).id, r2.id);
  });

  test('unknown command is rejected; run budget is a copy of limits', () => {
    const q = K.makeProject();
    assert.throws(() => K.runs.startRun(q.ctx, { command: 'rm-rf', actor: 'human:t', config: K.cfg(), configDigest: 'x' }), code('UK_CONFIG_INVALID'));
    const { run } = K.startTestRun(q);
    assert.equal(run.budget.max_changed_files, 12);
    assert.equal(run.commit_sha, q.commit);
  });

  test('endRun is idempotent, records usage and clears the active run', () => {
    const q = K.makeProject();
    const { run } = K.startTestRun(q);
    q.ctx.store.bump(run.id, 'tool_calls', 3);
    const ended = K.runs.endRun(q.ctx, run.id, { outcome: 'completed' });
    assert.deepEqual(ended.usage, { tool_calls: 3 });
    assert.equal(K.runs.activeRun(q.ctx.store), null);
    const n = q.ctx.store.get("SELECT COUNT(*) AS n FROM events WHERE type = 'run.ended'").n;
    K.runs.endRun(q.ctx, run.id, { outcome: 'failed' });
    assert.equal(q.ctx.store.get("SELECT COUNT(*) AS n FROM events WHERE type = 'run.ended'").n, n);
    assert.equal(K.runs.getRun(q.ctx.store, run.id).outcome, 'completed');
    assert.throws(() => K.runs.endRun(q.ctx, 'run-none'), code('UK_NOT_FOUND'));
  });
});
