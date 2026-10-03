// Retention and secure deletion (spec §16.5). Two mechanisms, deliberately different:
//
//   gc      removes run directories and cache blobs past their retention age. Deleting a
//           file is not secure erasure on SSDs or copy-on-write filesystems; it bounds
//           how much history Unknot keeps, nothing more.
//   shred   deletes the project's key directory. Every cached blob is AES-256-GCM
//           encrypted under that key, so without it they are unrecoverable regardless of
//           what the storage layer retains. This is the secure-deletion guarantee.
//
// Evidence that an unfinished slice still needs is never collected: a half-finished
// slice must stay verifiable and its proof bundle reproducible.

import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now, parseDuration } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { shredProjectKeys } from '../core/keys.mjs';
import { appendEvent } from '../state/ledger.mjs';

const CLOSED = ['ACCEPTED', 'ABANDONED', 'ROLLED_BACK'];
const DIGEST = /sha256:[0-9a-f]{64}/g;

/** Digests and run ids that must survive collection. */
export function protectedSet(store) {
  const open = store.all(`SELECT id FROM slices WHERE state NOT IN (${CLOSED.map(() => '?').join(',')})`, ...CLOSED).map((r) => r.id);
  const runs = new Set(store.all('SELECT id FROM runs WHERE ended_at IS NULL').map((r) => r.id));
  const digests = new Set();
  const scan = (text) => {
    for (const m of String(text ?? '').matchAll(DIGEST)) digests.add(m[0]);
  };
  for (const id of open) {
    for (const r of store.all('SELECT id FROM runs WHERE slice_id = ?', id)) runs.add(r.id);
    for (const r of store.all('SELECT run_id, record FROM evidence WHERE slice_id = ?', id)) {
      runs.add(r.run_id);
      scan(r.record);
    }
    scan(store.get('SELECT body FROM slices WHERE id = ?', id)?.body);
    for (const r of store.all('SELECT body FROM proof_obligations WHERE slice_id = ?', id)) scan(r.body);
    for (const r of store.all('SELECT binding FROM approvals WHERE slice_id = ?', id)) scan(r.binding);
    for (const r of store.all('SELECT payload FROM events WHERE slice_id = ?', id)) scan(r.payload);
  }
  // Digests Unknot itself points at (the stored workspace graph) are state, not cache.
  for (const r of store.all('SELECT value FROM meta')) scan(r.value);
  for (const runId of runs) for (const a of store.all('SELECT digest FROM artifacts WHERE run_id = ?', runId)) digests.add(a.digest);
  return { openSlices: open, runs, digests };
}

function pruneEmpty(dir, stop) {
  for (let d = dir; d !== stop && d.startsWith(stop); d = dirname(d)) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/**
 * Apply `retention.runs` and `retention.cache`.
 * @param {{store: object, paths: object}} ctx
 * @param {{retention: {runs: string, cache: string}}} config
 * @param {{dryRun?: boolean, actor?: string}} [opts]
 */
export function collectGarbage(ctx, config, { dryRun = false, actor = 'runtime:gc' } = {}) {
  const { store, paths } = ctx;
  const at = now();
  const runsCutoff = new Date(at.getTime() - parseDuration(config.retention.runs)).toISOString();
  const cacheCutoff = new Date(at.getTime() - parseDuration(config.retention.cache)).toISOString();
  const keep = protectedSet(store);

  const runs = { deleted: [], kept_for_open_slices: [] };
  for (const r of store.all('SELECT id, ended_at FROM runs WHERE ended_at IS NOT NULL AND ended_at < ? ORDER BY ended_at', runsCutoff)) {
    if (keep.runs.has(r.id)) {
      runs.kept_for_open_slices.push(r.id);
      continue;
    }
    const dir = join(paths.runs, r.id);
    if (!existsSync(dir)) continue;
    runs.deleted.push(r.id);
    if (!dryRun) rmSync(dir, { recursive: true, force: true });
  }

  const blobs = { deleted: 0, bytes: 0, kept_for_open_slices: 0 };
  for (const a of store.all('SELECT digest, size FROM artifacts WHERE created_at < ? ORDER BY created_at', cacheCutoff)) {
    if (keep.digests.has(a.digest)) {
      blobs.kept_for_open_slices++;
      continue;
    }
    blobs.deleted++;
    blobs.bytes += a.size;
    if (dryRun) continue;
    const hex = a.digest.slice('sha256:'.length);
    const file = join(paths.cas, 'sha256', hex.slice(0, 2), hex.slice(2));
    rmSync(file, { force: true });
    pruneEmpty(dirname(file), paths.cas);
    store.run('DELETE FROM artifacts WHERE digest = ?', a.digest);
  }

  const result = { dry_run: dryRun, cutoffs: { runs: runsCutoff, cache: cacheCutoff }, runs, blobs, open_slices: keep.openSlices.length };
  if (!dryRun) {
    appendEvent(ctx, {
      type: 'retention.collected',
      actor,
      payload: { cutoffs: result.cutoffs, runs_deleted: runs.deleted.length, blobs_deleted: blobs.deleted, bytes_freed: blobs.bytes, kept_for_open_slices: runs.kept_for_open_slices.length + blobs.kept_for_open_slices },
    });
  }
  return result;
}

/**
 * Crypto-shred the project: record the intent in the ledger, then delete its key directory.
 * `confirm` must equal the project id; the CLI collects it from a human at a terminal.
 */
export function shredProject(ctx, { confirm, actor = 'runtime:gc' }) {
  if (!ctx.projectId || confirm !== ctx.projectId) {
    throw new UnknotError('UK_POLICY_DENIED', 'shredding requires typing the exact project id', { details: { policy: 'retention.shred_confirmation' } });
  }
  // The event must be written first: appending needs the audit key that is about to go.
  appendEvent(ctx, { type: 'project.shredded', actor, payload: { project_id: ctx.projectId } });
  shredProjectKeys(ctx.projectId);
  return { project_id: ctx.projectId, shredded: true };
}
