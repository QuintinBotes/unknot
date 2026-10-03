// The append-only event ledger (spec §6.1, §6.2, §16.3).
//
// Each event's hash covers the previous event's hash, so editing or deleting any row
// breaks every hash after it; each hash is also signed with the project's audit key, so
// rebuilding the whole chain requires that key. Current state everywhere else in the
// store is a projection that can be rebuilt from this table.

import { canonicalJSON, digest, randomId } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { auditPrivateKey, signText, verifyText } from '../core/keys.mjs';

export const EVENT_SCHEMA_VERSION = '1.0';
export const GENESIS = 'sha256:genesis';
const TYPE = /^[a-z]+(?:\.[a-z_]+)+$/;

const ACTOR = /^(human|model|runtime|hook|daemon|ci):[A-Za-z0-9@._:/-]{1,128}$/;

/**
 * Append one event. Every operation carries run, campaign, slice, scope, actor,
 * capability, budget and policy decision (spec §6.1); absent ones are recorded as null.
 */
export function appendEvent(ctx, event) {
  const { store, projectId } = ctx;
  if (!TYPE.test(event.type ?? '')) throw new UnknotError('UK_SCHEMA_INVALID', `bad event type ${event.type}`);
  if (!ACTOR.test(event.actor ?? '')) throw new UnknotError('UK_SCHEMA_INVALID', `bad event actor ${event.actor}`);
  return store.tx(() => {
    const prev = store.get('SELECT hash FROM events ORDER BY seq DESC LIMIT 1')?.hash ?? GENESIS;
    const body = {
      schema_version: EVENT_SCHEMA_VERSION,
      id: `ev-${randomId(8)}`,
      type: event.type,
      run_id: event.run_id ?? null,
      campaign_id: event.campaign_id ?? null,
      slice_id: event.slice_id ?? null,
      actor: event.actor,
      capability_id: event.capability_id ?? null,
      scope: event.scope ?? null,
      budget: event.budget ?? null,
      policy_decision: event.policy_decision ?? null,
      payload: event.payload ?? {},
      at: event.at ?? nowISO(),
      prev_hash: prev,
    };
    const hash = digest(body);
    let signature = null;
    if (projectId) signature = signText(auditPrivateKey(projectId), hash);
    store.insert('events', {
      ...body,
      scope: body.scope,
      budget: body.budget,
      policy_decision: body.policy_decision,
      payload: canonicalJSON(body.payload),
      hash,
      signature,
    });
    return { ...body, hash, signature };
  });
}

function rowToBody(row) {
  const j = (v) => (v === null ? null : JSON.parse(v));
  return {
    schema_version: row.schema_version,
    id: row.id,
    type: row.type,
    run_id: row.run_id,
    campaign_id: row.campaign_id,
    slice_id: row.slice_id,
    actor: row.actor,
    capability_id: row.capability_id,
    scope: j(row.scope),
    budget: j(row.budget),
    policy_decision: j(row.policy_decision),
    payload: JSON.parse(row.payload),
    at: row.at,
    prev_hash: row.prev_hash,
  };
}

export function readEvents(store, { runId, sliceId, type, afterSeq = 0, limit = 10_000 } = {}) {
  const where = ['seq > ?'];
  const params = [afterSeq];
  if (runId) where.push('run_id = ?'), params.push(runId);
  if (sliceId) where.push('slice_id = ?'), params.push(sliceId);
  if (type) where.push('type = ?'), params.push(type);
  return store
    .all(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`, ...params, limit)
    .map((row) => ({ seq: row.seq, ...rowToBody(row), hash: row.hash, signature: row.signature }));
}

/**
 * Recompute the chain. Returns the first broken link instead of throwing, so `doctor`
 * and the audit export can report exactly where tampering starts.
 */
export function verifyLedger(store, publicKeyPem) {
  let prev = GENESIS;
  let count = 0;
  for (const row of store.db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
    const body = rowToBody(row);
    if (body.prev_hash !== prev) return { ok: false, count, broken_at: row.seq, reason: 'prev_hash does not link' };
    const hash = digest(body);
    if (hash !== row.hash) return { ok: false, count, broken_at: row.seq, reason: 'hash does not match content' };
    if (publicKeyPem && !(row.signature && verifyText(publicKeyPem, row.hash, row.signature))) {
      return { ok: false, count, broken_at: row.seq, reason: 'signature invalid or missing' };
    }
    prev = row.hash;
    count++;
  }
  return { ok: true, count, head: prev };
}
