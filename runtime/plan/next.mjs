// /unknot:next (spec §17.4): the smallest unblocked slice, preferring better evidence,
// lower blast radius, stronger reversibility, earlier risk retirement, reduced future
// migration cost and less cross-team coordination — in that order.

import { loadConfig } from '../policy/config.mjs';
import { evidenceRefusal } from '../policy/evidence.mjs';
import { planOnlyReason } from '../policy/kinds.mjs';
import { conventionDrift } from './staleness.mjs';

const BLAST = { local: 0, bounded: 1, moderate: 2, high: 3 };
const REVERSIBILITY = { revert: 0, compensate: 1, roll_forward: 2, fail_over: 2, recreate: 3, restore: 4 };
const READY = new Set(['AWAITING_APPROVAL', 'PLANNED', 'NEEDS_REPLAN', 'VERIFICATION_FAILED']);

function evidenceOf(ctx, body) {
  let best = 0.5;
  for (const src of body.sources ?? []) {
    if (src.startsWith('F-')) {
      const row = ctx.store.get('SELECT body FROM findings WHERE id = ?', src);
      if (row) best = Math.max(best, JSON.parse(row.body).priority?.factors?.evidence ?? 0.5);
    } else if (src.startsWith('DEC-')) best = Math.max(best, 0.7);
  }
  return best;
}

/**
 * Why `apply start` would refuse this slice whatever is approved (#178), from the same checks it
 * runs: `{ plan_only }` for a kind `apply.allowed_kinds` refuses, `{ waits_on_evidence, ways_forward }`
 * for weak evidence without `evidence.allow_weak`; null when neither holds it back.
 */
export function applyHold(ctx, slice, config) {
  const planOnly = planOnlyReason(ctx, slice.body, config);
  if (planOnly) return { plan_only: planOnly };
  // A resumed slice is past the evidence check; apply runs it only before the first patch.
  const weak = slice.state === 'VERIFICATION_FAILED' ? null : evidenceRefusal(ctx, slice, config);
  return weak && { waits_on_evidence: weak.message, ways_forward: weak.details.ways_forward };
}

export function selectNext(ctx, { campaign = null, config = loadConfig(ctx).config } = {}) {
  const rows = ctx.store.all(`SELECT * FROM slices ${campaign ? 'WHERE campaign_id = ?' : ''} ORDER BY id`, ...(campaign ? [campaign] : []));
  const byId = new Map(rows.map((r) => [r.id, { ...r, body: JSON.parse(r.body) }]));
  const dependents = new Map();
  for (const s of byId.values()) for (const p of s.body.preconditions) dependents.set(p, (dependents.get(p) ?? 0) + 1);
  const candidates = [];
  const blocked = [];
  const planOnly = [];
  const waitsOnEvidence = [];
  for (const s of byId.values()) {
    if (!READY.has(s.state)) continue;
    const open = s.body.preconditions.filter((p) => {
      const pre = byId.get(p) ?? (() => {
        const r = ctx.store.get('SELECT state FROM slices WHERE id = ?', p);
        return r ? { state: r.state } : null;
      })();
      return !pre || pre.state !== 'ACCEPTED';
    });
    if (open.length) {
      // Say which dependency apply would refuse, and why, so the wait is not silent (#217).
      const heldBy = open.flatMap((p) => {
        const pre = byId.get(p);
        const hold = pre && READY.has(pre.state) && applyHold(ctx, pre, config);
        return hold ? [{ id: p, reason: hold.plan_only ?? hold.waits_on_evidence }] : [];
      });
      blocked.push({ id: s.id, waiting_for: open, ...(heldBy.length && { held_by: heldBy }) });
      continue;
    }
    const hold = applyHold(ctx, s, config);
    if (hold?.plan_only) {
      planOnly.push({ id: s.id, reason: hold.plan_only });
      continue;
    }
    if (hold) {
      waitsOnEvidence.push({ id: s.id, reason: hold.waits_on_evidence, ways_forward: hold.ways_forward });
      continue;
    }
    const drift = conventionDrift(ctx, s);
    candidates.push({
      ...(drift.length && { reapproval: drift.map((f) => `conventions changed (${f})`).join(', ') }),
      id: s.id,
      state: s.state,
      objective: s.body.objective,
      risk: s.risk,
      key: [
        -evidenceOf(ctx, s.body),
        BLAST[s.body.blast_radius] ?? 2,
        REVERSIBILITY[s.body.recovery?.type] ?? 3,
        s.body.treatment === undefined && /characteri/i.test(s.body.objective) ? 0 : 1,
        -(dependents.get(s.id) ?? 0),
        (s.body.owners ?? []).length,
        s.body.changes.length || s.body.scope.include.length,
      ],
    });
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return a.id.localeCompare(b.id);
  });
  const pick = candidates[0] ?? null;
  return {
    next: pick && { id: pick.id, state: pick.state, objective: pick.objective, risk: pick.risk, why: explain(pick.key), ...(pick.reapproval && { needs_reapproval: pick.reapproval }) },
    alternatives: candidates.slice(1, 5).map(({ id, objective, risk, reapproval }) => ({ id, objective, risk, ...(reapproval && { needs_reapproval: reapproval }) })),
    blocked,
    plan_only: planOnly,
    waits_on_evidence: waitsOnEvidence,
  };
}

function explain(key) {
  return [
    `evidence strength ${(-key[0]).toFixed(2)}`,
    `blast radius rank ${key[1]}`,
    `recovery rank ${key[2]}`,
    key[3] === 0 ? 'retires risk early (characterization)' : null,
    key[4] ? `unblocks ${-key[4]} later slice(s)` : null,
    `${key[5]} owning team(s) to coordinate`,
  ].filter(Boolean);
}
