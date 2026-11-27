// Which kinds of change a repository accepts (#149). `apply.allowed_kinds` (tighten-only, see
// merge.mjs) lists them; without it every kind is accepted as before. A slice is judged twice:
// from its plan (at planning and at `apply start`), and from the staged diff and the API check
// (at `apply finish`). What a slice says about itself can add kinds, never remove them.

import { UnknotError } from '../core/errors.mjs';
import { matchAny } from '../core/glob.mjs';
import { isTestCode } from '../graph/census.mjs';
import { PROVEN_KINDS } from './proven.mjs';
import { CONTAINER_PATHS, DB_PATHS, INFRA_PATHS } from './risk.mjs';

export const CHANGE_KINDS = Object.freeze(['tests', 'deletion', 'documentation', 'refactor', 'extraction', 'migration', 'infrastructure', 'public-interface']);

const has = (paths, globs) => paths.some((p) => matchAny(p, globs, { nocase: true }));

// Kinds every one of which must be allowed: what the change reaches, whatever else it is.
function reachKinds(body, paths) {
  const k = [];
  if (body.kind === 'infrastructure' || has(paths, [...INFRA_PATHS, ...CONTAINER_PATHS])) k.push('infrastructure');
  if (body.kind === 'database' || has(paths, DB_PATHS)) k.push('migration');
  if (body.kind === 'decomposition' || body.treatment) k.push('extraction');
  if (body.surfaces?.public_api) k.push('public-interface');
  return k;
}

const removalSources = (ctx, body) => (body.sources ?? []).length > 0 && body.sources.every((s) => PROVEN_KINDS.includes(ctx?.store?.get('SELECT kind FROM findings WHERE id = ?', s)?.kind));

/** The kinds a planned slice is: `reach` must all be allowed, and at least one of `shape`. */
export function plannedKinds(ctx, body) {
  const changes = body.changes ?? [];
  const paths = [...changes.map((c) => c.path), ...(body.scope?.include ?? [])].filter(Boolean);
  // Planned files when there are any, else the scope; the staged diff is judged again at finish.
  const named = changes.length ? changes.map((c) => c.path) : paths.map((p) => p.replace(/\*+/g, 'x'));
  const shape = [];
  if (named.length && named.every((p) => isTestCode(p))) shape.push('tests');
  if ((changes.length && changes.every((c) => c.operation === 'delete')) || ((body.kind ?? 'code') === 'code' && !body.treatment && removalSources(ctx, body))) shape.push('deletion');
  if (body.kind === 'documentation') shape.push('documentation');
  if (!shape.length) shape.push('refactor');
  return { reach: reachKinds(body, paths), shape };
}

/** The kinds a staged patch is, from its diff stat and the API check's verdict. */
export function diffKinds(body, stat, { publicSurfaceRemoved = false } = {}) {
  const reach = reachKinds(body, stat.paths);
  if (publicSurfaceRemoved && !reach.includes('public-interface')) reach.push('public-interface');
  const shape = [];
  if (stat.paths.length && stat.paths.every((p) => isTestCode(p))) shape.push('tests');
  if (stat.added === 0) shape.push('deletion');
  if (!shape.length) shape.push(body.kind === 'documentation' ? 'documentation' : 'refactor');
  return { reach, shape };
}

/** The kinds `allowed_kinds` refuses (empty when the change may be applied, or no list is set). */
export function refusedKinds(config, { reach, shape }) {
  const allowed = config.apply?.allowed_kinds;
  if (!Array.isArray(allowed)) return [];
  const refused = reach.filter((k) => !allowed.includes(k));
  if (!shape.some((k) => allowed.includes(k))) refused.push(...shape);
  return refused;
}

/** One line for plan output: empty when applicable, else why the slice is plan-only. */
export function planOnlyReason(ctx, body, config) {
  const refused = refusedKinds(config, plannedKinds(ctx, body));
  return refused.length ? `plan-only: apply.allowed_kinds [${config.apply.allowed_kinds.join(', ')}] excludes ${refused.join(', ')}` : '';
}

export function assertKindsAllowed(config, kinds, { sliceId, from }) {
  const refused = refusedKinds(config, kinds);
  if (!refused.length) return;
  const allowed = config.apply.allowed_kinds;
  throw new UnknotError('UK_KIND_NOT_ALLOWED', `slice ${sliceId} is a change of kind ${refused.join(', ')} (judged from ${from}); apply.allowed_kinds [${allowed.join(', ')}] does not accept it. ${from === 'its plan' ? 'The slice stays a plan' : 'Shrink the patch to fit'}; otherwise only a person widening apply.allowed_kinds in .unknot/config.yaml and running unknot config accept in a terminal (with no organization policy narrowing it) lets it be applied`, {
    slice_id: sliceId,
    details: { policy: 'apply.allowed_kinds', allowed, refused, kinds: [...new Set([...kinds.reach, ...kinds.shape])], judged_from: from },
  });
}
