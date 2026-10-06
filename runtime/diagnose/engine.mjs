// The diagnostic engine (spec §11, §12). Detectors propose drafts; the engine owns
// everything that must be consistent across them: fingerprints, the §12 priority, the
// mandatory `retain` alternative, pattern fit, required approvers, schema validation,
// stable ids across runs, and suppression by human decisions.

import { appendFileSync } from 'node:fs';
import { canonicalJSON, digest } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { validateArtifact } from '../core/schema.mjs';
import { pathInScope, scopePredicate } from '../core/scope.mjs';
import { readDerived } from '../graph/derived.mjs';
import { Graph } from '../graph/graph.mjs';
import { evaluateAll } from '../patterns/engine.mjs';
import { classifyRisk, requiredApprovals } from '../policy/risk.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { DETECTORS } from './detectors/index.mjs';
import { globalSignals, scopeSignals } from './signals.mjs';

export const FINDING_SCHEMA_VERSION = '1.0';

const clamp = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Spec §12: benefit × evidence × reversibility ÷ (blast radius × cost × uncertainty). */
export function priority(f = {}) {
  const factors = {
    benefit: clamp(f.benefit, 1, 5, 2),
    evidence: clamp(f.evidence, 0, 1, 0.5),
    reversibility: clamp(f.reversibility, 0, 1, 0.5),
    blast: clamp(f.blast, 1, 5, 2),
    cost: clamp(f.cost, 1, 5, 2),
    uncertainty: clamp(f.uncertainty, 1, 5, 2),
  };
  const score = (factors.benefit * factors.evidence * factors.reversibility) / (factors.blast * factors.cost * factors.uncertainty);
  return { score: +score.toFixed(4), factors };
}

const OBJECTIVE_TERMS = [
  [/deploy|release|coupl|lockstep|independen/i, ['service', 'delivery', 'decomposition', 'module']],
  [/database|schema|query|table|index|migration|data/i, ['database']],
  [/infra|cloud|terraform|kubernetes|k8s|cost|network|iam/i, ['infrastructure']],
  [/secur|auth|secret|privilege|vulnerab/i, ['security']],
  [/complex|readab|simplif|duplicat|dead|clean/i, ['local', 'module']],
  [/front|ui|route|micro-?front/i, ['frontend', 'decomposition']],
  [/monolith|decompos|split|extract|boundar/i, ['decomposition', 'module', 'service']],
];

export function objectiveCategories(objective) {
  if (!objective) return null;
  const cats = new Set();
  for (const [re, list] of OBJECTIVE_TERMS) if (re.test(objective)) list.forEach((c) => cats.add(c));
  return cats.size ? cats : null;
}

const KIND_TO_SLICE = { database: 'database', infrastructure: 'infrastructure', decomposition: 'decomposition' };

function finalize(draft, detector, signals, config) {
  const scope = [...new Set(draft.scope ?? [])].sort();
  const key = draft.key ?? scope.join(',');
  const fingerprint = digest({ kind: draft.kind, key });
  const pr = priority(draft.factors);
  const alternatives = [...(draft.alternatives ?? [])];
  if (!alternatives.some((a) => a.id === 'retain')) {
    alternatives.unshift({ id: 'retain', summary: 'Keep the current design and document why; revisit if the measured cost grows.' });
  }
  const measured = { ...signals, ...(draft.measurements ?? {}) };
  // Risk comes from what the change would touch: paths, plus measured surfaces (a plan
  // that deletes or replaces, widened privilege, public exposure) the paths cannot show.
  const m = draft.measurements ?? {};
  const surfaces = {
    ...(draft.surfaces ?? {}),
    destructive_infra: Boolean(draft.surfaces?.destructive_infra || (m['plan.deletes'] ?? 0) > 0 || (m['plan.replaces'] ?? 0) > 0),
    data_movement: Boolean(draft.surfaces?.data_movement),
  };
  const risk = classifyRisk(
    { kind: KIND_TO_SLICE[detector.category] ?? 'code', changes: scope.map((path) => ({ path, description: `${draft.kind} ${draft.title}` })), objective: draft.title, treatment: draft.treatment },
    { config, surfaces },
  );
  const approvals = requiredApprovals(risk, config);
  return {
    schema_version: FINDING_SCHEMA_VERSION,
    kind: draft.kind,
    category: detector.category,
    title: draft.title,
    scope,
    fingerprint,
    key,
    evidence: (draft.evidence ?? []).map((e) => ({ ref: e.ref, label: e.label ?? 'observed', summary: e.summary ?? '', source_ref: e.source_ref ?? null })),
    measurements: draft.measurements ?? {},
    thresholds: draft.thresholds ?? {},
    why_accidental: draft.why_accidental ?? '',
    essential_considerations: draft.essential_considerations ?? [],
    smallest_simplification: draft.smallest_simplification ?? '',
    invariants: draft.invariants ?? [],
    risks: draft.risks ?? [],
    verification: draft.verification ?? [],
    recovery: draft.recovery ?? { type: 'revert' },
    quality_impacts: draft.quality_impacts ?? {},
    blast_radius: draft.blast_radius ?? 'bounded',
    uncertainties: draft.uncertainties ?? [],
    alternatives,
    patterns: evaluateAll(draft.patterns ?? [], measured),
    priority: pr,
    approvers: approvals.roles,
    risk: risk.risk,
    detector: { id: detector.id, version: detector.version },
    status: 'open',
  };
}

const FUNCTION_KINDS = ['code.long-function', 'code.complex-function', 'code.deep-nesting'];

/**
 * One function can trip the long-function, complex-function and deep-nesting detectors; that
 * is one thing to fix, so those findings (same single-symbol `key`) collapse into one. The
 * highest-priority kind is the primary and keeps its own kind, key and fingerprint, so a
 * decision recorded against it still applies and calibration still counts it under its
 * detector. Measurements and evidence of the others are folded in, their kinds listed in
 * `related_kinds`, and the title names every aspect. Mutates `findings` in place.
 */
export function mergeFunctionFindings(findings) {
  const groups = new Map();
  for (const f of findings) {
    if (!FUNCTION_KINDS.includes(f.kind) || !f.key) continue;
    if (!groups.has(f.key)) groups.set(f.key, []);
    groups.get(f.key).push(f);
  }
  const drop = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.priority.score - a.priority.score || FUNCTION_KINDS.indexOf(a.kind) - FUNCTION_KINDS.indexOf(b.kind));
    const [primary, ...rest] = group;
    const m = { ...primary.measurements };
    const seen = new Set(primary.evidence.map((e) => `${e.ref}|${e.summary}`));
    for (const o of rest) {
      for (const [k, v] of Object.entries(o.measurements)) if (!(k in m)) m[k] = v;
      for (const [k, v] of Object.entries(o.thresholds)) if (!(k in primary.thresholds)) primary.thresholds[k] = v;
      for (const e of o.evidence) {
        const id = `${e.ref}|${e.summary}`;
        if (!seen.has(id)) { seen.add(id); primary.evidence.push(e); }
      }
      for (const p of o.patterns ?? []) if (!primary.patterns.some((x) => x.id === p.id)) primary.patterns.push(p);
      drop.add(o);
    }
    primary.measurements = m;
    primary.related_kinds = rest.map((o) => o.kind).sort();
    const name = primary.key.replace(/^[a-z]+:/, '').split('#').pop();
    const has = (k) => group.some((g) => g.kind === k);
    const aspects = [];
    if (has('code.long-function') && m['function.lines'] != null) aspects.push(`${m['function.lines']} lines long`);
    if (has('code.complex-function') && m['function.cyclomatic'] != null) aspects.push(`cyclomatic ${m['function.cyclomatic']}`);
    if (has('code.deep-nesting') && m['function.max_nesting'] != null) aspects.push(`nested ${m['function.max_nesting']} deep`);
    if (aspects.length > 1) primary.title = `${name} is ${aspects.slice(0, -1).join(', ')} and ${aspects.at(-1)}`;
  }
  for (let i = findings.length - 1; i >= 0; i--) if (drop.has(findings[i])) findings.splice(i, 1);
}

async function loadDetectors(config, only) {
  const out = [];
  const errors = [];
  for (const entry of DETECTORS) {
    if (only && !only.some((o) => entry.id.startsWith(o))) continue;
    if (config.detectors?.[entry.id]?.enabled === false) continue;
    try {
      const mod = await import(new URL(entry.module, new URL('./detectors/', import.meta.url)));
      for (const d of Array.isArray(mod.default) ? mod.default : [mod.default]) out.push(d);
    } catch (err) {
      errors.push({ detector: entry.id, error: err.code === 'ERR_MODULE_NOT_FOUND' ? 'not installed' : err.message });
    }
  }
  return { detectors: out, errors };
}

function suppressionFor(ctx, fingerprint, at) {
  const d = ctx.store.get('SELECT decision, suppress_until FROM decisions WHERE fingerprint = ? ORDER BY at DESC LIMIT 1', fingerprint);
  if (!d) return null;
  if (d.decision === 'accept') return 'accepted';
  if (d.decision === 'reject' && (!d.suppress_until || d.suppress_until > at)) return 'suppressed';
  return null;
}

/**
 * Run detectors over the current graph and persist findings.
 * @returns {{findings: object[], stats: object, errors: object[]}}
 */
async function diagnoseInner(ctx, { config, run = null, scope = [], objective = null, only = null, graph = null }) {
  const t0 = Date.now();
  const g = graph ?? Graph.fromStore(ctx.store);
  if (g.size.nodes === 0) throw new UnknotError('UK_BASELINE_INVALID', 'the graph is empty; run unknot map first');
  readDerived(ctx, 'scc', { graph: g }); // the stored facts detectors read through derivedFor
  const { detectors, errors } = await loadDetectors(config, only);
  const global = globalSignals(g, config);
  const at = nowISO();
  const commit = ctx.store.meta('mapped_commit') || null;
  const drafts = [];
  for (const d of detectors) {
    try {
      const out = d.detect({ graph: g, options: config.detectors?.[d.id] ?? {}, config, scope }) ?? [];
      for (const draft of out) drafts.push({ draft, detector: d });
    } catch (err) {
      errors.push({ detector: d.id, error: String(err?.message ?? err) });
    }
  }
  const scoped = scopePredicate(g, scope);
  const inScope = (f) => scoped.scope.all || f.scope.some((p) => pathInScope(p, scoped));
  const findings = [];
  for (const { draft, detector } of drafts) {
    const subject = draft.evidence?.map((e) => e.ref).filter((r) => g.node(r)) ?? [];
    const f = finalize(draft, detector, { ...global, ...scopeSignals(g, subject) }, config);
    if (!inScope(f)) continue;
    const v = validateArtifact('finding', { ...f, id: 'F-0000' });
    if (!v.valid) {
      errors.push({ detector: detector.id, error: `invalid finding ${f.kind}: ${v.errors.slice(0, 2).map((e) => `${e.path} ${e.message}`).join('; ')}` });
      continue;
    }
    findings.push(f);
  }
  mergeFunctionFindings(findings);
  // De-duplicate by fingerprint (two detectors may see the same thing): keep the stronger.
  const byFp = new Map();
  for (const f of findings) if (!byFp.has(f.fingerprint) || byFp.get(f.fingerprint).priority.score < f.priority.score) byFp.set(f.fingerprint, f);

  const persisted = ctx.store.tx(() => {
    const seen = new Set();
    const out = [];
    for (const f of byFp.values()) {
      seen.add(f.fingerprint);
      const existing = ctx.store.get('SELECT id, status, version, first_seen_commit FROM findings WHERE fingerprint = ?', f.fingerprint);
      const decided = suppressionFor(ctx, f.fingerprint, at);
      const status = decided ?? 'open';
      const id = existing?.id ?? ctx.store.nextId('F', 4);
      const body = { ...f, id, status, first_seen_commit: existing?.first_seen_commit ?? commit, last_seen_commit: commit };
      if (existing) {
        ctx.store.update('findings', id, existing.version, { status, priority: f.priority.score, body, last_seen_commit: commit, last_run_id: run?.id ?? null, updated_at: at, kind: f.kind, category: f.category });
      } else {
        ctx.store.insert('findings', { id, fingerprint: f.fingerprint, schema_version: FINDING_SCHEMA_VERSION, kind: f.kind, category: f.category, status, priority: f.priority.score, body, first_seen_commit: commit, last_seen_commit: commit, last_run_id: run?.id ?? null, created_at: at, updated_at: at });
      }
      out.push(body);
    }
    // Findings that were open in this scope and are no longer detected are resolved.
    if (!only) {
      for (const row of ctx.store.all("SELECT id, version, body FROM findings WHERE status = 'open'")) {
        const body = JSON.parse(row.body);
        if (seen.has(body.fingerprint) || !inScope(body)) continue;
        ctx.store.update('findings', row.id, row.version, { status: 'resolved', body: { ...body, status: 'resolved' }, updated_at: at });
      }
    }
    return out;
  });
  const cats = objectiveCategories(objective);
  // Human decisions recalibrate ranking per detector (the learning loop); the §12
  // priority itself is unchanged and stays comparable across runs.
  const { calibrate, detectorFeedback } = await import('../learn/calibration.mjs');
  const feedback = detectorFeedback(ctx);
  const open = calibrate(persisted.filter((f) => f.status === 'open'), feedback);
  const rank = (f) => f.priority.score * (cats && cats.has(f.category) ? 1.5 : 1) * (f.calibration?.multiplier ?? 1);
  const ranked = open.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  const stats = {
    detectors: detectors.length,
    drafts: drafts.length,
    findings: persisted.length,
    open: ranked.length,
    suppressed: persisted.filter((f) => f.status === 'suppressed').length,
    accepted: persisted.filter((f) => f.status === 'accepted').length,
    by_category: Object.fromEntries([...new Set(ranked.map((f) => f.category))].map((c) => [c, ranked.filter((f) => f.category === c).length])),
    duration_ms: Date.now() - t0,
    objective,
  };
  appendEvent(ctx, { type: 'finding.upserted', run_id: run?.id, actor: 'runtime:diagnose', payload: { ...stats, errors: errors.length } });
  return { findings: ranked, stats, errors };
}

export function getFinding(ctx, id) {
  const row = ctx.store.get('SELECT * FROM findings WHERE id = ? OR fingerprint = ?', id, id);
  if (!row) throw new UnknotError('UK_NOT_FOUND', `no finding ${id}`);
  return JSON.parse(row.body);
}

/**
 * Record a human decision (spec §2.1: "record human decisions and suppress rejected
 * findings for a configured period"). Also appended to .unknot/decisions.jsonl so the
 * team shares decisions through version control.
 */
export function recordDecision(ctx, { finding, decision, rationale, actor, days }) {
  if (!['accept', 'reject'].includes(decision)) throw new UnknotError('UK_SCHEMA_INVALID', `bad decision ${decision}`);
  if (!rationale || rationale.trim().length < 10) throw new UnknotError('UK_SCHEMA_INVALID', 'a rationale of at least 10 characters is required');
  const at = nowISO();
  const suppress_until = decision === 'reject' ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
  const record = { schema_version: '1.0', id: `D-${ctx.store.nextId('D', 4).slice(2)}`, finding_id: finding.id, fingerprint: finding.fingerprint, decision, rationale: rationale.trim(), actor, suppress_until, at };
  const v = validateArtifact('decision', record);
  if (!v.valid) throw new UnknotError('UK_SCHEMA_INVALID', `decision invalid: ${v.errors[0].path} ${v.errors[0].message}`);
  ctx.store.tx(() => {
    const { schema_version, ...decisionRow } = record;
    ctx.store.insert('decisions', decisionRow);
    const row = ctx.store.get('SELECT version, body FROM findings WHERE id = ?', finding.id);
    const status = decision === 'accept' ? 'accepted' : 'rejected';
    ctx.store.update('findings', finding.id, row.version, { status, body: { ...JSON.parse(row.body), status }, updated_at: at });
    appendEvent(ctx, { type: 'decision.recorded', actor, payload: { decision_id: record.id, finding: finding.id, decision, suppress_until } });
  });
  appendFileSync(ctx.paths.decisions, `${canonicalJSON(record)}\n`);
  return record;
}

/** Instrumented entry point (spec §27); a no-op span when telemetry is disabled. */
export async function diagnose(ctx, opts) {
  const { withSpan } = await import('../telemetry/otel.mjs');
  return withSpan('diagnose', {}, () => diagnoseInner(ctx, opts));
}
