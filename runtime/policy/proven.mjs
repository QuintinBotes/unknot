// Proven deletion: a one-file removal that Unknot's own analysis found unused, observed rather
// than inferred. Such a slice keeps its risk factors only if one of them is high or critical;
// the medium factors a removal cannot trigger are skipped (see classifyRisk), and one approval
// from `approvals.proven_deletion` (default: any registered approver) is enough. The approval is
// still a person's signature at a terminal; nothing here touches that.
//
// Eligibility rests only on data Unknot stored itself: the findings table, the derived public
// surface, the slice's planned scope and changes, and the ledger. Nothing an agent wrote
// (the objective, a rationale, a declared risk or surface) can make a slice qualify; those
// can only keep it out. After the patch, `settleProven` checks the real diff and takes the
// status away, with its reason in the ledger, when the diff is not a deletion in that one file.

import { UnknotError } from '../core/errors.mjs';
import { nowISO } from '../core/clock.mjs';
import { readDerived } from '../graph/derived.mjs';
import { Graph } from '../graph/graph.mjs';
import { sliceDigest, invalidateApprovals } from './approvals.mjs';
import { loadConfig } from './config.mjs';
import { riskRank } from './defaults.mjs';
import { classifyRisk, requiredApprovals } from './risk.mjs';
import { appendEvent } from '../state/ledger.mjs';

export const PROVEN_KINDS = Object.freeze(['code.unused-injected-member', 'code.dead-code', 'code.unreachable-code']);
const REMOVAL_PATTERN = 'code.remove-dead-code';
const FINDING_ID = /^F-\d{4,}$/;
const GLOB_CHARS = /[*?[\]{}!()]/;
const LIVE_STATUSES = new Set(['open', 'accepted']);

/** A repository-relative path with no glob syntax, no traversal and no trailing slash. */
export const isLiteralFile = (p) => typeof p === 'string' && p.length > 0 && !GLOB_CHARS.test(p) && !p.startsWith('/') && !p.endsWith('/') && !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');

function lostReason(ctx, sliceId) {
  if (!sliceId) return null;
  const row = ctx.store.get("SELECT payload FROM events WHERE type = 'proven.lost' AND slice_id = ? ORDER BY seq DESC LIMIT 1", sliceId);
  return row ? JSON.parse(row.payload).reason : null;
}

const surfaceCache = new WeakMap(); // store -> {generation, rows}

function publicSurface(ctx, file) {
  try {
    const generation = ctx.store.meta('generation');
    let hit = surfaceCache.get(ctx.store);
    if (!hit || hit.generation !== generation) {
      hit = { generation, rows: new Map(readDerived(ctx, 'public_surface', { graph: Graph.fromStore(ctx.store) }).map((r) => [r.key, r.body])) };
      surfaceCache.set(ctx.store, hit);
    }
    return hit.rows.get(`module:${file}`) ?? null;
  } catch {
    return undefined; // the derived facts could not be read: nothing is proven
  }
}

/**
 * Whether a slice is a proven deletion, and why or why not.
 * @param {object} ctx project context (its store holds the findings and the ledger)
 * @param {object} slice a slice row or a slice body
 * @param {{config?: object}} [opts]
 * @returns {{qualifies: boolean, reasons: string[], problems: string[]}}
 */
export function provenDeletion(ctx, slice, { config } = {}) {
  const body = slice?.body ?? slice ?? {};
  const id = slice?.id ?? body.id ?? null;
  const problems = [];
  const fail = () => ({ qualifies: false, reasons: [], problems });
  if (!ctx?.store) return { qualifies: false, reasons: [], problems: ['no repository data to prove it from'] };

  const lost = lostReason(ctx, id);
  if (lost) problems.push(`lost proven status: ${lost}`);

  // (a) only removes code, and says so through findings Unknot itself produced
  if ((body.kind ?? 'code') !== 'code') problems.push(`slice kind is ${body.kind}, not code`);
  if (body.treatment) problems.push(`treatment ${body.treatment} is a restructuring, not a removal`);
  if (body.irreversible) problems.push('the slice is marked irreversible');

  // (b) exactly one literal file
  const include = body.scope?.include ?? [];
  const file = include.length === 1 ? include[0] : null;
  if (include.length !== 1) problems.push(`scope has ${include.length} entries; a proven deletion has exactly one file`);
  else if (!isLiteralFile(file)) problems.push(`scope ${file} is not one literal file path`);
  const literal = file && isLiteralFile(file) ? file : null;
  const changes = body.changes ?? [];
  const other = changes.filter((c) => c.path !== literal);
  if (literal && other.length) problems.push(`planned changes reach ${[...new Set(other.map((c) => c.path))].slice(0, 3).join(', ')}, not only ${literal}`);
  const adds = changes.filter((c) => !['modify', 'delete', undefined].includes(c.operation));
  if (adds.length) problems.push(`a planned change is a ${[...new Set(adds.map((c) => c.operation))].join('/')}, not a removal`);

  // (c) every source is a live, observed finding of a removal kind
  const sources = body.sources ?? [];
  if (!sources.length) problems.push('the slice has no source finding');
  const kinds = [];
  for (const src of sources) {
    if (!FINDING_ID.test(src)) {
      problems.push(`source ${src} is not a finding`);
      continue;
    }
    const row = ctx.store.get('SELECT status, kind, body FROM findings WHERE id = ?', src);
    if (!row) {
      problems.push(`finding ${src} does not exist`);
      continue;
    }
    if (!LIVE_STATUSES.has(row.status)) {
      problems.push(`finding ${src} is ${row.status}, so the evidence is stale`);
      continue;
    }
    const f = JSON.parse(row.body);
    const kind = f.kind ?? row.kind;
    if (!PROVEN_KINDS.includes(kind)) problems.push(`finding ${src} is ${kind}, not a removal of unused code`);
    if (!['medium', 'high'].includes(f.confidence)) problems.push(`finding ${src} has ${f.confidence ?? 'no'} confidence`);
    const labels = (f.evidence ?? []).map((e) => e.label);
    if (!labels.length || labels.some((l) => l !== 'observed')) problems.push(`finding ${src} rests on ${labels.filter((l) => l !== 'observed').length ? 'inferred' : 'no'} evidence, not observed evidence`);
    const patterns = (f.patterns ?? []).map((p) => p.id ?? p);
    if (!patterns.includes(REMOVAL_PATTERN)) problems.push(`finding ${src} does not propose ${REMOVAL_PATTERN}`);
    const scope = f.scope ?? [];
    if (literal && !(scope.length === 1 && scope[0] === literal)) problems.push(`finding ${src} covers ${scope.join(', ') || 'nothing'}, not only ${literal}`);
    if (kind === 'code.unused-injected-member') {
      if (f.measurements?.['member.public'] !== false) problems.push(`finding ${src} is about a public member, which consumers outside this repository may use`);
    }
    kinds.push(`${src} ${kind} (confidence ${f.confidence}, evidence observed)`);
  }

  // (d) not part of the derived public surface
  if (literal) {
    const surface = publicSurface(ctx, literal);
    if (surface === undefined) problems.push('the derived public surface could not be read');
    else if (surface?.exports?.length) problems.push(`${literal} exports ${surface.exports.slice(0, 3).join(', ')}, which is public surface`);
  }

  // (e) no high or critical factor, and nothing medium that a removal does not account for
  if (!problems.length) {
    let cfg = config;
    try {
      cfg ??= loadConfig(ctx).config;
    } catch {
      problems.push('the configuration could not be read');
    }
    if (cfg) {
      const after = classifyRisk(body, { config: cfg, surfaces: body.surfaces ?? {}, proven: { qualifies: true, reasons: [] } });
      if (riskRank(after.risk) > riskRank('low')) problems.push(`${after.risk} risk factors remain: ${after.reasons.filter((r) => !r.startsWith('proven deletion')).join('; ')}`);
    }
  }
  if (problems.length) return fail();
  return {
    qualifies: true,
    reasons: [
      `only removes code (${REMOVAL_PATTERN})`,
      `one literal file: ${literal}`,
      ...kinds,
      'not in the derived public surface',
      'no high or critical risk factor',
    ],
    problems: [],
  };
}

/** Whether a staged patch is what a proven deletion promised: no added line, only the one file. */
export function provenDiffProblems(stat, file) {
  const problems = [];
  if (stat.added > 0) problems.push(`the patch adds ${stat.added} line(s), so it is not deletion-only`);
  if (stat.paths.length !== 1 || stat.paths[0] !== file) problems.push(`the patch touches ${stat.paths.slice(0, 4).join(', ') || 'nothing'}, not exactly ${file}`);
  return problems;
}

/**
 * After the patch: a slice that qualifies must have a deletion-only diff in its one file. If not,
 * take the status away (the ledger keeps why), reclassify, store the new risk and approvals, and
 * revoke approvals given for the proven plan; the normal approvals are needed again.
 * @returns {{lost: boolean, problems: string[]}}
 */
export function settleProven(ctx, { config, slice, stat, actor = 'runtime:unknot' }) {
  const verdict = provenDeletion(ctx, slice, { config });
  if (!verdict.qualifies) return { lost: false, problems: [] };
  const file = slice.body.scope.include[0];
  const problems = provenDiffProblems(stat, file);
  if (!problems.length) return { lost: false, problems: [] };
  const reason = problems.join('; ');
  ctx.store.tx(() => {
    appendEvent(ctx, { type: 'proven.lost', slice_id: slice.id, campaign_id: slice.campaign_id, actor, payload: { reason, diff: { files: stat.paths, added: stat.added } } });
    reclassifySlice(ctx, { config, slice, reason: `proven deletion lost: ${reason}` });
  });
  return { lost: true, problems };
}

/** Store the slice's current risk and required approvals, and revoke approvals that no longer describe it. */
export function reclassifySlice(ctx, { config, slice, reason }) {
  const row = ctx.store.get('SELECT * FROM slices WHERE id = ?', slice.id);
  if (!row) throw new UnknotError('UK_NOT_FOUND', `no slice ${slice.id}`);
  const body = JSON.parse(row.body);
  const c = classifyRisk(body, { config, surfaces: body.surfaces ?? {}, proven: provenDeletion(ctx, { ...row, body }, { config }) });
  const next = { ...body, risk: c.risk, approvals: requiredApprovals(c, config).roles };
  invalidateApprovals(ctx, slice, reason);
  ctx.store.update('slices', row.id, row.version, { risk: next.risk, body: next, slice_digest: sliceDigest(next), updated_at: nowISO() });
  appendEvent(ctx, { type: 'slice.reclassified', slice_id: slice.id, campaign_id: row.campaign_id, actor: 'runtime:unknot', payload: { from: row.risk, to: next.risk, reason, approvals: next.approvals } });
  return next;
}
