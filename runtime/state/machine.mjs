// The slice/project state machine (spec §6.2). Transitions are append-only events; the
// `state` column on runs and slices is a projection of them.
//
// Guards are supplied by the caller (they need approvals, evidence and policy, which live
// elsewhere) and are evaluated here, so no code path can move a slice without them.

import { UnknotError } from '../core/errors.mjs';
import { appendEvent } from './ledger.mjs';

export const STATES = Object.freeze([
  'UNINITIALIZED',
  'BASELINING',
  'MAPPED',
  'DIAGNOSED',
  'PLANNED',
  'AWAITING_APPROVAL',
  'PATCHING',
  'VERIFYING',
  'REVIEW_READY',
  'ACCEPTED',
  'BLOCKED_BASELINE',
  'BLOCKED_POLICY',
  'BLOCKED_UNCERTAINTY',
  'NEEDS_REPLAN',
  'VERIFICATION_FAILED',
  'ROLLED_BACK',
  'ABANDONED',
]);

export const TERMINAL = new Set(['ABANDONED']);

const T = {
  UNINITIALIZED: ['BASELINING'],
  BASELINING: ['MAPPED', 'BLOCKED_BASELINE', 'ABANDONED'],
  BLOCKED_BASELINE: ['BASELINING', 'ABANDONED'],
  MAPPED: ['DIAGNOSED', 'BASELINING', 'ABANDONED'],
  DIAGNOSED: ['PLANNED', 'DIAGNOSED', 'BASELINING', 'ABANDONED'],
  PLANNED: ['AWAITING_APPROVAL', 'NEEDS_REPLAN', 'BLOCKED_POLICY', 'ABANDONED'],
  AWAITING_APPROVAL: ['PATCHING', 'NEEDS_REPLAN', 'BLOCKED_POLICY', 'ABANDONED'],
  PATCHING: ['VERIFYING', 'NEEDS_REPLAN', 'BLOCKED_POLICY', 'ROLLED_BACK', 'ABANDONED'],
  VERIFYING: ['REVIEW_READY', 'VERIFICATION_FAILED', 'BLOCKED_UNCERTAINTY', 'NEEDS_REPLAN', 'BLOCKED_POLICY'],
  VERIFICATION_FAILED: ['PATCHING', 'NEEDS_REPLAN', 'ROLLED_BACK', 'ABANDONED'],
  BLOCKED_UNCERTAINTY: ['VERIFYING', 'NEEDS_REPLAN', 'ABANDONED'],
  REVIEW_READY: ['ACCEPTED', 'PATCHING', 'ROLLED_BACK', 'ABANDONED', 'NEEDS_REPLAN'],
  ACCEPTED: ['ROLLED_BACK'],
  BLOCKED_POLICY: ['PLANNED', 'AWAITING_APPROVAL', 'PATCHING', 'VERIFYING', 'NEEDS_REPLAN', 'ABANDONED'],
  NEEDS_REPLAN: ['PLANNED', 'ABANDONED'],
  ROLLED_BACK: ['PLANNED', 'ABANDONED'],
  ABANDONED: [],
};
export const TRANSITIONS = Object.freeze(Object.fromEntries(Object.entries(T).map(([k, v]) => [k, Object.freeze(v)])));

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Validate and record one transition of a slice.
 * @param {object} ctx project context
 * @param {{slice: object, to: string, actor: string, reason: string, run_id?: string,
 *          guards?: Array<() => {ok: boolean, id: string, detail?: string}>}} t
 * @returns the updated slice row
 */
export function transitionSlice(ctx, { slice, to, actor, reason, run_id = null, guards = [], extra = {} }) {
  if (!STATES.includes(to)) throw new UnknotError('UK_SCHEMA_INVALID', `unknown state ${to}`);
  if (!canTransition(slice.state, to)) {
    throw new UnknotError('UK_STATE_CONFLICT', `slice ${slice.id} cannot go from ${slice.state} to ${to}`, {
      slice_id: slice.id,
      details: { from: slice.state, to, allowed: TRANSITIONS[slice.state] },
    });
  }
  const results = guards.map((g) => g());
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new UnknotError('UK_POLICY_DENIED', `transition ${slice.state} → ${to} blocked: ${failed.map((f) => f.detail ?? f.id).join('; ')}`, {
      slice_id: slice.id,
      details: { guards: results },
    });
  }
  return ctx.store.tx(() => {
    ctx.store.update('slices', slice.id, slice.version, { state: to, updated_at: new Date().toISOString(), ...extra });
    appendEvent(ctx, {
      type: 'state.transition',
      run_id,
      campaign_id: slice.campaign_id,
      slice_id: slice.id,
      actor,
      payload: { entity: 'slice', from: slice.state, to, reason, guards: results },
    });
    return ctx.store.get('SELECT * FROM slices WHERE id = ?', slice.id);
  });
}

/**
 * Rebuild every slice's state from the ledger. Used by `doctor --repair` after an
 * interrupted run: the ledger is authoritative, the column is a cache.
 */
export function replaySliceStates(store) {
  const states = new Map();
  for (const row of store.db.prepare("SELECT slice_id, payload FROM events WHERE type = 'state.transition' ORDER BY seq").iterate()) {
    const p = JSON.parse(row.payload);
    if (p.entity === 'slice' && row.slice_id) states.set(row.slice_id, p.to);
  }
  return states;
}
