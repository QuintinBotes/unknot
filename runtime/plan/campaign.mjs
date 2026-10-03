// Campaigns and slices (spec §17). A campaign is an objective with alternatives
// (retain is always one), a selected alternative, and a DAG of slices. Slices come from
// decomposition recommendations, from findings, or from a planner agent's proposal; in
// every case the runtime — not the proposer — assigns ids, classifies risk (raise only),
// derives required approvals, generates proof obligations and checks budgets.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { assertArtifact, validateArtifact } from '../core/schema.mjs';
import { stringifyYAML } from '../core/yaml.mjs';
import { getFinding } from '../diagnose/engine.mjs';
import { topoOrder } from '../graph/algorithms.mjs';
import { sliceDigest } from '../policy/approvals.mjs';
import { riskRank } from '../policy/defaults.mjs';
import { classifyRisk, requiredApprovals } from '../policy/risk.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { transitionSlice } from '../state/machine.mjs';
import { gitHead } from '../state/runs.mjs';
import { generateObligations } from './obligations.mjs';

const RECOVERY_BY_TREATMENT = { T3: 'roll_forward', T6: 'roll_forward', T7: 'revert' };

function persistSliceFile(ctx, body) {
  mkdirSync(ctx.paths.slices, { recursive: true });
  writeFileSync(join(ctx.paths.slices, `${body.id}.yaml`), stringifyYAML(body));
}

function persistCampaignFile(ctx, body) {
  mkdirSync(ctx.paths.campaigns, { recursive: true });
  writeFileSync(join(ctx.paths.campaigns, `${body.id}.yaml`), stringifyYAML(body));
}

/** Turn a draft (from any source) into a validated, stored slice in AWAITING_APPROVAL. */
export function createSlice(ctx, { config, campaignId, draft, actor }) {
  const kind = draft.kind ?? 'code';
  const prefix = kind === 'database' ? 'UK-DB' : kind === 'infrastructure' ? 'UK-INFRA' : 'UK';
  const id = ctx.store.nextId(prefix, 4);
  const budgets = {
    max_changed_files: Math.min(draft.budgets?.max_changed_files ?? config.limits.max_changed_files, config.limits.max_changed_files),
    max_diff_lines: Math.min(draft.budgets?.max_diff_lines ?? config.limits.max_diff_lines, config.limits.max_diff_lines),
  };
  const changes = (draft.changes ?? []).slice(0, 200);
  if (changes.length > budgets.max_changed_files) {
    throw new UnknotError('UK_BUDGET_EXCEEDED', `slice "${draft.objective}" plans ${changes.length} file changes, over max_changed_files ${budgets.max_changed_files}; split it`, { details: { changes: changes.length } });
  }
  const body = {
    schema_version: '1.0',
    id,
    campaign: campaignId,
    version: 1,
    kind,
    objective: draft.objective,
    scope: { include: draft.scope?.include ?? [], exclude: [...new Set([...(draft.scope?.exclude ?? []), '**/*.lock'])] },
    preconditions: draft.preconditions ?? [],
    changes,
    invariants: draft.invariants?.length ? draft.invariants : ['Observable behaviour of the scope is unchanged'],
    proof_obligations: [],
    risk: 'low',
    blast_radius: draft.blast_radius ?? 'bounded',
    recovery: draft.recovery ?? { type: RECOVERY_BY_TREATMENT[draft.treatment] ?? 'revert' },
    irreversible: Boolean(draft.irreversible),
    budgets,
    status: 'PLANNED',
    owners: draft.owners ?? [],
    approvals: [],
    proposed_by: actor,
    sources: draft.sources ?? [],
    patterns: draft.patterns ?? [],
    ...(draft.treatment ? { treatment: draft.treatment } : {}),
    ...(draft.surfaces ? { surfaces: draft.surfaces } : {}),
    ...(draft.infra ? { infra: draft.infra } : {}),
    ...(draft.declared_risk ? { declared_risk: draft.declared_risk } : {}),
    ...(draft.rationale ? { rationale: draft.rationale } : {}),
  };
  if (body.scope.include.length === 0) throw new UnknotError('UK_SCHEMA_INVALID', `slice "${draft.objective}" has no included scope; every slice declares what it may touch`);
  const risk = classifyRisk(body, { config, surfaces: body.surfaces ?? {} });
  body.risk = risk.risk;
  if (body.irreversible && riskRank(body.risk) < riskRank('critical')) body.risk = 'critical';
  const needed = requiredApprovals(risk, config);
  body.approvals = needed.roles;
  const obligations = generateObligations(body, { config, risk });
  return ctx.store.tx(() => {
    const ids = [];
    for (const o of obligations) {
      const poId = ctx.store.nextId('PO', 1);
      ids.push(poId);
      ctx.store.insert('proof_obligations', { id: poId, slice_id: id, kind: o.kind, body: { ...o, id: poId, slice_id: id, status: 'open', evidence_id: null }, requires_human: o.requires_human ? 1 : 0, status: 'open' });
    }
    body.proof_obligations = ids;
    assertArtifact('slice', body);
    const at = nowISO();
    ctx.store.insert('slices', { id, campaign_id: campaignId, schema_version: '1.0', state: 'PLANNED', risk: body.risk, body, slice_digest: sliceDigest(body), created_at: at, updated_at: at });
    appendEvent(ctx, { type: 'slice.created', campaign_id: campaignId, slice_id: id, actor, payload: { risk: body.risk, risk_reasons: risk.reasons, approvals: needed, obligations: ids.length } });
    const row = ctx.store.get('SELECT * FROM slices WHERE id = ?', id);
    transitionSlice(ctx, { slice: row, to: 'AWAITING_APPROVAL', actor: 'runtime:planner', reason: 'planned; human approval of the exact plan is required before patching' });
    persistSliceFile(ctx, { ...body, status: 'AWAITING_APPROVAL' });
    return { ...body, status: 'AWAITING_APPROVAL', needed };
  });
}

/** Drafts from a decomposition recommendation: one slice per step of its sequence. */
function draftsFromDecomposition(ctx, decId) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(ctx.paths.base, 'decompositions', `${decId}.json`), 'utf8'));
  } catch {
    throw new UnknotError('UK_NOT_FOUND', `no decomposition recommendation ${decId}`);
  }
  const include = rec.first_slice.scope.include.length ? rec.first_slice.scope.include : rec.candidate.modules.map((m) => m.slice(7));
  const steps = rec.first_slice.sequence ?? [rec.treatment];
  const drafts = [];
  for (const step of steps) {
    if (step === 'T0') continue;
    const isChar = step === 'characterization';
    drafts.push({
      objective: isChar ? `Add characterization tests pinning current behaviour of ${rec.candidate.name}` : step === rec.treatment ? rec.first_slice.objective : `First safe slice of ${step} for ${rec.candidate.name}`,
      kind: step === 'T6' ? 'database' : isChar ? 'code' : 'decomposition',
      treatment: isChar ? undefined : step,
      scope: { include: isChar ? [...include.map((p) => p.replace(/[^/]+$/, '')).filter(Boolean).map((d) => `${d}**`), '**/test*/**', '**/*.test.*', '**/*_test.*', '**/test_*.*'] : include, exclude: [] },
      invariants: ['Observable behaviour of the candidate is unchanged', 'No consumer outside the candidate needs to change in this slice'],
      sources: [decId],
      patterns: isChar ? ['code.extract-function'] : [],
      rationale: `From ${decId}: ${rec.favoring_signals.map((f) => `${f.signal}=${f.value}`).join(', ') || 'no favouring signals (retain)'}`,
    });
  }
  return { drafts, alternatives: ['retain_and_document', ...rec.rejected_treatments.map((r) => r.treatment), rec.treatment].filter((v, i, a) => a.indexOf(v) === i), selected: rec.treatment, drivers: rec.driver };
}

function draftsFromFindings(ctx, ids) {
  const drafts = ids.map((id) => {
    const f = getFinding(ctx, id);
    return {
      objective: f.smallest_simplification || `Address ${f.id}: ${f.title}`,
      kind: f.category === 'database' ? 'database' : f.category === 'infrastructure' ? 'infrastructure' : 'code',
      scope: { include: f.scope, exclude: [] },
      invariants: f.invariants,
      blast_radius: f.blast_radius,
      recovery: f.recovery,
      sources: [f.id],
      patterns: f.patterns.filter((p) => p.fit === 'fits').map((p) => p.id),
      rationale: f.why_accidental,
    };
  });
  return { drafts, alternatives: ['retain_and_document', 'address_findings'], selected: 'address_findings', drivers: [] };
}

/**
 * Create a campaign.
 * @param {{objective: string, scope?: string[], constraints?: string[], decomposition?: string, findings?: string[], proposal?: object}} req
 */
export function createCampaign(ctx, { config, actor, objective, scope = [], constraints = [], decomposition, findings, proposal }) {
  if (!objective || objective.length < 5) throw new UnknotError('UK_SCHEMA_INVALID', 'a campaign needs an objective');
  let plan;
  if (decomposition) plan = draftsFromDecomposition(ctx, decomposition);
  else if (findings?.length) plan = draftsFromFindings(ctx, findings);
  else if (proposal) {
    if (!Array.isArray(proposal.slices) || !proposal.slices.length) throw new UnknotError('UK_SCHEMA_INVALID', 'proposal.slices must be a non-empty array');
    plan = { drafts: proposal.slices, alternatives: ['retain_and_document', ...(proposal.alternatives ?? [])], selected: proposal.selected ?? null, drivers: proposal.drivers ?? [] };
  } else throw new UnknotError('UK_SCHEMA_INVALID', 'give a source: --from DEC-xxxx, --findings F-xxxx,... or --proposal file.json');
  if (!plan.drafts.length) {
    throw new UnknotError('UK_POLICY_DENIED', 'the selected treatment is retain: there is nothing to change; record the decision with /unknot:accept instead', { details: { selected: plan.selected } });
  }
  if (!plan.alternatives.includes('retain_and_document')) plan.alternatives.unshift('retain_and_document');
  const id = ctx.store.nextId('CMP', 1);
  const at = nowISO();
  const baseline = gitHead(ctx.root) ?? 'working-tree';
  const slices = [];
  // Drafts are sequential unless they say otherwise: each depends on the one before.
  let previous = null;
  for (const draft of plan.drafts) {
    const s = createSlice(ctx, { config, campaignId: id, draft: { ...draft, preconditions: draft.preconditions ?? (previous ? [previous] : []) }, actor });
    slices.push(s);
    previous = s.id;
  }
  topoOrder(slices.map((s) => s.id), slices.flatMap((s) => s.preconditions.filter((p) => slices.some((x) => x.id === p)).map((p) => [p, s.id])));
  const body = {
    schema_version: '1.0',
    id,
    objective,
    scope: scope.length ? scope : [...new Set(slices.flatMap((s) => s.scope.include))].slice(0, 50),
    constraints: constraints.length ? constraints : ['preserve_observable_behavior', ...(config.quality.public_api_compatibility === 'required' ? ['preserve_public_api'] : [])],
    baseline,
    alternatives: plan.alternatives,
    selected: plan.selected,
    rationale: proposal?.rationale ?? `Selected ${plan.selected} from ${decomposition ?? findings?.join(', ') ?? 'proposal'}; alternatives were evaluated by the runtime`,
    risks: [...new Set(slices.filter((s) => s.risk !== 'low').map((s) => `${s.id} is ${s.risk} risk`))],
    slices: slices.map((s) => s.id),
    approvals: [...new Set(slices.flatMap((s) => s.approvals))],
    status: 'active',
    ...(plan.drivers?.length ? { drivers: plan.drivers } : {}),
    created_at: at,
  };
  const v = validateArtifact('campaign', body);
  if (!v.valid) throw new UnknotError('UK_SCHEMA_INVALID', `campaign invalid: ${v.errors[0].path} ${v.errors[0].message}`);
  ctx.store.insert('campaigns', { id, schema_version: '1.0', status: 'active', body, created_at: at, updated_at: at });
  appendEvent(ctx, { type: 'campaign.created', campaign_id: id, actor, payload: { objective, slices: body.slices, selected: plan.selected } });
  persistCampaignFile(ctx, body);
  return { campaign: body, slices };
}
