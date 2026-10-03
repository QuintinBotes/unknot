import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../../runtime/context.mjs');
const { loadConfig } = await import('../../../runtime/policy/config.mjs');
const { resetClock, setClock } = await import('../../../runtime/core/clock.mjs');
const { startRun, endRun } = await import('../../../runtime/state/runs.mjs');
const { casGet, casPut } = await import('../../../runtime/state/cas.mjs');
const { readEvents, verifyLedger } = await import('../../../runtime/state/ledger.mjs');
const { collectGarbage, shredProject } = await import('../../../runtime/enterprise/retention.mjs');

const DAY = 86_400_000;

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'uk-ret-'));
  mkdirSync(join(dir, '.unknot'));
  const ctx = openProject(dir, { create: true });
  return { ctx, cfg: loadConfig(ctx) };
}

/** A finished run with a directory on disk and one cached blob attributed to it. */
function finishedRun(ctx, cfg, label, { slice_id = null } = {}) {
  const run = startRun(ctx, { command: 'map', actor: 'model:main', slice_id, config: cfg.config, configDigest: cfg.digest });
  mkdirSync(join(ctx.paths.runs, run.id), { recursive: true });
  writeFileSync(join(ctx.paths.runs, run.id, 'out.txt'), label);
  const digest = casPut(ctx, `blob for ${label}`, { runId: run.id, label });
  endRun(ctx, run.id, { outcome: 'completed' });
  return { run, digest };
}

function sliceRow(ctx, id, state) {
  const at = new Date().toISOString();
  ctx.store.insert('slices', { id, campaign_id: null, schema_version: '1.0', state, risk: 'low', body: { id }, slice_digest: 'sha256:x', created_at: at, updated_at: at });
}

test('gc deletes expired runs and blobs but keeps the evidence of unfinished slices', () => {
  const { ctx, cfg } = project();
  const t0 = Date.now() - 100 * DAY;
  setClock(() => new Date(t0));
  let old, open, closed, evidenceOnly;
  try {
    sliceRow(ctx, 'UK-0001', 'PATCHING');
    sliceRow(ctx, 'UK-0002', 'ACCEPTED');
    old = finishedRun(ctx, cfg, 'old and unrelated');
    open = finishedRun(ctx, cfg, 'belongs to the open slice', { slice_id: 'UK-0001' });
    closed = finishedRun(ctx, cfg, 'belongs to the accepted slice', { slice_id: 'UK-0002' });
    // Evidence on the open slice references a blob that no run of the slice produced.
    evidenceOnly = casPut(ctx, 'referenced only by evidence', { label: 'orphan evidence' });
    const run = finishedRun(ctx, cfg, 'run that produced the evidence');
    ctx.store.insert('evidence', { id: 'EV-1', slice_id: 'UK-0001', run_id: run.run.id, record: { artifact_refs: [evidenceOnly] }, verdict: 'pass', at: new Date(t0).toISOString() });
    old.also = run;
  } finally {
    resetClock();
  }

  const dry = collectGarbage(ctx, cfg.config, { dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.ok(existsSync(join(ctx.paths.runs, old.run.id)), 'dry run deletes nothing');
  assert.ok(dry.runs.deleted.includes(old.run.id));
  assert.equal(readEvents(ctx.store, { type: 'retention.collected' }).length, 0, 'dry run records nothing');

  const r = collectGarbage(ctx, cfg.config);
  assert.deepEqual(r.runs.deleted.sort(), [old.run.id, closed.run.id].sort());
  assert.ok(!existsSync(join(ctx.paths.runs, old.run.id)));
  assert.ok(!existsSync(join(ctx.paths.runs, closed.run.id)));
  assert.ok(existsSync(join(ctx.paths.runs, open.run.id)), 'open slice run directory survives');
  assert.ok(existsSync(join(ctx.paths.runs, old.also.run.id)), 'the run that produced open-slice evidence survives');

  assert.throws(() => casGet(ctx, old.digest), (e) => e.code === 'UK_NOT_FOUND');
  assert.throws(() => casGet(ctx, closed.digest), (e) => e.code === 'UK_NOT_FOUND');
  assert.equal(ctx.store.get('SELECT 1 AS x FROM artifacts WHERE digest = ?', old.digest), null, 'artifact rows go with the blob');
  assert.equal(casGet(ctx, open.digest).toString(), 'blob for belongs to the open slice');
  assert.equal(casGet(ctx, evidenceOnly).toString(), 'referenced only by evidence');

  const events = readEvents(ctx.store, { type: 'retention.collected' });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.runs_deleted, 2);
  assert.equal(verifyLedger(ctx.store, ctx.store.meta('audit_public_key')).ok, true);

  // Closing the slice releases its evidence on the next pass.
  ctx.store.run("UPDATE slices SET state = 'ABANDONED' WHERE id = 'UK-0001'");
  const again = collectGarbage(ctx, cfg.config);
  assert.ok(again.runs.deleted.includes(open.run.id));
  assert.throws(() => casGet(ctx, evidenceOnly), (e) => e.code === 'UK_NOT_FOUND');
});

test('recent data and active runs are never collected', () => {
  const { ctx, cfg } = project();
  const fresh = finishedRun(ctx, cfg, 'fresh');
  const active = startRun(ctx, { command: 'map', actor: 'model:main', config: cfg.config, configDigest: cfg.digest });
  mkdirSync(join(ctx.paths.runs, active.id), { recursive: true });
  setClock(() => new Date(Date.now() + 1000));
  let r;
  try {
    r = collectGarbage(ctx, { retention: { runs: '1ms', cache: '30d' } });
  } finally {
    resetClock();
  }
  assert.deepEqual(r.runs.deleted, [fresh.run.id], 'a 1ms retention reaches the finished run only');
  assert.ok(existsSync(join(ctx.paths.runs, active.id)), 'an unfinished run is never collected');
  assert.equal(casGet(ctx, fresh.digest).length > 0, true, 'blobs follow retention.cache, not retention.runs');
});

test('shred makes cached artifacts unrecoverable and needs the exact project id', () => {
  const { ctx, cfg } = project();
  const { digest } = finishedRun(ctx, cfg, 'secret');
  assert.equal(casGet(ctx, digest).toString(), 'blob for secret');
  assert.throws(() => shredProject(ctx, { confirm: 'p-wrong' }), (e) => e.code === 'UK_POLICY_DENIED');
  assert.equal(casGet(ctx, digest).toString(), 'blob for secret', 'a failed confirmation destroys nothing');

  const pub = ctx.store.meta('audit_public_key');
  shredProject(ctx, { confirm: ctx.projectId });
  assert.throws(() => casGet(ctx, digest), (e) => e.code === 'UK_INTEGRITY');
  assert.equal(readEvents(ctx.store, { type: 'project.shredded' }).length, 1);
  assert.equal(verifyLedger(ctx.store, pub).ok, true, 'the ledger written so far still verifies');
});
