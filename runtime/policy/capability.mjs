// Capability tokens (spec §16.3): what one actor may do in one run, for a limited time.
// Issued on SubagentStart, revoked on SubagentStop, checked on every PreToolUse. A token
// is an HMAC over its grant, and it must also exist unrevoked in the store, so neither a
// forged nor a replayed token works.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJSON, randomId } from '../core/canonical.mjs';
import { addMs, now, nowISO, parseDuration } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { capabilityKey } from '../core/keys.mjs';
import { appendEvent } from '../state/ledger.mjs';

/**
 * Least-privilege profiles per agent (spec §7). Read access is always bounded by the run
 * scope and the secret-path denylist; write access by the paths named here, resolved
 * against the run's context (worktree, docs paths) at issue time.
 */
export const PROFILES = Object.freeze({
  orchestrator: { ops: ['fs.read', 'unknot.cli'], write: [] },
  cartographer: { ops: ['fs.read', 'unknot.read'], write: [] },
  'runtime-observer': { ops: ['fs.read', 'unknot.read'], write: [] },
  'domain-analyst': { ops: ['fs.read', 'unknot.read'], write: [] },
  'database-analyst': { ops: ['fs.read', 'unknot.read'], write: [] },
  'infrastructure-analyst': { ops: ['fs.read', 'unknot.read'], write: [] },
  'decomposition-strategist': { ops: ['fs.read', 'unknot.read'], write: [] },
  'security-reviewer': { ops: ['fs.read', 'unknot.read', 'unknot.scan'], write: [] },
  'simplification-planner': { ops: ['fs.read', 'unknot.read', 'unknot.plan'], write: [] },
  refactorer: { ops: ['fs.read', 'fs.write', 'unknot.read'], write: ['<worktree-scope>'] },
  verifier: { ops: ['fs.read', 'unknot.read', 'unknot.verify'], write: [] },
  'documentation-curator': { ops: ['fs.read', 'fs.write', 'unknot.read'], write: ['<docs>'] },
  // Any agent that is not one of ours (general-purpose, Explore, another plugin's) gets
  // the narrowest profile while an Unknot run is active.
  foreign: { ops: ['fs.read'], write: [] },
});

export function profileFor(agentType) {
  if (!agentType) return null;
  const name = String(agentType).replace(/^unknot:/, '');
  return PROFILES[name] ? { name, ...PROFILES[name] } : { name: 'foreign', ...PROFILES.foreign };
}

function mac(projectId, payload) {
  return createHmac('sha256', capabilityKey(projectId)).update(payload).digest('base64url');
}

/**
 * Issue a capability. `grant.write` holds concrete globs, already resolved.
 * @returns {{token: string, grant: object}}
 */
export function issueCapability(ctx, { run_id, agent_id = null, agent_type = null, ops, write = [], read = ['**'], ttl = '2h', budget = {}, issued_by = 'hook:SubagentStart' }) {
  const grant = {
    id: `cap-${randomId(6)}`,
    run_id,
    agent_id,
    agent_type,
    ops: [...ops].sort(),
    read,
    write,
    environment: 'local',
    issued_at: nowISO(),
    expires_at: addMs(nowISO(), parseDuration(ttl)),
    budget,
  };
  const payload = Buffer.from(canonicalJSON(grant)).toString('base64url');
  const token = `${payload}.${mac(ctx.projectId, payload)}`;
  ctx.store.tx(() => {
    ctx.store.insert('capabilities', {
      id: grant.id,
      run_id,
      agent_id,
      agent_type,
      grant_json: grant,
      issued_at: grant.issued_at,
      expires_at: grant.expires_at,
    });
    appendEvent(ctx, { type: 'capability.issued', run_id, actor: issued_by.includes(':') ? issued_by : `hook:${issued_by}`, capability_id: grant.id, payload: { agent_type, agent_id, ops: grant.ops, write } });
  });
  return { token, grant };
}

/** Verify a token string; returns the grant or throws UK_POLICY_DENIED. */
export function verifyToken(ctx, token) {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) throw new UnknotError('UK_POLICY_DENIED', 'malformed capability token');
  const expected = Buffer.from(mac(ctx.projectId, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new UnknotError('UK_POLICY_DENIED', 'capability token signature invalid');
  }
  const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return checkGrant(ctx, grant);
}

function checkGrant(ctx, grant) {
  const row = ctx.store.get('SELECT * FROM capabilities WHERE id = ?', grant.id);
  if (!row) throw new UnknotError('UK_POLICY_DENIED', `capability ${grant.id} was never issued here`);
  if (row.revoked_at) throw new UnknotError('UK_POLICY_DENIED', `capability ${grant.id} was revoked`);
  if (new Date(row.expires_at) <= now()) throw new UnknotError('UK_POLICY_DENIED', `capability ${grant.id} expired`);
  return grant;
}

/** The live capability of a subagent in the active run, or null. */
export function capabilityForAgent(ctx, runId, agentId) {
  const row = ctx.store.get(
    'SELECT * FROM capabilities WHERE run_id = ? AND agent_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1',
    runId,
    agentId,
  );
  if (!row) return null;
  try {
    return checkGrant(ctx, JSON.parse(row.grant_json));
  } catch {
    return null;
  }
}

export function revokeCapabilities(ctx, { run_id, agent_id, reason = 'agent stopped', actor = 'hook:SubagentStop' }) {
  const rows = ctx.store.all(
    'SELECT id FROM capabilities WHERE run_id = ? AND agent_id IS ? AND revoked_at IS NULL',
    run_id,
    agent_id ?? null,
  );
  if (!rows.length) return 0;
  ctx.store.tx(() => {
    for (const r of rows) {
      ctx.store.run('UPDATE capabilities SET revoked_at = ? WHERE id = ?', nowISO(), r.id);
      appendEvent(ctx, { type: 'capability.revoked', run_id, actor, capability_id: r.id, payload: { reason } });
    }
  });
  return rows.length;
}
