// Lanes: one signed approval for the low-risk part of a campaign. A person signs, once, the
// exact plan of every slice in a campaign that fits: low risk, one required role, no
// protected paths. The agent may then apply and verify those slices without a per-slice plan
// approval, as long as each patch only deletes code or only changes tests, under a size cap.
// The change approval stays a person's: lane slices stop at REVIEW_READY and are accepted
// together with `unknot approve --lane`, after `unknot lane review`.
//
// What a lane binds: the slice ids and their plan digests (a replanned slice falls out), the
// policy digest (any config change voids it), the allowed patch kinds and caps, and an expiry.

import { canonicalJSON, digest, randomId } from '../core/canonical.mjs';
import { addMs, now, nowISO, parseDuration } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { matchAny } from '../core/glob.mjs';
import { keyFingerprint, publicKeyOf, signText, verifyText } from '../core/keys.mjs';
import { isTestCode } from '../graph/census.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { sliceDigest } from './approvals.mjs';
import { classifyRisk, requiredApprovals } from './risk.mjs';

export const LANE_KINDS = Object.freeze(['deletion', 'tests']);
export const LANE_DEFAULTS = Object.freeze({ kinds: ['deletion', 'tests'], max_changed_files: 5, max_diff_lines: 60, expiry: '72h' });

const neededFor = (slice, config) => requiredApprovals(classifyRisk(slice.body, { config, surfaces: slice.body.surfaces ?? {} }), config);

/** Why a slice cannot be in a lane (empty when it can). */
export function laneProblems(slice, config) {
  const problems = [];
  if (slice.state !== 'AWAITING_APPROVAL') problems.push(`state ${slice.state}`);
  if (slice.risk !== 'low') problems.push(`${slice.risk} risk`);
  const needed = neededFor(slice, config);
  if (needed.roles.length !== 1 || needed.min_approvers > 1) problems.push(`needs ${needed.roles.join('+')} from ${needed.min_approvers} approver(s)`);
  const touched = (slice.body.scope?.include ?? []).filter((g) => matchAny(g.replace(/\*+/g, 'x'), config.protected_paths, { nocase: true }));
  if (touched.length) problems.push(`protected paths ${touched.join(', ')}`);
  return problems;
}

/** The lane a person would sign for a campaign, with the slices it covers and those it leaves out. */
export function draftLane(ctx, { cfg, campaignId, kinds = LANE_DEFAULTS.kinds, maxFiles = LANE_DEFAULTS.max_changed_files, maxLines = LANE_DEFAULTS.max_diff_lines, expiry = LANE_DEFAULTS.expiry }) {
  const bad = kinds.filter((k) => !LANE_KINDS.includes(k));
  if (!kinds.length || bad.length) throw new UnknotError('UK_CONFIG_INVALID', `lane kinds must be some of ${LANE_KINDS.join(', ')}${bad.length ? `; got ${bad.join(', ')}` : ''}`);
  const caps = [maxFiles, maxLines];
  if (!caps.every((n) => Number.isInteger(n) && n > 0)) throw new UnknotError('UK_CONFIG_INVALID', 'lane caps must be positive integers');
  if (maxFiles > cfg.config.limits.max_changed_files || maxLines > cfg.config.limits.max_diff_lines) {
    throw new UnknotError('UK_POLICY_DENIED', `lane caps cannot exceed the configured limits (${cfg.config.limits.max_changed_files} files, ${cfg.config.limits.max_diff_lines} lines)`);
  }
  const rows = ctx.store.all('SELECT * FROM slices WHERE campaign_id = ? ORDER BY id', campaignId);
  if (!rows.length) throw new UnknotError('UK_NOT_FOUND', `no slices in campaign ${campaignId}`);
  const covered = {};
  const excluded = [];
  let role = null;
  for (const row of rows) {
    const slice = { ...row, body: JSON.parse(row.body) };
    const problems = laneProblems(slice, cfg.config);
    const r = problems.length ? null : neededFor(slice, cfg.config).roles[0];
    if (r && role && r !== role) problems.push(`needs role ${r}, not ${role}`);
    if (problems.length) excluded.push({ id: slice.id, problems });
    else {
      role ??= r;
      covered[slice.id] = sliceDigest(slice.body);
    }
  }
  const lane = {
    purpose: 'unknot-lane-v1',
    campaign_id: campaignId,
    kinds: [...new Set(kinds)].sort(),
    max_changed_files: maxFiles,
    max_diff_lines: maxLines,
    slices: covered,
    role,
    policy_digest: cfg.digest,
    expires_at: addMs(nowISO(), parseDuration(expiry)),
  };
  return { lane, excluded };
}

const statement = (lane, approver) => canonicalJSON({ lane, approver, purpose: 'unknot-lane-approval-v1' });

/** Sign and store a lane. The private key was unlocked with a passphrase on a TTY. */
export function recordLane(ctx, { config, lane, approver, privateKey, actor }) {
  if (!Object.keys(lane.slices).length) throw new UnknotError('UK_POLICY_DENIED', `no slice of ${lane.campaign_id} fits a lane`);
  const reg = config.approvers?.[approver];
  if (!reg) throw new UnknotError('UK_POLICY_DENIED', `${approver} is not a registered approver in .unknot/config.yaml`);
  if (!reg.roles.includes(lane.role)) throw new UnknotError('UK_POLICY_DENIED', `${approver} does not hold role ${lane.role}, which these slices need`);
  const pub = publicKeyOf(privateKey);
  if (keyFingerprint(pub) !== keyFingerprint(reg.public_key)) throw new UnknotError('UK_POLICY_DENIED', `the unlocked key is not ${approver}'s registered key`);
  const row = {
    id: `LN-${randomId(5)}`,
    campaign_id: lane.campaign_id,
    body: lane,
    approver,
    key_fingerprint: keyFingerprint(pub),
    signature: signText(privateKey, statement(lane, approver)),
    expires_at: lane.expires_at,
    created_at: nowISO(),
  };
  ctx.store.tx(() => {
    ctx.store.insert('lanes', row);
    appendEvent(ctx, { type: 'lane.approved', campaign_id: lane.campaign_id, actor: actor ?? `human:${approver}`, payload: { lane_id: row.id, slices: Object.keys(lane.slices), kinds: lane.kinds, caps: [lane.max_changed_files, lane.max_diff_lines], lane_hash: digest(lane) } });
  });
  return row;
}

const parse = (row) => ({ ...row, body: typeof row.body === 'string' ? JSON.parse(row.body) : row.body });

export function getLane(ctx, id) {
  const row = ctx.store.get('SELECT * FROM lanes WHERE id = ?', id);
  if (!row) throw new UnknotError('UK_NOT_FOUND', `no lane ${id}`);
  return parse(row);
}

export function lanesFor(ctx, campaignId = null) {
  const rows = campaignId ? ctx.store.all('SELECT * FROM lanes WHERE campaign_id = ? ORDER BY created_at', campaignId) : ctx.store.all('SELECT * FROM lanes ORDER BY created_at');
  return rows.map(parse);
}

/** Why a lane no longer holds (empty when it does), checked against the current config. */
export function laneValidity(lane, cfg) {
  const reasons = [];
  if (lane.revoked_at) reasons.push(`revoked: ${lane.revoked_reason ?? 'no reason given'}`);
  // The signed body is authoritative; the columns only index it.
  if (new Date(lane.body.expires_at) <= now()) reasons.push('expired');
  if (lane.body.policy_digest !== cfg.digest) reasons.push('the configuration changed since it was approved');
  const reg = cfg.config.approvers?.[lane.approver];
  if (!reg) reasons.push('approver no longer registered');
  else if (!reg.roles.includes(lane.body.role)) reasons.push('approver no longer holds the role');
  else if (!verifyText(reg.public_key, statement(lane.body, lane.approver), lane.signature)) reasons.push('signature does not verify');
  return reasons;
}

/**
 * The lane that approves this slice's plan right now, or the reasons none does.
 * @returns {{lane: object|null, reasons: string[]}}
 */
export function laneFor(ctx, { cfg, slice }) {
  if (!slice.campaign_id) return { lane: null, reasons: ['the slice is not in a campaign'] };
  const reasons = [];
  for (const lane of lanesFor(ctx, slice.campaign_id).reverse()) {
    const why = laneValidity(lane, cfg);
    const signed = lane.body.slices[slice.id];
    if (!signed) why.push(`${slice.id} is not in it`);
    else if (signed !== sliceDigest(slice.body)) why.push(`${slice.id} changed since it was approved`);
    const problems = laneProblems({ ...slice, state: 'AWAITING_APPROVAL' }, cfg.config);
    if (problems.length) why.push(...problems);
    else if (neededFor(slice, cfg.config).roles[0] !== lane.body.role) why.push(`${slice.id} now needs a different role`);
    if (!why.length) return { lane, reasons: [] };
    reasons.push(`${lane.id}: ${why.join('; ')}`);
  }
  return { lane: null, reasons: reasons.length ? reasons : [`no lane for ${slice.campaign_id}`] };
}

/** Whether a staged patch stays inside the lane: only deletions or only tests, within the caps. */
export function checkLaneDiff(lane, stat) {
  const problems = [];
  const body = lane.body ?? lane;
  if (stat.files > body.max_changed_files) problems.push(`${stat.files} files changed (lane cap ${body.max_changed_files})`);
  if (stat.lines > body.max_diff_lines) problems.push(`${stat.lines} lines changed (lane cap ${body.max_diff_lines})`);
  const fits = { deletion: stat.added === 0, tests: stat.paths.every((p) => isTestCode(p)) };
  if (!body.kinds.some((k) => fits[k])) {
    const nonTest = stat.paths.filter((p) => !isTestCode(p));
    problems.push(body.kinds.map((k) => (k === 'deletion' ? `adds ${stat.added} line(s), so it is not deletion-only` : `changes non-test files (${nonTest.slice(0, 3).join(', ')})`)).join(' and '));
  }
  return { ok: problems.length === 0, problems };
}

/** The lane a slice is being patched under, from the ledger (null when a person approved its plan). */
export function laneOfSlice(ctx, sliceId) {
  const row = ctx.store.get("SELECT payload FROM events WHERE type = 'lane.applied' AND slice_id = ? ORDER BY seq DESC LIMIT 1", sliceId);
  if (!row) return null;
  const { lane_id } = JSON.parse(row.payload);
  return lane_id ? getLane(ctx, lane_id) : null;
}

/** Slices whose latest start was under this lane, with their current state. */
export function laneSlices(ctx, laneId) {
  const ids = ctx.store.all("SELECT DISTINCT slice_id FROM events WHERE type = 'lane.applied' AND json_extract(payload, '$.lane_id') = ?", laneId).map((r) => r.slice_id).filter((id) => laneOfSlice(ctx, id)?.id === laneId);
  return ids.map((id) => ctx.store.get('SELECT id, state, risk, diff_hash, baseline_commit, worktree, branch, body FROM slices WHERE id = ?', id)).filter(Boolean).map((s) => ({ ...s, body: JSON.parse(s.body) }));
}

export function revokeLane(ctx, id, { reason, actor }) {
  const lane = getLane(ctx, id);
  if (lane.revoked_at) return lane;
  ctx.store.tx(() => {
    ctx.store.run('UPDATE lanes SET revoked_at = ?, revoked_reason = ? WHERE id = ?', nowISO(), reason ?? null, id);
    appendEvent(ctx, { type: 'lane.revoked', campaign_id: lane.campaign_id, actor, payload: { lane_id: id, reason: reason ?? null } });
  });
  return getLane(ctx, id);
}
