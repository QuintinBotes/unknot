import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'uk-explain-home-'));
const project = mkdtempSync(join(tmpdir(), 'uk-explain-project-'));
process.env.UNKNOT_HOME = home;

const finding = {
  id: 'F-0001',
  fingerprint: 'sha256:explain-test',
  status: 'open',
  title: 'Two modules depend on each other',
  evidence: [{ ref: 'module:src/ledger.ts', label: 'observed', summary: 'imports src/orders.ts', source_ref: 'src/ledger.ts:12' }],
  why_accidental: 'The modules exchange implementation details instead of a narrow boundary.',
  essential_considerations: ['The public request shape may be intentional.'],
  smallest_simplification: 'Move the shared request type to one module.',
  invariants: ['Requests keep their current result.'],
  risks: ['A moved type can break an import path.'],
  verification: ['Run the type check.'],
  recovery: { type: 'revert', notes: 'Revert the one commit.' },
  risk: 'medium',
  approvers: ['code-owner'],
  uncertainties: ['Runtime callers are not available.'],
  alternatives: [
    { id: 'retain', summary: 'Keep the dependency and document why.' },
    { id: 'extract-type', summary: 'Extract only the shared request type.' },
  ],
  patterns: [],
  priority: { score: 0.5, factors: { benefit: 2, evidence: 1, reversibility: 1, blast: 2, cost: 1, uncertainty: 2 } },
  measurements: { 'imports.count': 2 },
  thresholds: { 'cycle.max_size': 1 },
};

before(async () => {
  const { openProject } = await import('../../../runtime/context.mjs');
  const ctx = openProject(project, { create: true });
  ctx.store.insert('findings', {
    id: finding.id,
    fingerprint: finding.fingerprint,
    schema_version: '1.0',
    kind: 'module.dependency-cycle',
    category: 'module',
    status: finding.status,
    priority: finding.priority.score,
    body: finding,
    first_seen_commit: null,
    last_seen_commit: null,
    last_run_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  ctx.store.close();
});

after(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const explain = (...args) => spawnSync(process.execPath, [BIN, 'explain', finding.id, ...args, '--cwd', project], {
  encoding: 'utf8',
  env: { ...process.env, UNKNOT_HOME: home },
});

test('explain renders the ten answers, path-and-line evidence, and alternatives as text by default', () => {
  const result = explain();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^F-0001 · open$/m);
  for (const heading of [
    '1. What complexity exists?', '2. What evidence supports that?', '3. Why is it accidental rather than essential?',
    '4. What is the smallest useful simplification?', '5. What behaviour and qualities must remain unchanged?',
    '6. What could fail?', '7. How will it be verified?', '8. How can it be reversed or restored?',
    '9. Who must approve it?', '10. What uncertainty remains?',
  ]) assert.match(result.stdout, new RegExp(`^${heading.replace(/[.?]/g, '\\$&')}$`, 'm'));
  assert.match(result.stdout, /- src\/ledger\.ts:12 — observed: imports src\/orders\.ts/);
  assert.ok(result.stdout.indexOf('Alternatives') > result.stdout.indexOf('10. What uncertainty remains?'));
  assert.match(result.stdout, /- retain: Keep the dependency and document why\./);
  assert.doesNotMatch(result.stdout, /"1_what"/);
});

test('explain --json keeps the previous raw finding output', () => {
  const result = explain('--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: finding.id,
    status: finding.status,
    '1_what': finding.title,
    '2_evidence': [{ ...finding.evidence[0], node_label: 'unknown', provenance: [] }],
    '3_why_accidental': { argument: finding.why_accidental, essential_considerations: finding.essential_considerations },
    '4_smallest_simplification': finding.smallest_simplification,
    '5_invariants': finding.invariants,
    '6_what_could_fail': finding.risks,
    '7_verification': finding.verification,
    '8_recovery': finding.recovery,
    '9_approvers': { risk: finding.risk, roles: finding.approvers },
    '10_uncertainty': finding.uncertainties,
    alternatives: finding.alternatives,
    pattern_fit: [],
    priority: finding.priority,
    measurements: finding.measurements,
    thresholds: finding.thresholds,
    decisions: [],
  });
});
