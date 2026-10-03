// Approvals (spec §16.3, §20). An approval is an Ed25519 signature by a registered
// approver over the exact thing approved: commit, slice version and digest, diff hash,
// infra plan hash and state serial, policy digest, environment and expiry. Any material
// change produces a different binding, so the old signature simply stops matching.

import { canonicalJSON, digest, randomId } from '../core/canonical.mjs';
import { addMs, now, nowISO, parseDuration } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { keyFingerprint, publicKeyOf, signText, verifyText } from '../core/keys.mjs';
import { appendEvent } from '../state/ledger.mjs';

export const STAGES = Object.freeze(['plan', 'change', 'rollback']);

/** The digest of a slice's approvable content: everything except its lifecycle fields. */
export function sliceDigest(body) {
  const { status, state, approvals_recorded, updated_at, ...rest } = body;
  return digest(rest);
}

export function bindingFor({ slice, stage, commit, policyDigest, diffHash = null, planHash = null, stateSerial = null, environment = 'local', expiry = '72h' }) {
  if (!STAGES.includes(stage)) throw new UnknotError('UK_SCHEMA_INVALID', `bad approval stage ${stage}`);
  if (stage !== 'plan' && !diffHash) throw new UnknotError('UK_APPROVAL_REQUIRED', `${stage} approval needs a diff hash`);
  return {
    commit,
    slice_id: slice.id,
    slice_version: slice.body.version ?? 1,
    slice_digest: sliceDigest(slice.body),
    diff_hash: diffHash,
    plan_hash: planHash,
    state_serial: stateSerial,
    policy_digest: policyDigest,
    environment,
    stage,
    expires_at: addMs(nowISO(), parseDuration(expiry)),
  };
}

function statement(binding, role, approver) {
  return canonicalJSON({ binding, role, approver, purpose: 'unknot-approval-v1' });
}

/**
 * Record an approval. The private key comes from an approver key unlocked with a
 * passphrase on a TTY (see cli/approve); the runtime never sees the passphrase.
 */
export function recordApproval(ctx, { config, slice, binding, role, approver, privateKey, actor }) {
  const reg = config.approvers?.[approver];
  if (!reg) throw new UnknotError('UK_POLICY_DENIED', `${approver} is not a registered approver in .unknot/config.yaml`);
  if (!reg.roles.includes(role)) throw new UnknotError('UK_POLICY_DENIED', `${approver} does not hold role ${role}`);
  const pub = publicKeyOf(privateKey);
  if (keyFingerprint(pub) !== keyFingerprint(reg.public_key)) {
    throw new UnknotError('UK_POLICY_DENIED', `the unlocked key is not ${approver}'s registered key`);
  }
  if (slice.body.proposed_by && slice.body.proposed_by === `human:${approver}` && ['high', 'critical'].includes(slice.risk)) {
    throw new UnknotError('UK_POLICY_DENIED', `${approver} proposed ${slice.id}; a ${slice.risk}-risk slice needs a different approver`);
  }
  const signature = signText(privateKey, statement(binding, role, approver));
  const row = {
    id: `AP-${randomId(5)}`,
    slice_id: slice.id,
    stage: binding.stage,
    role,
    approver,
    key_fingerprint: keyFingerprint(pub),
    binding,
    binding_hash: digest(binding),
    signature,
    expires_at: binding.expires_at,
    created_at: nowISO(),
  };
  ctx.store.tx(() => {
    ctx.store.insert('approvals', row);
    appendEvent(ctx, {
      type: 'approval.recorded',
      slice_id: slice.id,
      campaign_id: slice.campaign_id,
      actor: actor ?? `human:${approver}`,
      payload: { approval_id: row.id, stage: binding.stage, role, binding_hash: row.binding_hash },
    });
  });
  return row;
}

const BOUND_FIELDS = ['commit', 'slice_id', 'slice_version', 'slice_digest', 'diff_hash', 'plan_hash', 'state_serial', 'policy_digest', 'environment', 'stage'];

/**
 * Evaluate approvals for a stage against the current binding.
 * @returns {{satisfied: boolean, valid: object[], stale: {id: string, reasons: string[]}[], missing_roles: string[], approvers: number, needed: {roles: string[], min_approvers: number}}}
 */
export function evaluateApprovals(ctx, { config, slice, current, needed }) {
  const rows = ctx.store.all('SELECT * FROM approvals WHERE slice_id = ? AND stage = ? AND revoked_at IS NULL', slice.id, current.stage);
  const valid = [];
  const stale = [];
  for (const r of rows) {
    const binding = JSON.parse(r.binding);
    const reasons = [];
    const reg = config.approvers?.[r.approver];
    if (!reg) reasons.push('approver no longer registered');
    else if (!reg.roles.includes(r.role)) reasons.push('approver no longer holds the role');
    else if (!verifyText(reg.public_key, statement(binding, r.role, r.approver), r.signature)) reasons.push('signature does not verify');
    for (const f of BOUND_FIELDS) if ((binding[f] ?? null) !== (current[f] ?? null)) reasons.push(`${f} changed`);
    if (new Date(binding.expires_at) <= now()) reasons.push('expired');
    if (reasons.length) stale.push({ id: r.id, role: r.role, approver: r.approver, reasons });
    else valid.push({ id: r.id, role: r.role, approver: r.approver });
  }
  const covered = new Set(valid.map((v) => v.role));
  const missing = needed.roles.filter((role) => !covered.has(role));
  const people = new Set(valid.map((v) => v.approver)).size;
  return {
    satisfied: missing.length === 0 && people >= needed.min_approvers,
    valid,
    stale,
    missing_roles: missing,
    approvers: people,
    needed,
  };
}

/** Revoke every live approval of a slice (any stage) after a material change. */
export function invalidateApprovals(ctx, slice, reason, actor = 'runtime:unknot') {
  const rows = ctx.store.all('SELECT id, stage FROM approvals WHERE slice_id = ? AND revoked_at IS NULL', slice.id);
  if (!rows.length) return 0;
  ctx.store.tx(() => {
    for (const r of rows) {
      ctx.store.run('UPDATE approvals SET revoked_at = ?, revoked_reason = ? WHERE id = ?', nowISO(), reason, r.id);
    }
    appendEvent(ctx, { type: 'approval.invalidated', slice_id: slice.id, actor, payload: { reason, approvals: rows.map((r) => r.id) } });
  });
  return rows.length;
}
