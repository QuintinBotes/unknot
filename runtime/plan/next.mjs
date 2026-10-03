// /unknot:next (spec §17.4): the smallest unblocked slice, preferring better evidence,
// lower blast radius, stronger reversibility, earlier risk retirement, reduced future
// migration cost and less cross-team coordination — in that order.

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

export function selectNext(ctx, { campaign = null } = {}) {
  const rows = ctx.store.all(`SELECT * FROM slices ${campaign ? 'WHERE campaign_id = ?' : ''} ORDER BY id`, ...(campaign ? [campaign] : []));
  const byId = new Map(rows.map((r) => [r.id, { ...r, body: JSON.parse(r.body) }]));
  const dependents = new Map();
  for (const s of byId.values()) for (const p of s.body.preconditions) dependents.set(p, (dependents.get(p) ?? 0) + 1);
  const candidates = [];
  const blocked = [];
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
      blocked.push({ id: s.id, waiting_for: open });
      continue;
    }
    candidates.push({
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
    next: pick && { id: pick.id, state: pick.state, objective: pick.objective, risk: pick.risk, why: explain(pick.key) },
    alternatives: candidates.slice(1, 5).map(({ id, objective, risk }) => ({ id, objective, risk })),
    blocked,
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
