// Every artifact schema gets a realistic valid example (spec examples where the spec has one)
// and invalid variants: a missing required field, an unknown property, plus targeted cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArtifact } from '../../../runtime/core/schema.mjs';
import { STATES } from '../../../runtime/state/machine.mjs';

const clone = (v) => structuredClone(v);
const sha = (c) => `sha256:${c.repeat(64)}`;
const NOW = '2026-10-03T12:00:00Z';

const provenance = {
  source_type: 'ast',
  source_ref: 'services/orders/src/api.ts:42',
  extractor: 'typescript-adapter@0.4.1',
  observed_at: NOW,
  commit: 'a'.repeat(40),
  confidence: 'high',
  scope: ['services/orders'],
  contradicts: [],
};

const obligation = {
  id: 'PO-17',
  slice_id: 'UK-0042',
  kind: 'unit',
  description: 'Checkout unit tests still pass',
  command: ['pnpm', 'test', 'checkout'],
  requires_human: false,
  status: 'open',
  evidence_id: null,
};

const recovery = { type: 'revert', procedure: 'git revert the slice commit', evidence_required: ['rollback-rehearsal'] };

const slice = {
  schema_version: '1.0',
  id: 'UK-0042',
  campaign: 'CMP-17',
  version: 1,
  kind: 'code',
  objective: 'Introduce a pricing facade without changing consumers',
  scope: { include: ['services/checkout/pricing/**'], exclude: ['infra/**', 'migrations/**'] },
  preconditions: ['UK-0041'],
  changes: [{ path: 'services/checkout/pricing/facade.ts', operation: 'create', description: 'Facade delegating to the old module' }],
  invariants: ['Public API of pricing is unchanged'],
  proof_obligations: ['PO-17', { schema_version: undefined, ...obligation, id: 'PO-18' }],
  risk: 'medium',
  blast_radius: 'bounded',
  recovery,
  irreversible: false,
  budgets: { max_changed_files: 8, max_diff_lines: 300 },
  status: 'AWAITING_APPROVAL',
  owners: ['checkout-owner'],
  approvals: ['checkout-owner'],
  treatment: 'T4',
};
delete slice.proof_obligations[1].schema_version;

const finding = {
  schema_version: '1.0',
  id: 'F-0123',
  fingerprint: sha('b'),
  kind: 'architecture.distributed-monolith',
  title: 'Checkout and pricing change and deploy in lockstep',
  category: 'service',
  status: 'open',
  scope: ['services/checkout', 'services/pricing'],
  evidence: [{ ref: 'service:checkout', label: 'observed', summary: '41 of 50 commits touch both', source_ref: 'git:log' }],
  quality_impacts: { changeability: 'high', reliability: 'medium', security: 'low' },
  blast_radius: 'high',
  uncertainties: [],
  alternatives: [{ id: 'retain', summary: 'Leave as is' }, { id: 'decouple', summary: 'Introduce contracts' }, { id: 'merge', summary: 'Merge deployables' }],
  priority: { score: 1.8, factors: { benefit: 4, evidence: 0.9, reversibility: 0.8, blast: 4, cost: 3, uncertainty: 2 } },
  detector: { id: 'service.lockstep-deploy', version: '1.0.0' },
  measurements: { co_change: 0.82 },
  thresholds: { co_change: 0.5 },
  why_accidental: 'The split follows team history, not a domain boundary.',
  essential_considerations: ['Separate on-call rotations'],
  smallest_simplification: 'Add a pricing contract test',
  invariants: ['Prices are unchanged'],
  risks: ['Hidden consumers'],
  verification: ['contract tests'],
  recovery: { type: 'revert', notes: 'additive' },
  patterns: [{ id: 'migration.parallel-change', fit: 'fits', reasons: ['consumers known'] }],
  approvers: ['checkout-owner'],
  first_seen_commit: 'c'.repeat(40),
  last_seen_commit: null,
};

const handoff = {
  schema_version: '1.0',
  run_id: 'run-123',
  slice_id: 'UK-0042',
  agent: 'database-analyst',
  status: 'complete',
  facts: [{ statement: 'orders.total has no NOT NULL', evidence_ref: 'column:public.orders.total', label: 'observed' }],
  proposals: [{ kind: 'finding', summary: 'Add NOT NULL via expand/contract', payload: { kind: 'database.nullable-invariant' } }],
  uncertainties: [{ statement: 'Writers unknown', impact: 'blocks contract phase' }],
  conflicts: [{ statement: 'ORM says required, DDL says nullable', refs: ['column:public.orders.total'] }],
  artifacts: [{ path: '.unknot/runs/run-123/notes.md', digest: sha('d'), description: 'notes' }],
  recommended_next_state: 'MAPPED',
};

const campaign = {
  schema_version: '1.0',
  id: 'CMP-17',
  objective: 'Reduce checkout deployment coupling',
  scope: ['services/checkout', 'services/pricing'],
  constraints: ['preserve_public_api', 'zero_planned_downtime'],
  baseline: 'BL-773',
  alternatives: ['retain_and_document', 'decouple_contracts', 'merge_deployables'],
  selected: 'merge_deployables',
  rationale: 'Lockstep releases dominate',
  risks: [],
  slices: ['UK-0041', 'UK-0042', 'UK-0043'],
  approvals: [],
  status: 'active',
  drivers: ['independent_deploy'],
  created_at: NOW,
};

const evidence = {
  schema_version: '1.0',
  id: 'evd-0001',
  slice_id: 'UK-0042',
  run_id: 'run-123',
  obligation: 'PO-17',
  command: ['pnpm', 'test', 'checkout'],
  working_directory: 'worktrees/UK-0042',
  environment_digest: sha('e'),
  diff_hash: sha('f'),
  sandbox: 'macos-sandbox-exec',
  started_at: NOW,
  duration_ms: 14220,
  exit_code: 0,
  timed_out: false,
  truncated: false,
  stdout_digest: sha('1'),
  stderr_digest: sha('2'),
  artifact_refs: [],
  verdict: 'pass',
};

const approval = {
  schema_version: '1.0',
  id: 'apr-0001',
  slice_id: 'UK-0042',
  stage: 'change',
  role: 'checkout-owner',
  approver: 'alice@example.com',
  key_fingerprint: `sha256:${'3'.repeat(32)}`,
  binding: {
    commit: 'a'.repeat(40),
    slice_version: 1,
    slice_digest: sha('4'),
    diff_hash: sha('5'),
    plan_hash: null,
    state_serial: 12,
    policy_digest: sha('6'),
    environment: 'local',
    expires_at: '2026-10-04T12:00:00Z',
  },
  signature: 'MEUCIQDexample+/=',
  created_at: NOW,
};

const decision = {
  schema_version: '1.0',
  id: 'dec-0001',
  finding_id: 'F-0123',
  fingerprint: sha('b'),
  decision: 'reject',
  rationale: 'Intentional: regulatory separation of duties',
  actor: 'human:alice',
  suppress_until: null,
  at: NOW,
};

const migration = {
  schema_version: '1.0',
  version: 1,
  slice: 'UK-DB-0042',
  engine: 'postgresql',
  engine_version: '18',
  objects: ['public.orders'],
  classification: 'confidential',
  source_of_truth: 'orders',
  compatibility: { oldest_app_version: '3.8.0', newest_app_version: '4.0.0' },
  phases: ['expand', 'backfill', 'validate', 'switch_reads', 'switch_writes', 'contract'],
  locking: { predicted_mode: 'SHARE_UPDATE_EXCLUSIVE', timeout_seconds: 5 },
  backfill: { batch_size: 1000, checkpoint_key: 'order_id', throttle: 'replica_lag < 2s and cpu < 70%' },
  validation: ['row_count', 'checksum', 'business_invariants'],
  abort_conditions: ['error_rate > baseline + 0.5%', 'replica_lag > 10s'],
  rollback: { mode: 'roll_forward', procedure: 'docs/runbooks/UK-DB-0042.md' },
  approvals: ['data-owner', 'service-owner', 'security-owner'],
};

const error = {
  code: 'UK_POLICY_DENIED',
  class: 'policy-denied',
  message: 'Infrastructure apply is not permitted in Assist mode.',
  run_id: 'run-123',
  slice_id: 'UK-0042',
  retryable: false,
  details: { policy: 'infra.apply.forbidden', required_mode: 'external-delivery-system' },
};

const event = {
  schema_version: '1.0',
  id: 'ev-0a1b2c3d4e5f',
  type: 'state.transition',
  run_id: 'run-123',
  campaign_id: 'CMP-17',
  slice_id: 'UK-0042',
  actor: 'runtime:orchestrator',
  capability_id: null,
  scope: null,
  budget: null,
  policy_decision: { allowed: true },
  payload: { from: 'PLANNED', to: 'AWAITING_APPROVAL' },
  at: NOW,
  prev_hash: 'sha256:genesis',
  hash: sha('7'),
  signature: 'c2ln',
};

const decomposition = {
  schema_version: '1.0',
  id: 'DEC-0003',
  target: 'backend',
  driver: ['independent_deploy'],
  candidate: { id: 'C-2', modules: ['services/pricing'], robust: true, metrics: { OA: 0.92 } },
  treatment: 'T2',
  favoring_signals: [{ signal: 'OA', value: 0.92, source: 'CODEOWNERS' }],
  contraindications_checked: [{ id: 'shared_table_writes', result: 'pass', value: 0 }],
  rejected_treatments: [{ treatment: 'T3', reason: 'CBT=3 without saga design' }],
  evidence_gaps: ['no runtime traces: CC unknown'],
  confidence: 'medium',
  first_slice: { objective: 'Facade over pricing' },
  proof_obligations: ['PO-1', 'unit', obligation],
  recovery: { type: 'revert' },
  irreversible: false,
  retain_score: 0.41,
  heuristics_used: ['OA>=0.8', 'weights alpha..delta'],
};

const card = {
  schema_version: '1.0',
  id: 'migration.branch-by-abstraction',
  name: 'Branch by Abstraction',
  aliases: ['BBA'],
  category: 'migration',
  treatment: 'T4',
  problem: 'Replace a subsystem incrementally while remaining releasable.',
  forces: ['Trunk must stay releasable'],
  applicability_signals: [{ id: 'many-callers', description: 'More than ten call sites', predicate: { metric: 'fan_in', op: '>=', value: 10 } }],
  required_evidence: ['call graph'],
  preconditions: [{ id: 'has-tests', description: 'Characterization tests exist', hard: true }],
  contraindications: [{ id: 'no-seam', description: 'No interface can be defined', hard: true }],
  benefits: ['Releasable at every step'],
  liabilities: ['Temporary duplication'],
  introduced_complexity: ['An abstraction layer'],
  architecture_invariants: ['Callers depend on the interface'],
  transformations: ['Introduce interface', 'Switch callers'],
  proof_obligations: ['characterization', 'no-new-cycles'],
  rollback_strategies: ['revert'],
  composes_with: ['migration.parallel-change'],
  conflicts_with: [],
  removal_recipe: ['Delete the old implementation', 'Inline the abstraction'],
  version: '1.0.0',
};

const manifest = {
  schema_version: '1.0',
  run_id: 'run-123',
  slice_id: 'UK-0042',
  created_at: NOW,
  files: [{ path: 'diff.patch', digest: sha('8'), media_type: 'text/x-diff', size: 2048 }],
  applicable: ['diff.patch', 'verification.json'],
};

const graphNode = {
  kind: 'node', id: 'module:src/a.ts', type: 'module', name: 'src/a.ts', path: 'src/a.ts', attrs: { loc: 120 }, provenance,
};
const graphEdge = {
  kind: 'edge', type: 'IMPORTS', from: 'module:src/a.ts', to: 'module:src/b.ts', attrs: {}, provenance,
};

// name -> { valid examples, mutate(fn(clone)) invalid cases [label, mutator] }
const del = (k) => (o) => { delete o[k]; };
const set = (k, v) => (o) => { o[k] = v; };
const CASES = {
  provenance: {
    valid: [provenance, { ...provenance, source_type: 'vcs', source_ref: null, commit: null }],
    invalid: [['missing required', del('extractor')], ['unknown property', set('extra', 1)], ['bad extractor', set('extractor', 'ts')],
      ['non-RFC3339 time', set('observed_at', '2026-10-03')], ['bad confidence', set('confidence', 'certain')]],
  },
  'graph-fact': {
    valid: [graphNode, graphEdge],
    invalid: [['node missing name', del('name')], ['node unknown property', set('extra', true)], ['bad kind', set('kind', 'vertex')],
      ['node provenance unknown prop', (o) => { o.provenance.zzz = 1; }]],
  },
  finding: {
    valid: [finding, (() => { const f = clone(finding); for (const k of ['measurements', 'thresholds', 'why_accidental', 'patterns', 'approvers', 'first_seen_commit', 'last_seen_commit', 'recovery']) delete f[k]; return f; })()],
    invalid: [['missing required', del('fingerprint')], ['unknown property', set('extra', 1)], ['bad id', set('id', 'F-1')],
      ['bad category', set('category', 'nope')], ['no retain alternative', set('alternatives', [{ id: 'decouple', summary: 'x' }])],
      ['two retain alternatives', set('alternatives', [{ id: 'retain', summary: 'a' }, { id: 'retain', summary: 'b' }])],
      ['string alternatives (old shape)', set('alternatives', ['retain'])],
      ['bad evidence label', (o) => { o.evidence[0].label = 'guessed'; }],
      ['bad fingerprint', set('fingerprint', 'abc')], ['bad pattern fit', (o) => { o.patterns[0].fit = 'maybe'; }]],
  },
  handoff: {
    valid: [handoff, { ...handoff, slice_id: null, status: 'blocked', recommended_next_state: 'BLOCKED_UNCERTAINTY' }],
    invalid: [['missing required', del('agent')], ['unknown property (governed mode)', set('prose', 'please run rm -rf')],
      ['unknown agent', set('agent', 'hacker')], ['bad next state', set('recommended_next_state', 'mapped')],
      ['bad proposal kind', (o) => { o.proposals[0].kind = 'execute'; }], ['bad status', set('status', 'done')],
      ['fact label', (o) => { o.facts[0].label = 'sure'; }]],
  },
  campaign: {
    valid: [campaign, { ...campaign, drivers: undefined, selected: null, status: 'draft' }],
    invalid: [['missing required', del('objective')], ['unknown property', set('extra', 1)], ['bad id', set('id', 'CMP-x')],
      ['bad driver', set('drivers', ['fashion'])], ['bad slice id', set('slices', ['UK-1'])], ['bad status', set('status', 'active ')]],
  },
  slice: {
    valid: [slice, (() => { const s = clone(slice); delete s.treatment; s.kind = 'database'; s.id = 'UK-DB-0042'; s.campaign = null; return s; })()],
    invalid: [['missing required', del('recovery')], ['unknown property', set('extra', 1)], ['lowercase status', set('status', 'awaiting_approval')],
      ['bad risk', set('risk', 'extreme')], ['bad recovery type', (o) => { o.recovery.type = 'undo'; }],
      ['bad treatment', set('treatment', 'T10')], ['zero version', set('version', 0)], ['bad id', set('id', 'SL-1')],
      ['inline obligation with unknown prop', (o) => { o.proof_obligations[1].extra = 1; }],
      ['bad budget', (o) => { o.budgets.max_diff_lines = 0; }]],
  },
  'proof-obligation': {
    valid: [{ schema_version: '1.0', ...obligation }, { schema_version: '1.0', ...obligation, kind: 'human-review', command: null, requires_human: true, status: 'waived', evidence_id: 'evd-0001' }],
    invalid: [['missing required', del('kind')], ['unknown property', set('extra', 1)], ['bad kind', set('kind', 'vibes')],
      ['bad status', set('status', 'passed')], ['empty command element', set('command', [''])], ['bad id', set('id', 'PO17')]],
  },
  'evidence-record': {
    valid: [evidence, { ...evidence, exit_code: null, timed_out: true, truncated: true, verdict: 'inconclusive', sandbox: 'none' }],
    invalid: [['missing required', del('stdout_digest')], ['unknown property', set('extra', 1)], ['bad verdict', set('verdict', 'ok')],
      ['bad sandbox', set('sandbox', 'docker')], ['negative duration', set('duration_ms', -1)], ['bad digest', set('stderr_digest', 'sha256:...')],
      ['string command', set('command', 'pnpm test')]],
  },
  approval: {
    valid: [approval, (() => { const a = clone(approval); a.stage = 'plan'; a.binding.diff_hash = null; a.binding.state_serial = null; return a; })()],
    invalid: [['missing required', del('signature')], ['unknown property', set('extra', 1)], ['bad stage', set('stage', 'merge')],
      ['binding missing policy_digest', (o) => { delete o.binding.policy_digest; }], ['binding unknown prop', (o) => { o.binding.extra = 1; }],
      ['bad commit', (o) => { o.binding.commit = 'main'; }], ['bad expiry', (o) => { o.binding.expires_at = 'tomorrow'; }]],
  },
  decision: {
    valid: [decision, { ...decision, finding_id: null, decision: 'accept', suppress_until: '2027-01-01T00:00:00Z' }],
    invalid: [['missing required', del('actor')], ['unknown property', set('extra', 1)], ['short rationale', set('rationale', 'no')],
      ['bad decision', set('decision', 'maybe')], ['bad suppress_until', set('suppress_until', 'never')]],
  },
  migration: {
    valid: [migration, (() => { const m = clone(migration); delete m.backfill; m.phases = ['expand', 'contract']; return m; })()],
    invalid: [['missing required', del('rollback')], ['unknown property', set('extra', 1)], ['bad phase', (o) => { o.phases.push('cutover'); }],
      ['bad rollback mode', (o) => { o.rollback.mode = 'rollback'; }], ['non-DB slice', set('slice', 'UK-0042')],
      ['duplicate phases', set('phases', ['expand', 'expand'])], ['zero batch', (o) => { o.backfill.batch_size = 0; }]],
  },
  error: {
    valid: [error, { ...error, run_id: null, slice_id: null, details: {}, code: 'UK_NOT_FOUND', class: 'configuration', retryable: true }],
    invalid: [['missing required', del('class')], ['unknown property', set('extra', 1)], ['bad code', set('code', 'policy_denied')],
      ['retryable string', set('retryable', 'no')], ['details array', set('details', [])]],
  },
  event: {
    valid: [event, { ...event, run_id: null, campaign_id: null, slice_id: null, policy_decision: null, signature: null, prev_hash: sha('9') }],
    invalid: [['missing required', del('hash')], ['unknown property', set('extra', 1)], ['bad actor', set('actor', 'root')],
      ['bad type', set('type', 'Transition')], ['bad prev_hash', set('prev_hash', 'genesis')], ['payload array', set('payload', [])]],
  },
  'decomposition-recommendation': {
    valid: [decomposition, { ...decomposition, target: 'frontend', treatment: 'T7', driver: ['team_autonomy', 'build_time'], irreversible: true, recovery: { type: 'restore', procedure: 'runbook' } }],
    invalid: [['missing required', del('treatment')], ['unknown property', set('extra', 1)], ['bad treatment', set('treatment', 'T11')],
      ['bad target', set('target', 'mobile')], ['bad driver', set('driver', ['hype'])], ['bad id', set('id', 'DEC-3')],
      ['bad rejected treatment', (o) => { o.rejected_treatments[0].treatment = 'X'; }], ['retain_score > 1', set('retain_score', 2)]],
  },
  'pattern-card': {
    valid: [card, { ...card, id: 'code.extract-function', category: 'code', introduction_recipe: ['Extract the block'], removal_recipe: ['Inline the function'] }],
    invalid: [['missing required', del('problem')], ['unknown property', set('extra', 1)], ['bad category', set('category', 'fashion')],
      ['code card without recipes', set('category', 'code')],
      ['code card missing introduction_recipe', (o) => { o.category = 'code'; o.removal_recipe = ['x']; }],
      ['signal as string', set('preconditions', ['has tests'])], ['bad operator', (o) => { o.applicability_signals[0].predicate.op = '=>'; }],
      ['bad version', set('version', '1.0')], ['bad obligation kind', set('proof_obligations', ['vibes'])],
      ['bad rollback strategy', set('rollback_strategies', ['pray'])]],
  },
  'proof-bundle-manifest': {
    valid: [manifest, { ...manifest, files: [], applicable: [] }],
    invalid: [['missing required', del('run_id')], ['unknown property', set('extra', 1)], ['file unknown prop', (o) => { o.files[0].mode = 644; }],
      ['negative size', (o) => { o.files[0].size = -1; }], ['bad digest', (o) => { o.files[0].digest = 'abc'; }],
      ['duplicate applicable', set('applicable', ['a', 'a'])]],
  },
};

for (const [name, { valid, invalid }] of Object.entries(CASES)) {
  test(`${name}: valid examples`, () => {
    valid.forEach((ex, i) => {
      const v = JSON.parse(JSON.stringify(ex)); // drops `undefined` members used above for omission
      const r = validateArtifact(name, v);
      assert.equal(r.valid, true, `example ${i}: ${JSON.stringify(r.errors)}`);
    });
  });
  test(`${name}: invalid variants are rejected`, () => {
    assert.ok(invalid.length >= 2);
    for (const [label, mutate] of invalid) {
      const doc = clone(JSON.parse(JSON.stringify(valid[0])));
      mutate(doc);
      const r = validateArtifact(name, doc);
      assert.equal(r.valid, false, `${label} should be invalid`);
      assert.ok(r.errors.length > 0 && r.errors.every((e) => typeof e.path === 'string' && e.keyword && e.message), label);
    }
  });
}

test('the CASES table covers every shipped artifact schema except config', async () => {
  const { loadSchemas } = await import('../../../runtime/core/schema.mjs');
  const names = [...loadSchemas().keys()].map((id) => id.split('/').pop().replace('.schema.json', '')).filter((n) => n !== 'config');
  assert.deepEqual(names.sort(), Object.keys(CASES).sort());
});

test('slice and handoff state enums match runtime/state/machine.mjs exactly', async () => {
  const { loadSchemas } = await import('../../../runtime/core/schema.mjs');
  const reg = loadSchemas();
  const sliceSchema = reg.get('https://unknot.dev/schemas/slice.schema.json');
  assert.deepEqual(sliceSchema.$defs.state.enum, [...STATES]);
  for (const s of STATES) {
    assert.equal(validateArtifact('handoff', { ...handoff, recommended_next_state: s }).valid, true, s);
    assert.equal(validateArtifact('slice', { ...slice, status: s }).valid, true, s);
  }
});

test('error schema accepts everything UnknotError serializes', async () => {
  const { UnknotError, ERROR_CLASSES } = await import('../../../runtime/core/errors.mjs');
  for (const code of Object.keys(ERROR_CLASSES)) {
    const json = new UnknotError(code, 'boom', { run_id: 'run-1', slice_id: 'UK-0001' }).toJSON();
    const r = validateArtifact('error', json);
    assert.equal(r.valid, true, `${code}: ${JSON.stringify(r.errors)}`);
  }
});

test('graph-fact accepts facts built by runtime/graph/facts.mjs', async () => {
  const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
  const p = { ...prov({ source_type: 'ast', source_ref: 'a.ts:1', extractor: 'ts-adapter@1.0.0' }), observed_at: NOW, commit: null };
  assert.equal(validateArtifact('graph-fact', nodeFact('module', 'src/a.ts', { path: 'src/a.ts' }, p)).valid, true);
  assert.equal(validateArtifact('graph-fact', edgeFact('IMPORTS', 'module:a', 'module:b', {}, p)).valid, true);
});

test('finding errors point at the offending field', () => {
  const f = clone(finding);
  f.evidence[0].label = 'guessed';
  const r = validateArtifact('finding', f);
  assert.ok(r.errors.some((e) => e.path === '/evidence/0/label' && e.keyword === 'enum'));
});

test('graph-fact oneOf failure explains the closest branch', () => {
  const r = validateArtifact('graph-fact', { ...graphNode, name: 5 });
  assert.ok(r.errors.some((e) => e.path === '/name'), JSON.stringify(r.errors));
});
