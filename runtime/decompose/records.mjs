// Saved decomposition records (.unknot/decompositions/DEC-*.json): the stable fingerprint
// that lets a rerun overwrite its own record, and the list/show views over them.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnknotError } from '../core/errors.mjs';
import { INVASIVENESS } from './select.mjs';

const ID = /^DEC-\d{4,}$/;
const dirOf = (ctx) => join(ctx.paths.base, 'decompositions');

/** Same target, drivers and candidate members: the same recommendation. */
export function fingerprintOf({ target, drivers, modules }) {
  return createHash('sha256').update(JSON.stringify({ target, drivers: [...drivers].sort(), modules: [...modules].sort() })).digest('hex');
}

/** Every readable record, sorted by id. Unreadable files are skipped. */
export function loadRecords(ctx) {
  const dir = dirOf(ctx);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => /^DEC-\d+\.json$/.test(n)).sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    } catch {
      // a half-written file is not a record
    }
  }
  return out;
}

/** fingerprint -> id of the record already holding it. */
export const fingerprintIndex = (ctx) => new Map(loadRecords(ctx).filter((r) => r.fingerprint).map((r) => [r.fingerprint, r.id]));

export const currentGeneration = (ctx) => Number(ctx.store.meta('generation') ?? 0);

const staleOf = (ctx, r) => (r.graph_generation === undefined ? null : r.graph_generation !== currentGeneration(ctx));

/** One row per saved record; `stale` when the graph was rebuilt since it was written. */
export function listRecords(ctx) {
  return loadRecords(ctx).map((r) => ({
    id: r.id,
    name: r.candidate.name ?? '',
    target: r.target,
    treatment: r.treatment,
    confidence: r.confidence,
    size: r.candidate.modules.length,
    graph_generation: r.graph_generation ?? null,
    stale: staleOf(ctx, r),
  }));
}

export function showRecord(ctx, id) {
  if (!ID.test(String(id))) throw new UnknotError('UK_SCHEMA_INVALID', 'decomposition id must match ^DEC-\\d{4,}$');
  const rec = loadRecords(ctx).find((r) => r.id === id);
  if (!rec) throw new UnknotError('UK_NOT_FOUND', `no decomposition recommendation ${id}`);
  return { ...rec, stale: staleOf(ctx, rec) };
}

/** One line per candidate: the top reason the next more invasive treatment was rejected. */
export function summaryLine(r) {
  const rank = (t) => INVASIVENESS[t] ?? 0;
  const next = (r.rejected_treatments ?? []).filter((x) => rank(x.treatment) > rank(r.treatment)).sort((a, b) => rank(a.treatment) - rank(b.treatment) || a.treatment.localeCompare(b.treatment))[0];
  return {
    id: r.id,
    name: r.candidate.name,
    size: r.candidate.modules.length,
    treatment: r.treatment,
    confidence: r.confidence,
    next_rejected: next ? `${next.treatment}: ${next.reason}` : '',
  };
}
