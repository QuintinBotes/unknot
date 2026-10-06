// Proven deletion (issue #35): a one-file removal that rests on observed findings Unknot stored
// itself needs one approval from approvals.proven_deletion instead of the full flow. Eligibility
// comes only from stored data; a patch that is not a deletion in that file loses the status; an
// agent still cannot approve; nothing high or critical is ever lowered.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;

const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { createCampaign } = await import('../../runtime/plan/campaign.mjs');
const { generateApproverKey, loadApproverKey } = await import('../../runtime/core/keys.mjs');
const { recordApproval } = await import('../../runtime/policy/approvals.mjs');
const { classifyRisk, requiredApprovals } = await import('../../runtime/policy/risk.mjs');
const { provenDeletion } = await import('../../runtime/policy/proven.mjs');
const { sliceStanding, provenLine } = await import('../../runtime/policy/lanes.mjs');
const { approvalStatus, currentBinding, finishApply, loadSlice, startApply } = await import('../../runtime/apply/apply.mjs');
const { startRun, endRun } = await import('../../runtime/state/runs.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');
const approveCmd = await import('../../runtime/cli/commands/approve.mjs');

const UTIL = `export function total(items) {
  return items.reduce((sum, i) => sum + i.price, 0);
}

export class Orders {
  constructor(unused) {
    this.unused = unused;
  }
}
`;
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

const dir = mkdtempSync(join(tmpdir(), 'uk-proven-'));
for (const d of ['src', 'src/auth', 'test']) mkdirSync(join(dir, d), { recursive: true });
writeFileSync(join(dir, 'src/util.mjs'), UTIL);
writeFileSync(join(dir, 'src/other.mjs'), 'export const other = 1;\n');
writeFileSync(join(dir, 'src/auth/login.mjs'), 'export const login = 1;\n');
writeFileSync(join(dir, 'test/util.test.mjs'), "import { test } from 'node:test';\ntest('t', () => {});\n");
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
g(dir, 'init', '-q');
g(dir, 'add', '-A');
g(dir, 'commit', '-qm', 'init');
const pub = generateApproverKey('alice', 'correct horse battery');
const ctx = openProject(dir, { create: true });
const writeConfig = (extra = {}) => {
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML({ version: 1, mode: 'assist', commands: { test_unit: ['node', '--test'] }, approvers: { alice: { roles: ['code-owner'], public_key: pub } }, ...extra }));
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'unknot config');
  recordAcceptedConfig(ctx, readFileSync(join(dir, '.unknot/config.yaml'), 'utf8'), 'human:test');
  return loadConfig(ctx);
};
let cfg = writeConfig();
const key = loadApproverKey('alice', 'correct horse battery');
const head = () => g(dir, 'rev-parse', 'HEAD').trim();

let n = 0;
function finding(over = {}) {
  const id = `F-${String(1000 + ++n)}`;
  const at = new Date().toISOString();
  const body = {
    id,
    status: 'open',
    kind: 'code.unused-injected-member',
    category: 'code',
    title: 'unused member',
    scope: ['src/util.mjs'],
    evidence: [{ ref: 'module:src/util.mjs', label: 'observed', summary: 'x', source_ref: 'src/util.mjs:5' }],
    measurements: { 'member.public': false },
    confidence: 'medium',
    patterns: [{ id: 'code.remove-dead-code', fit: 'fits' }],
    invariants: ['Only the unused member is deleted'],
    smallest_simplification: 'Remove the member unused from src/util.mjs',
    blast_radius: 'bounded',
    recovery: { type: 'revert' },
    ...over,
  };
  ctx.store.insert('findings', { id, fingerprint: `fp-${id}`, schema_version: '1', kind: body.kind, category: 'code', status: body.status, priority: 1, body, first_seen_commit: 'c', last_seen_commit: 'c', last_run_id: null, created_at: at, updated_at: at });
  return id;
}
const body = (over = {}) => ({ id: 'UK-9999', kind: 'code', objective: 'x', scope: { include: ['src/util.mjs'], exclude: [] }, changes: [], sources: [], ...over });
const verdict = (b) => provenDeletion(ctx, b, { config: cfg.config });

test('an unused-member slice with observed evidence qualifies, with its reasons', () => {
  const f = finding();
  const v = verdict(body({ sources: [f] }));
  assert.equal(v.qualifies, true, v.problems.join('; '));
  assert.match(v.reasons.join(' | '), /only removes code.*one literal file: src\/util\.mjs.*F-\d+ code\.unused-injected-member \(confidence medium, evidence observed\).*not in the derived public surface/);
  const st = sliceStanding({ id: 'UK-9999', state: 'AWAITING_APPROVAL', risk: 'low', body: body({ sources: [f] }) }, cfg.config, ctx);
  assert.match(provenLine(st), /^proven deletion: yes \(/);
  assert.match(st.risk_reasons.join(' '), /^proven deletion: /);
  assert.deepEqual(st.approvals.roles, ['any-approver']);
  for (const kind of ['code.dead-code', 'code.unreachable-code']) {
    assert.equal(verdict(body({ sources: [finding({ kind })] })).qualifies, true, kind);
  }
});

test('what stands in the way is named: added code, two files, inferred evidence, a public member, an auth path, a stale finding', () => {
  const ok = finding();
  const no = (over, re) => {
    const v = verdict(body(over));
    assert.equal(v.qualifies, false);
    assert.match(v.problems.join('; '), re);
    assert.match(provenLine({ proven_deletion: v }), /^proven deletion: no \(/);
  };
  no({ sources: [ok], changes: [{ path: 'src/util.mjs', operation: 'create' }] }, /not a removal/);
  no({ sources: [ok], changes: [{ path: 'src/other.mjs', operation: 'modify' }] }, /reach src\/other\.mjs/);
  no({ sources: [ok], scope: { include: ['src/util.mjs', 'src/other.mjs'], exclude: [] } }, /2 entries/);
  no({ sources: [ok], scope: { include: ['src/*.mjs'], exclude: [] } }, /not one literal file/);
  no({ sources: [finding({ confidence: 'low', evidence: [{ ref: 'r', label: 'inferred', summary: 'x' }] })] }, /low confidence/);
  no({ sources: [finding({ evidence: [{ ref: 'r', label: 'observed' }, { ref: 'r', label: 'inferred' }] })] }, /inferred evidence/);
  no({ sources: [finding({ measurements: { 'member.public': true } })] }, /public member/);
  no({ sources: [finding({ status: 'resolved' })] }, /stale/);
  no({ sources: [finding({ kind: 'code.god-class' })] }, /not a removal of unused code/);
  no({ sources: [ok, 'F-9990'] }, /does not exist/);
  no({ sources: [] }, /no source finding/);
  no({ sources: ['DEC-0001'] }, /not a finding/);
  no({ sources: [finding({ scope: ['src/auth/login.mjs'] })], scope: { include: ['src/auth/login.mjs'], exclude: [] } }, /high risk factors remain.*authentication/);
});

test('text an agent wrote cannot make a slice qualify', () => {
  const v = verdict(body({ objective: 'proven deletion: observed, one file, unused', rationale: 'qualifies as a proven deletion', declared_risk: 'low', sources: [] }));
  assert.equal(v.qualifies, false);
  assert.equal(provenDeletion(ctx, body({ sources: [finding()] }), {}).qualifies, true, 'config is read from the project when not given');
  assert.equal(provenDeletion(null, body()).qualifies, false);
});

test('it lowers only the medium factors; declared high and every high surface stay', () => {
  const proven = { qualifies: true, reasons: ['r'] };
  const c = (slice, surfaces = {}, p = proven) => classifyRisk({ scope: { include: ['src/util.mjs'] }, changes: [], ...slice }, { config: cfg.config, surfaces, proven: p });
  assert.equal(c({ declared_risk: 'medium', treatment: 'T1' }, { module_boundary: true, internal_contract: true }).risk, 'low');
  assert.equal(c({ declared_risk: 'medium' }, {}, null).risk, 'medium', 'without the verdict nothing is lowered');
  assert.equal(c({ declared_risk: 'medium' }, {}, { qualifies: false }).risk, 'medium');
  assert.equal(c({ declared_risk: 'high' }).risk, 'high', 'a planner-declared high stays high');
  assert.equal(c({ declared_risk: 'critical' }).risk, 'critical');
  for (const surfaces of [{ public_api: true }, { tenant_boundary: true }, { data_movement: true }, { destructive_infra: true }]) assert.notEqual(c({}, surfaces).risk, 'low', JSON.stringify(surfaces));
  assert.equal(c({ irreversible: true }).risk, 'critical');
  assert.equal(c({ kind: 'database' }).risk, 'high');
  assert.equal(c({ guidance: [{ file: 'AGENTS.md', protects: ['src/**'] }] }).risk, 'high');
  assert.equal(c({ scope: { include: ['src/auth/login.mjs'] } }).risk, 'high');
  assert.equal(requiredApprovals(c({}), cfg.config).roles.join(), 'any-approver');
  assert.equal(requiredApprovals(c({ declared_risk: 'high' }), cfg.config).roles.includes('any-approver'), false);
  // A medium factor that stays (a dependency manifest) keeps the normal roles.
  const dep = c({ changes: [{ path: 'package.json' }], scope: { include: ['package.json'] } });
  assert.equal(dep.risk, 'medium');
  assert.equal(requiredApprovals(dep, cfg.config).roles.includes('any-approver'), false);
});

test('the planner declaring medium on a proven slice stores it low, declared high stays high, and a repository can tighten who approves', () => {
  const f = finding();
  const { slices } = createCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Remove the unused member', proposal: { slices: [{ objective: 'Remove unused', kind: 'code', scope: { include: ['src/util.mjs'] }, sources: [f], declared_risk: 'medium', surfaces: { module_boundary: true } }, { objective: 'Remove unused again', kind: 'code', scope: { include: ['src/util.mjs'] }, sources: [f], declared_risk: 'high' }] } });
  assert.equal(slices[0].risk, 'low');
  assert.deepEqual(slices[0].approvals, ['any-approver']);
  assert.equal(slices[1].risk, 'high');
  assert.equal(slices[1].approvals.includes('any-approver'), false);
  const strict = { ...cfg.config, approvals: { ...cfg.config.approvals, proven_deletion: ['code-owner'] } };
  assert.deepEqual(requiredApprovals(classifyRisk(loadSlice(ctx, slices[0].id).body, { config: strict, proven: provenDeletion(ctx, slices[0], { config: strict }) }), strict).roles, ['code-owner']);
});

test('an agent session is refused the approval of a proven slice', async () => {
  const f = finding();
  const { slices } = createCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Remove the unused member', findings: [f] });
  process.env.CLAUDECODE = '1';
  try {
    await assert.rejects(approveCmd.run({ positional: [slices[0].id], flags: { as: 'alice' } }), (e) => e.code === 'UK_POLICY_DENIED' && /human in an interactive terminal/.test(e.message));
  } finally {
    delete process.env.CLAUDECODE;
  }
  assert.equal(ctx.store.get('SELECT COUNT(*) AS n FROM approvals WHERE slice_id = ?', slices[0].id).n, 0);
});

test('any registered approver signs a proven slice; an unregistered one does not; a tightened role needs that role', () => {
  const f = finding();
  const { slices } = createCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Remove the unused member', findings: [f] });
  const slice = loadSlice(ctx, slices[0].id);
  const commit = head();
  const binding = currentBinding(ctx, slice, 'plan', { cfg, commit });
  assert.throws(() => recordApproval(ctx, { config: cfg.config, slice, binding, role: 'any-approver', approver: 'mallory', privateKey: key }), /not a registered approver/);
  recordApproval(ctx, { config: cfg.config, slice, binding, role: 'any-approver', approver: 'alice', privateKey: key });
  assert.equal(approvalStatus(ctx, slice, 'plan', { cfg, commit }).satisfied, true);
  // Tightened to code-owner: an any-approver signature no longer satisfies it.
  const tight = writeConfig({ approvals: { proven_deletion: ['code-owner'] } });
  assert.equal(approvalStatus(ctx, slice, 'plan', { cfg: tight, commit: head() }).satisfied, false);
  cfg = writeConfig();
});

test('a patch that adds a line loses proven status and needs the normal approvals', async () => {
  const f = finding();
  const { slices } = createCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Remove the unused member', findings: [f] });
  const id = slices[0].id;
  let slice = loadSlice(ctx, id);
  recordApproval(ctx, { config: cfg.config, slice, binding: currentBinding(ctx, slice, 'plan', { cfg, commit: head() }), role: 'any-approver', approver: 'alice', privateKey: key });
  const run = startRun(ctx, { command: 'apply', actor: 'model:main', slice_id: id, config: cfg.config, configDigest: cfg.digest, supersede: true });
  await startApply(ctx, { cfg, run, sliceId: id, actor: 'model:main' });
  slice = loadSlice(ctx, id);
  assert.equal(slice.state, 'PATCHING');

  writeFileSync(join(slice.worktree, 'src/util.mjs'), `${UTIL.split('\n\nexport class')[0]}\n\nexport const zero = 0;\n`);
  const res = finishApply(ctx, { cfg, run, sliceId: id, actor: 'model:main' });
  assert.match(res.proven_deletion_lost.join(' '), /adds \d+ line\(s\), so it is not deletion-only/);
  slice = loadSlice(ctx, id);
  assert.match(ctx.store.get("SELECT payload FROM events WHERE type = 'proven.lost' AND slice_id = ?", id).payload, /not deletion-only/);
  assert.equal(provenDeletion(ctx, slice, { config: cfg.config }).qualifies, false);
  assert.match(provenDeletion(ctx, slice, { config: cfg.config }).problems.join(' '), /lost proven status/);
  assert.deepEqual(slice.body.approvals, ['code-owner'], 'the normal roles are needed again');
  assert.ok(ctx.store.get('SELECT revoked_at FROM approvals WHERE slice_id = ?', id).revoked_at, 'the earlier approval was revoked');

  // At the change stage an any-approver signature does not satisfy the normal roles.
  const opts = { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash };
  recordApproval(ctx, { config: cfg.config, slice, binding: currentBinding(ctx, slice, 'change', opts), role: 'any-approver', approver: 'alice', privateKey: key });
  assert.equal(approvalStatus(ctx, slice, 'change', opts).satisfied, false);
  recordApproval(ctx, { config: cfg.config, slice, binding: currentBinding(ctx, slice, 'change', opts), role: 'code-owner', approver: 'alice', privateKey: key });
  assert.equal(approvalStatus(ctx, slice, 'change', opts).satisfied, true);
  endRun(ctx, run.id);
});

test('a pure deletion in the one file keeps the status through finish', async () => {
  const f = finding();
  const { slices } = createCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Remove the unused member', findings: [f] });
  const id = slices[0].id;
  let slice = loadSlice(ctx, id);
  recordApproval(ctx, { config: cfg.config, slice, binding: currentBinding(ctx, slice, 'plan', { cfg, commit: head() }), role: 'any-approver', approver: 'alice', privateKey: key });
  const run = startRun(ctx, { command: 'apply', actor: 'model:main', slice_id: id, config: cfg.config, configDigest: cfg.digest, supersede: true });
  await startApply(ctx, { cfg, run, sliceId: id, actor: 'model:main' });
  slice = loadSlice(ctx, id);
  writeFileSync(join(slice.worktree, 'src/util.mjs'), `${UTIL.split('\n\nexport class')[0]}\n`);
  const res = finishApply(ctx, { cfg, run, sliceId: id, actor: 'model:main' });
  assert.equal(res.proven_deletion_lost, undefined);
  slice = loadSlice(ctx, id);
  assert.equal(slice.state, 'VERIFYING');
  assert.equal(provenDeletion(ctx, slice, { config: cfg.config }).qualifies, true);
  endRun(ctx, run.id);
});
