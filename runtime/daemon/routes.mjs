// The daemon's endpoints (spec §24). Each handler calls the same library function the CLI
// calls, so the API can never do something the CLI's policy would refuse. There is no
// endpoint that executes a shell command, and none that approves a slice.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { abandon, finishApply, loadSlice, replan, startApply } from '../apply/apply.mjs';
import { canonicalJSON } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { resolveInside } from '../core/paths.mjs';
import { getFinding, diagnose, recordDecision } from '../diagnose/engine.mjs';
import { mapRepository } from '../graph/builder.mjs';
import { createCampaign } from '../plan/campaign.mjs';
import { modeRank } from '../policy/defaults.mjs';
import { readEvents, verifyLedger } from '../state/ledger.mjs';
import { COMMANDS, activeRun, endRun, getRun, setRunSlice, startRun } from '../state/runs.mjs';
import { verifySlice } from '../verify/verify.mjs';
import { ApiError, MAX_ARTIFACT_BYTES, checkIfMatch, etagFor } from './http.mjs';

const bad = (message, details) => new ApiError(400, 'UK_SCHEMA_INVALID', message, { details });

// ---- tiny body validators: reject unknown shapes instead of coercing them ----------------

function optString(body, key, { max = 4096 } = {}) {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) throw bad(`"${key}" must be a string of at most ${max} characters`, { field: key });
  return v;
}

function reqString(body, key, opts) {
  const v = optString(body, key, opts);
  if (v === null || v === '') throw bad(`"${key}" is required`, { field: key });
  return v;
}

function optStrings(body, key, { max = 1000 } = {}) {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x.length > 1024)) {
    throw bad(`"${key}" must be an array of strings`, { field: key });
  }
  return v;
}

/** Reject keys the endpoint does not define, so typos do not silently change meaning. */
function only(body, allowed) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`unknown field(s): ${extra.join(', ')}`, { fields: extra });
}

// ---- run helper ----------------------------------------------------------------------------

/**
 * Execute `fn` inside a run: the active one if a client started it (POST /v1/runs),
 * otherwise a short-lived run that is closed afterwards, mirroring the CLI's withRun.
 */
async function inRun(c, command, { scope = [], slice_id = null, campaign_id = null } = {}, fn) {
  const existing = activeRun(c.ctx.store);
  if (existing) {
    if (slice_id && !existing.slice_id) setRunSlice(c.ctx, existing.id, slice_id);
    return fn(activeRun(c.ctx.store));
  }
  const run = startRun(c.ctx, { command, actor: c.principal.actor, scope, slice_id, campaign_id, config: c.cfg.config, configDigest: c.cfg.digest });
  let outcome = 'completed';
  try {
    return await fn(run);
  } catch (err) {
    outcome = err?.code === 'UK_BUDGET_EXCEEDED' ? 'budget_exceeded' : 'failed';
    throw err;
  } finally {
    endRun(c.ctx, run.id, { outcome, actor: c.principal.actor });
  }
}

const sliceRow = (ctx, id) => {
  const row = ctx.store.get('SELECT * FROM slices WHERE id = ?', id);
  if (!row) throw new UnknotError('UK_NOT_FOUND', `no slice ${id}`);
  return row;
};

const sliceView = (row) => ({ id: row.id, campaign_id: row.campaign_id, state: row.state, risk: row.risk, branch: row.branch, baseline_commit: row.baseline_commit, diff_hash: row.diff_hash, version: row.version, body: JSON.parse(row.body) });

const ok = (body, version) => ({ status: 200, body, headers: version === undefined ? {} : { etag: etagFor(version) } });

// ---- handlers ------------------------------------------------------------------------------

const handlers = {
  health: () => ({ status: 200, body: { ok: true } }),

  startRun: (c) => {
    only(c.body, ['command', 'scope', 'slice_id', 'campaign_id']);
    const command = reqString(c.body, 'command', { max: 32 });
    if (!Object.hasOwn(COMMANDS, command)) throw bad(`unknown command ${command}`, { field: 'command' });
    const run = startRun(c.ctx, { command, actor: c.principal.actor, scope: optStrings(c.body, 'scope'), slice_id: optString(c.body, 'slice_id', { max: 64 }), campaign_id: optString(c.body, 'campaign_id', { max: 64 }), config: c.cfg.config, configDigest: c.cfg.digest });
    return { status: 201, body: run, headers: { etag: etagFor(run.version) } };
  },

  endRun: (c) => {
    only(c.body, ['outcome']);
    const run = getRun(c.ctx.store, c.params.id);
    if (!run) throw new UnknotError('UK_NOT_FOUND', `no run ${c.params.id}`);
    checkIfMatch(c.req, run.version);
    const outcome = optString(c.body, 'outcome', { max: 16 }) ?? 'completed';
    if (!['completed', 'failed', 'abandoned'].includes(outcome)) throw bad('outcome must be completed, failed or abandoned', { field: 'outcome' });
    const ended = endRun(c.ctx, run.id, { outcome, actor: c.principal.actor });
    return ok(ended, ended.version);
  },

  getRun: (c) => {
    const run = getRun(c.ctx.store, c.params.id);
    if (!run) throw new UnknotError('UK_NOT_FOUND', `no run ${c.params.id}`);
    return ok(run, run.version);
  },

  map: async (c) => {
    only(c.body, ['scope', 'adapters', 'history']);
    if (c.body.history !== undefined && typeof c.body.history !== 'boolean') throw bad('"history" must be a boolean', { field: 'history' });
    const scope = optStrings(c.body, 'scope');
    const adapters = optStrings(c.body, 'adapters', { max: 64 });
    const summary = await inRun(c, 'map', { scope }, (run) =>
      mapRepository(c.ctx, { config: c.cfg.config, configDigest: c.cfg.digest, run, scope, only: adapters.length ? adapters : null, history: c.body.history ?? true }),
    );
    return { status: 200, body: summary };
  },

  diagnose: async (c) => {
    only(c.body, ['scope', 'objective', 'only']);
    const scope = optStrings(c.body, 'scope');
    const detectors = optStrings(c.body, 'only', { max: 64 });
    const res = await inRun(c, 'diagnose', { scope }, (run) =>
      diagnose(c.ctx, { config: c.cfg.config, run, scope, objective: optString(c.body, 'objective', { max: 512 }), only: detectors.length ? detectors : null }),
    );
    return { status: 200, body: res };
  },

  getFinding: (c) => {
    const finding = getFinding(c.ctx, c.params.id);
    const row = c.ctx.store.get('SELECT version FROM findings WHERE id = ?', finding.id);
    return ok(finding, row?.version);
  },

  campaign: async (c) => {
    only(c.body, ['objective', 'scope', 'constraints', 'decomposition', 'findings', 'proposal']);
    if (modeRank(c.cfg.config.mode) < modeRank('plan')) {
      throw new UnknotError('UK_POLICY_DENIED', `mode ${c.cfg.config.mode} does not permit writing plans; a human sets mode: plan in .unknot/config.yaml`, { details: { policy: 'mode.plan' } });
    }
    const proposal = c.body.proposal ?? null;
    if (proposal !== null && (typeof proposal !== 'object' || Array.isArray(proposal))) throw bad('"proposal" must be an object', { field: 'proposal' });
    const findings = optStrings(c.body, 'findings');
    const res = await inRun(c, 'plan', {}, () =>
      createCampaign(c.ctx, { config: c.cfg.config, actor: c.principal.actor, objective: reqString(c.body, 'objective', { max: 512 }), scope: optStrings(c.body, 'scope'), constraints: optStrings(c.body, 'constraints'), decomposition: optString(c.body, 'decomposition', { max: 64 }), findings: findings.length ? findings : undefined, proposal }),
    );
    return { status: 201, body: res };
  },

  getCampaign: (c) => {
    const row = c.ctx.store.get('SELECT * FROM campaigns WHERE id = ?', c.params.id);
    if (!row) throw new UnknotError('UK_NOT_FOUND', `no campaign ${c.params.id}`);
    const slices = c.ctx.store.all('SELECT id, state, risk, version FROM slices WHERE campaign_id = ? ORDER BY id', row.id);
    return ok({ ...JSON.parse(row.body), status: row.status, version: row.version, slices }, row.version);
  },

  getSlice: (c) => {
    const row = sliceRow(c.ctx, c.params.id);
    return ok(sliceView(row), row.version);
  },

  // Spec §16.3: approval stays with humans who hold keys. This is a hard refusal, not a
  // role check, so no token (not even an admin's) can ever approve through the API.
  approve: () => {
    throw new UnknotError('UK_POLICY_DENIED', 'approvals require the interactive CLI with an approver key (unknot approve <slice> --role <role> --as <approver>); the API never approves', {
      details: { policy: 'approval.human_only' },
    });
  },

  apply: async (c) => {
    only(c.body, ['action', 'reason']);
    const row = sliceRow(c.ctx, c.params.id);
    checkIfMatch(c.req, row.version);
    const action = optString(c.body, 'action', { max: 16 }) ?? 'start';
    if (!['start', 'finish', 'replan', 'abandon'].includes(action)) throw bad('action must be start, finish, replan or abandon', { field: 'action' });
    const sliceId = row.id;
    const actor = c.principal.actor;
    const reason = optString(c.body, 'reason', { max: 1024 });
    const res = await inRun(c, 'apply', { slice_id: sliceId }, async (run) => {
      if (action === 'start') return startApply(c.ctx, { cfg: c.cfg, run, sliceId, actor });
      if (action === 'finish') return finishApply(c.ctx, { cfg: c.cfg, run, sliceId, actor });
      if (action === 'replan') return replan(c.ctx, { run, sliceId, actor, reason });
      return abandon(c.ctx, { run, sliceId, actor, reason });
    });
    const after = loadSlice(c.ctx, sliceId);
    return { status: 200, body: { result: res, slice: { id: after.id, state: after.state, version: after.version } }, headers: { etag: etagFor(after.version) } };
  },

  verify: async (c) => {
    only(c.body, []);
    const row = sliceRow(c.ctx, c.params.id);
    checkIfMatch(c.req, row.version);
    const res = await inRun(c, 'verify', { slice_id: row.id }, (run) => verifySlice(c.ctx, { cfg: c.cfg, run, sliceId: row.id, actor: c.principal.actor }));
    const after = sliceRow(c.ctx, row.id);
    return { status: 200, body: res, headers: { etag: etagFor(after.version) } };
  },

  proofBundle: (c) => {
    const slice = sliceRow(c.ctx, c.params.id);
    const stored = readEvents(c.ctx.store, { sliceId: slice.id, type: 'artifact.stored' }).filter((e) => typeof e.payload?.bundle === 'string');
    if (!stored.length) throw new UnknotError('UK_NOT_FOUND', `slice ${slice.id} has no proof bundle yet; verify it first`);
    const dir = resolveInside(c.ctx.root, stored[stored.length - 1].payload.bundle).abs;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    } catch {
      throw new UnknotError('UK_INTEGRITY', 'proof bundle manifest is missing or unreadable');
    }
    const entries = new Map((manifest.files ?? []).map((f) => [f.path, f]));
    const file = c.query.get('file');
    if (file === null) {
      return ok({ slice_id: slice.id, run_id: manifest.run_id, manifest, files: ['manifest.json', ...entries.keys()] });
    }
    // Only manifest entries are servable: a client-chosen name never reaches the filesystem
    // unless the bundle itself listed it, and the path is re-confined to the bundle anyway.
    if (file === 'manifest.json') return ok({ file, media_type: 'application/json', encoding: 'utf8', content: JSON.stringify(manifest, null, 2) });
    const entry = entries.get(file);
    if (!entry) throw new UnknotError('UK_NOT_FOUND', `${file} is not in the proof bundle manifest`);
    const abs = resolveInside(dir, entry.path, { allowRoot: false }).abs;
    if (statSync(abs).size > MAX_ARTIFACT_BYTES) throw new ApiError(413, 'UK_SCHEMA_INVALID', 'artifact exceeds the API size limit', { details: { limit: MAX_ARTIFACT_BYTES } });
    const buf = readFileSync(abs);
    if (`sha256:${createHash('sha256').update(buf).digest('hex')}` !== entry.digest) {
      throw new UnknotError('UK_INTEGRITY', `${file} does not match its manifest digest; the bundle was modified`);
    }
    const text = /^(text\/|application\/(json|x-yaml|yaml))/.test(entry.media_type ?? '');
    return ok({ file, media_type: entry.media_type, digest: entry.digest, encoding: text ? 'utf8' : 'base64', content: buf.toString(text ? 'utf8' : 'base64') });
  },

  decision: (c) => {
    only(c.body, ['finding', 'decision', 'rationale', 'days']);
    const decision = reqString(c.body, 'decision', { max: 16 });
    if (!['accept', 'reject'].includes(decision)) throw bad('decision must be accept or reject', { field: 'decision' });
    const days = c.body.days === undefined ? c.cfg.config.suppression.default_reject_days : c.body.days;
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw bad('"days" must be an integer between 0 and 3650', { field: 'days' });
    const finding = getFinding(c.ctx, reqString(c.body, 'finding', { max: 128 }));
    const rec = recordDecision(c.ctx, { finding, decision, rationale: optString(c.body, 'rationale', { max: 4096 }) ?? '', actor: c.principal.actor, days });
    return { status: 201, body: rec };
  },

  /** NDJSON: a header line (public key + integrity verdict) so an auditor can verify offline, then events. */
  audit: (c) => {
    const int = (name, dflt, min, max) => {
      const raw = c.query.get(name);
      if (raw === null) return dflt;
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < min || n > max) throw bad(`"${name}" must be an integer between ${min} and ${max}`, { field: name });
      return n;
    };
    const after = int('after', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = int('limit', 1000, 1, 100_000);
    const pub = c.ctx.store.meta('audit_public_key');
    const events = readEvents(c.ctx.store, { afterSeq: after, limit });
    const header = { type: 'unknot.audit.header', public_key: pub, project_id: c.ctx.projectId, ledger: verifyLedger(c.ctx.store, pub), after, count: events.length, exported_at: new Date().toISOString() };
    return { status: 200, ndjson: [header, ...events].map((l) => canonicalJSON(l)) };
  },
};

const ID = '([A-Za-z0-9._-]{1,64})';

/**
 * Route table. `role` is the minimum role; `mutating` routes require an Idempotency-Key and
 * a JSON body. `approve` is listed so it answers 403 rather than 404.
 */
export const ROUTES = [
  { method: 'GET', re: /^\/v1\/healthz$/, handler: handlers.health, public: true },
  { method: 'POST', re: /^\/v1\/runs$/, role: 'planner', mutating: true, handler: handlers.startRun },
  { method: 'GET', re: new RegExp(`^/v1/runs/${ID}$`), role: 'viewer', handler: handlers.getRun },
  { method: 'POST', re: new RegExp(`^/v1/runs/${ID}/end$`), role: 'planner', mutating: true, handler: handlers.endRun },
  { method: 'POST', re: /^\/v1\/maps$/, role: 'planner', mutating: true, handler: handlers.map },
  { method: 'POST', re: /^\/v1\/diagnoses$/, role: 'planner', mutating: true, handler: handlers.diagnose },
  { method: 'GET', re: new RegExp(`^/v1/findings/${ID}$`), role: 'viewer', handler: handlers.getFinding },
  { method: 'POST', re: /^\/v1\/campaigns$/, role: 'planner', mutating: true, handler: handlers.campaign },
  { method: 'GET', re: new RegExp(`^/v1/campaigns/${ID}$`), role: 'viewer', handler: handlers.getCampaign },
  { method: 'GET', re: new RegExp(`^/v1/slices/${ID}$`), role: 'viewer', handler: handlers.getSlice },
  { method: 'POST', re: new RegExp(`^/v1/slices/${ID}/approve$`), role: 'viewer', handler: handlers.approve, denyAlways: true },
  { method: 'POST', re: new RegExp(`^/v1/slices/${ID}/apply$`), role: 'operator', mutating: true, handler: handlers.apply },
  { method: 'POST', re: new RegExp(`^/v1/slices/${ID}/verify$`), role: 'operator', mutating: true, handler: handlers.verify },
  { method: 'GET', re: new RegExp(`^/v1/slices/${ID}/proof-bundle$`), role: 'viewer', handler: handlers.proofBundle },
  { method: 'POST', re: /^\/v1\/decisions$/, role: 'planner', mutating: true, handler: handlers.decision },
  { method: 'GET', re: /^\/v1\/audit\/events$/, role: 'admin', handler: handlers.audit },
];

/** @returns {{route: object, params: {id?: string}} | {methodNotAllowed: true} | null} */
export function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const route of ROUTES) {
    const m = route.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (route.method === method) return { route, params: { id: m[1] } };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}
