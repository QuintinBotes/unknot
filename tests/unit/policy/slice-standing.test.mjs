import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { laneLine, sliceStanding } from '../../../runtime/policy/lanes.mjs';

const slice = (body, risk = 'low') => ({ id: 'UK-0001', state: 'AWAITING_APPROVAL', risk, body: { objective: 'x', changes: [], scope: { include: ['src/orders/a.cs'], exclude: [] }, ...body } });

test('a slice says why it has its risk, who approves it, and whether a lane can cover it', () => {
  const config = K.cfg({ protected_paths: ['src/billing/**'] });
  const plain = sliceStanding(slice({}), config);
  assert.deepEqual(plain.risk_reasons, ['no risk factor found']);
  assert.deepEqual(plain.approvals.roles, ['code-owner']);
  assert.equal(laneLine(plain), 'lane: eligible');

  const boundary = sliceStanding(slice({ treatment: 'T1' }, 'medium'), config);
  assert.match(boundary.risk_reasons.join(' '), /treatment T1 changes module boundaries/);
  assert.equal(boundary.lane.eligible, false);
  assert.match(laneLine(boundary), /^lane: not eligible \(medium risk; needs .*code-owner.*\)/);

  const guarded = sliceStanding(slice({ scope: { include: ['src/billing/x.cs'], exclude: [] } }, 'high'), config);
  assert.match(guarded.risk_reasons.join(' '), /protected paths/);
  assert.match(laneLine(guarded), /protected paths src\/billing\/x\.cs/);
});
