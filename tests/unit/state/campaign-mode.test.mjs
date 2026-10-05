import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';

test('outside campaign mode a run handles one slice; campaign mode moves on only after the slice settles', () => {
  const p = K.makeProject();
  for (const [id, state, campaign] of [['UK-0001', 'PATCHING', 'CMP-1'], ['UK-0002', 'AWAITING_APPROVAL', 'CMP-1'], ['UK-0003', 'AWAITING_APPROVAL', 'CMP-2']]) {
    K.insertSlice(p.ctx, { id, state });
    p.ctx.store.run('UPDATE slices SET campaign_id = ? WHERE id = ?', campaign, id);
  }
  const { run } = K.startTestRun(p, { command: 'apply', slice_id: 'UK-0001' });
  assert.throws(() => K.runs.setRunSlice(p.ctx, run.id, 'UK-0002', 'model:main', { mode: 'governed' }), /one slice/);
  assert.throws(() => K.runs.setRunSlice(p.ctx, run.id, 'UK-0002', 'model:main', { mode: 'campaign' }), /finish UK-0001/);
  p.ctx.store.run("UPDATE slices SET state = 'REVIEW_READY' WHERE id = 'UK-0001'");
  assert.throws(() => K.runs.setRunSlice(p.ctx, run.id, 'UK-0003', 'model:main', { mode: 'campaign' }), /stays within campaign CMP-1/);
  assert.equal(K.runs.setRunSlice(p.ctx, run.id, 'UK-0002', 'model:main', { mode: 'campaign' }).slice_id, 'UK-0002');
});

test('a run takes on a slice only for slice commands and only within the ids the person typed (security review)', () => {
  const p = K.makeProject();
  K.insertSlice(p.ctx, { id: 'UK-0101', state: 'AWAITING_APPROVAL' });
  K.insertSlice(p.ctx, { id: 'UK-0102', state: 'AWAITING_APPROVAL' });
  const { run: mapRun } = K.startTestRun(p, { command: 'map' });
  assert.throws(() => K.runs.setRunSlice(p.ctx, mapRun.id, 'UK-0101', 'model:main'), /a map run cannot take on slice/);
  K.runs.endRun(p.ctx, mapRun.id, { outcome: 'completed' });
  const { run } = K.startTestRun(p, { command: 'apply' });
  p.ctx.store.run('UPDATE runs SET scope = ? WHERE id = ?', JSON.stringify(['UK-0102']), run.id);
  assert.throws(() => K.runs.setRunSlice(p.ctx, run.id, 'UK-0101', 'model:main'), /scoped to UK-0102/);
  assert.equal(K.runs.setRunSlice(p.ctx, run.id, 'UK-0102', 'model:main').slice_id, 'UK-0102');
});
