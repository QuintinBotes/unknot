// Weak evidence yields a plan, not an edit (#146): the same detector's finding planned in a
// lexically read C# repository and in a TypeScript one with a syntax adapter. Both slices carry
// their gaps; only the lexical one is refused at apply, until a person opts the campaign in
// through the accepted config. A test-only slice is not stopped.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../helpers/kernel.mjs';
import { mapRepository } from '../../runtime/graph/builder.mjs';
import { diagnose } from '../../runtime/diagnose/engine.mjs';
import { createCampaign } from '../../runtime/plan/campaign.mjs';
import { currentBinding, startApply } from '../../runtime/apply/apply.mjs';
import { stringifyYAML } from '../../runtime/core/yaml.mjs';

after(() => K.cleanup());

const pub = K.keys.generateApproverKey('alice', 'correct horse battery');
const key = K.keys.loadApproverKey('alice', 'correct horse battery');
const BASE = { version: 1, mode: 'assist', repository: { publishes_api: false }, approvers: { alice: { roles: ['code-owner'], public_key: pub } } };

const CSHARP = {
  'Shop/Mailer.cs': 'namespace Shop\n{\n    public class Mailer\n    {\n        public void Send() { }\n    }\n}\n',
  'Shop/Legacy.cs': 'namespace Shop\n{\n    public class Legacy\n    {\n        [Inject] private Mailer _mailer;\n        public void Run() { }\n    }\n}\n',
  'Shop.Tests/LegacyTests.cs': 'namespace Shop.Tests\n{\n    public class LegacyTests\n    {\n        public void Runs() { }\n    }\n}\n',
};
const TYPESCRIPT = {
  'src/mailer.ts': 'export class Mailer {\n  send(): void {}\n}\n',
  'src/legacy.ts': "import { Mailer } from './mailer';\n\nexport class Legacy {\n  constructor(private readonly mailer: Mailer) {}\n  run(): void {}\n}\n",
};

function accept(p, extra = {}) {
  const text = stringifyYAML({ ...BASE, ...extra });
  writeFileSync(join(p.ctx.paths.base, 'config.yaml'), text);
  K.git(p.dir, 'add', '-A');
  K.git(p.dir, 'commit', '-qm', 'unknot config');
  K.configMod.recordAcceptedConfig(p.ctx, text, 'human:test');
  return K.configMod.loadConfig(p.ctx);
}

async function planned(files) {
  const p = K.makeProject({ files });
  let cfg = accept(p);
  await mapRepository(p.ctx, { config: cfg.config, configDigest: cfg.digest, history: false });
  const { run } = K.startTestRun(p, { command: 'diagnose' });
  await diagnose(p.ctx, { config: cfg.config, run, scope: [] });
  K.runs.endRun(p.ctx, run.id);
  const f = p.ctx.store.get("SELECT id FROM findings WHERE kind = 'code.unused-injected-member'").id;
  const { campaign, slices } = createCampaign(p.ctx, { config: cfg.config, actor: 'model:main', objective: 'Remove the unused member', findings: [f] });
  return { p, cfg, campaign, slice: slices[0], finding: f };
}

async function apply(p, cfg, id, role = 'any-approver') {
  const slice = K.loadSlice(p.ctx, id);
  K.approvals.recordApproval(p.ctx, { config: cfg.config, slice, binding: currentBinding(p.ctx, slice, 'plan', { cfg, commit: K.git(p.dir, 'rev-parse', 'HEAD') }), role, approver: 'alice', privateKey: key });
  const run = K.runs.startRun(p.ctx, { command: 'apply', actor: 'model:main', slice_id: id, config: cfg.config, configDigest: cfg.digest, supersede: true });
  try {
    return await startApply(p.ctx, { cfg, run, sliceId: id, actor: 'model:main' });
  } finally {
    K.runs.endRun(p.ctx, run.id);
  }
}

test('a slice carries the gaps of its finding and of the map in its scope', async () => {
  const { slice } = await planned(CSHARP);
  assert.ok(Array.isArray(slice.gaps));
  assert.ok(slice.gaps.some((g) => /^\d+ of \d+ modules in scope were read lexically \(csharp\)/.test(g)), slice.gaps.join(' | '));
  const ts = await planned(TYPESCRIPT);
  assert.ok(Array.isArray(ts.slice.gaps));
  assert.ok(!ts.slice.gaps.some((g) => /lexically/.test(g)), ts.slice.gaps.join(' | '));
  // A finding's uncertainties and non-observed evidence are copied, prefixed with its id.
  const p = K.makeProject();
  const cfg = accept(p);
  const at = new Date().toISOString();
  const body = { id: 'F-0900', status: 'open', kind: 'code.god-class', category: 'code', title: 't', scope: ['src/a.js'], confidence: 'low', uncertainties: ['callers outside the repository are not seen'], evidence: [{ ref: 'edge:a', label: 'inferred', summary: 's', source_ref: null }, { ref: 'edge:b', label: 'inferred', summary: 's', source_ref: null }, { ref: 'module:src/a.js', label: 'observed', summary: 's', source_ref: null }], patterns: [], invariants: ['x'], blast_radius: 'bounded', recovery: { type: 'revert' } };
  p.ctx.store.insert('findings', { id: 'F-0900', fingerprint: 'fp-900', schema_version: '1', kind: body.kind, category: 'code', status: 'open', priority: 1, body, first_seen_commit: 'c', last_seen_commit: 'c', last_run_id: null, created_at: at, updated_at: at });
  const { slices } = createCampaign(p.ctx, { config: cfg.config, actor: 'model:main', objective: 'Split the class', findings: ['F-0900'] });
  assert.ok(slices[0].gaps.includes('F-0900: callers outside the repository are not seen'));
  assert.ok(slices[0].gaps.some((g) => /^F-0900: 2 of 3 evidence entries are inferred, not observed \(edge:a, edge:b\)$/.test(g)), slices[0].gaps.join(' | '));
  assert.deepEqual(slices[0].evidence_strength, { confidence: 'low', inferred: 2, evidence: 3 });
});

test('low confidence or mostly inferred evidence raises risk one level, naming the evidence', () => {
  const c = (strength, over = {}) => K.risk.classifyRisk({ scope: { include: ['src/x.js'] }, changes: [], evidence_strength: strength, ...over }, { config: K.cfg() });
  assert.equal(c({ inferred: 0, evidence: 2, confidence: 'high' }).risk, 'low');
  assert.equal(c({ inferred: 1, evidence: 2, confidence: 'medium' }).risk, 'low', 'half inferred is not mostly');
  const low = c({ inferred: 0, evidence: 1, confidence: 'low' });
  assert.equal(low.risk, 'medium');
  assert.match(low.reasons.join(' | '), /weak evidence: source finding confidence is low/);
  const inferred = c({ inferred: 2, evidence: 3, confidence: 'medium' });
  assert.equal(inferred.risk, 'medium');
  assert.match(inferred.reasons.join(' | '), /weak evidence: 2 of 3 supporting evidence entries are inferred, not observed/);
  assert.equal(c({ inferred: 0, evidence: 1, confidence: 'low' }, { treatment: 'T1' }).risk, 'high', 'raised from medium, not set to medium');
  assert.equal(c(undefined).risk, 'low', 'a slice planned before #146 has no strength and is not raised');
});

test('apply refuses a lexically read slice, naming the gap and both ways forward; a person can opt the campaign in', async () => {
  const { p, cfg, campaign, slice } = await planned(CSHARP);
  // It qualifies as a proven deletion (and a deletion lane would cover it); weak evidence stops it all the same.
  assert.deepEqual(slice.approvals, ['any-approver']);
  await assert.rejects(apply(p, cfg, slice.id), (e) => {
    assert.equal(e.code, 'UK_INSUFFICIENT_EVIDENCE');
    assert.match(e.message, /read lexically \(csharp\)/);
    assert.match(e.message, /SCIP index for csharp/);
    assert.match(e.message, new RegExp(`evidence\\.allow_weak: \\[${campaign.id}\\].*unknot config accept`));
    assert.equal(e.details.ways_forward.length, 2);
    return true;
  });
  assert.equal(K.loadSlice(p.ctx, slice.id).state, 'AWAITING_APPROVAL');
  // Another campaign's opt-in does not cover it; this campaign's does (the approval binds the policy, so it is signed again).
  let opted = accept(p, { evidence: { allow_weak: ['CMP-999'] } });
  await assert.rejects(apply(p, opted, slice.id), (e) => e.code === 'UK_INSUFFICIENT_EVIDENCE');
  opted = accept(p, { evidence: { allow_weak: [campaign.id] } });
  const res = await apply(p, opted, slice.id);
  assert.equal(res.slice.state, 'PATCHING');
});

test('the same slice in a repository with a syntax adapter proceeds as before', async () => {
  const { p, cfg, slice } = await planned(TYPESCRIPT);
  const res = await apply(p, cfg, slice.id);
  assert.equal(res.slice.state, 'PATCHING');
});

test('a test-only slice is applied on weak evidence', async () => {
  const { p, cfg } = await planned(CSHARP);
  const { slices } = createCampaign(p.ctx, { config: cfg.config, actor: 'model:main', objective: 'Add characterization tests', proposal: { slices: [{ objective: 'Pin Legacy behaviour', kind: 'code', scope: { include: ['Shop.Tests/**', '**/*Tests.cs'] } }] } });
  const res = await apply(p, cfg, slices[0].id, 'code-owner');
  assert.equal(res.slice.state, 'PATCHING');
});

test('a scope dressed up as test paths but reaching production code is still refused', async () => {
  const { p, cfg } = await planned(CSHARP);
  const { slices } = createCampaign(p.ctx, { config: cfg.config, actor: 'model:main', objective: 'Remove dead code', proposal: { slices: [{ objective: 'Trim Legacy', kind: 'code', scope: { include: ['{Shop/,Shop.Tests/}**'] } }] } });
  await assert.rejects(apply(p, cfg, slices[0].id, 'code-owner'), (e) => e.code === 'UK_INSUFFICIENT_EVIDENCE');
});

test('an organization can forbid allow_weak, never grant it', () => {
  const repo = K.cfg({ evidence: { allow_weak: ['CMP-1'], traces: ['t.json'] } });
  const forbid = K.merge.applyOrgPolicy(repo, { evidence: { allow_weak: false } }).config;
  assert.equal(forbid.evidence.allow_weak, false);
  assert.deepEqual(forbid.evidence.traces, ['t.json'], 'the repository evidence files stay');
  assert.deepEqual(K.merge.applyOrgPolicy(K.cfg(), { evidence: { allow_weak: true } }).config.evidence.allow_weak, undefined);
});
