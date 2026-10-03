import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { distributedMonolith, edge, layeredMonolith, microservices, mod, node } = await import('../../fixtures/artifacts/systems.mjs');
const architecture = await import('../../../runtime/cli/commands/architecture.mjs');
const database = await import('../../../runtime/cli/commands/database.mjs');
const infrastructure = await import('../../../runtime/cli/commands/infrastructure.mjs');
const security = await import('../../../runtime/cli/commands/security.mjs');

async function capture(fn) {
  const write = process.stdout.write;
  let buf = '';
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return buf;
}

function makeProject(facts, { mode = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uk-art-'));
  const ctx = openProject(dir, { create: true });
  project(ctx, facts, { commit: 'abc123', observedAt: '2026-10-01T00:00:00.000Z' });
  if (mode) writeFileSync(join(dir, '.unknot', 'config.yaml'), `version: 1\nmode: ${mode}\n`);
  return { dir, ctx };
}

test('architecture writes view pages, styles.md and workspace.dsl in mode plan', async () => {
  const { dir } = makeProject([...microservices(), ...layeredMonolith()]);
  const out = await capture(() => architecture.run({ positional: [], flags: { cwd: dir } }));
  const base = join(dir, '.unknot', 'docs', 'architecture');
  for (const f of ['unknot-landscape.md', 'unknot-context.md', 'unknot-containers.md', 'unknot-components.md', 'unknot-deployment.md', 'unknot-sequences.md', 'unknot-data-ownership.md', 'unknot-trust-boundaries.md', 'unknot-cycles.md', 'unknot-build-deploy-coupling.md', 'styles.md', 'workspace.dsl']) {
    assert.ok(existsSync(join(base, f)), f);
  }
  const page = readFileSync(join(base, 'unknot-containers.md'), 'utf8');
  assert.match(page, /```mermaid\nC4Container/);
  assert.match(page, /## Notes/);
  assert.match(page, /\| observed \| \d+ \|/);
  assert.match(readFileSync(join(base, 'styles.md'), 'utf8'), /## microservices \(/);
  assert.match(readFileSync(join(base, 'workspace.dsl'), 'utf8'), /^workspace /);
  assert.match(out, /Wrote 12 file/);
});

test('architecture --json shape and custom --out', async () => {
  const { dir } = makeProject(layeredMonolith());
  const out = JSON.parse(await capture(() => architecture.run({ positional: [], flags: { cwd: dir, json: true, out: 'docs/arch' } })));
  assert.deepEqual(Object.keys(out.views), ['landscape', 'context', 'containers', 'components', 'deployment', 'sequences', 'data_ownership', 'trust_boundaries', 'cycles', 'build_deploy_coupling']);
  assert.ok(Array.isArray(out.styles) && out.styles.some((s) => s.style === 'layered'));
  assert.equal(out.wrote, true);
  assert.ok(out.written.includes('docs/arch/unknot-landscape.md'));
  assert.ok(existsSync(join(dir, 'docs', 'arch', 'styles.md')));
  assert.ok(!('pages' in out));
  for (const v of Object.values(out.views)) assert.ok(typeof v.mermaid === 'string' && Array.isArray(v.notes) && v.evidence);
});

test('architecture refuses to write outside the project', async () => {
  const { dir } = makeProject(layeredMonolith());
  await assert.rejects(() => architecture.run({ positional: [], flags: { cwd: dir, out: '../escape' } }), /escapes the root|UK_SCOPE_VIOLATION/);
});

test('architecture in observe mode prints and writes nothing', async () => {
  const { dir } = makeProject(layeredMonolith(), { mode: 'observe' });
  const out = await capture(() => architecture.run({ positional: [], flags: { cwd: dir } }));
  assert.match(out, /does not permit writing documentation/);
  assert.match(out, /```mermaid/);
  assert.ok(!existsSync(join(dir, '.unknot', 'docs')));
  const json = JSON.parse(await capture(() => architecture.run({ positional: [], flags: { cwd: dir, json: true } })));
  assert.equal(json.wrote, false);
  assert.deepEqual(json.written, []);
  assert.match(json.note, /nothing was written/);
});

test('architecture on an unmapped project says to map first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-art-'));
  openProject(dir, { create: true });
  await assert.rejects(() => architecture.run({ positional: [], flags: { cwd: dir } }), /run unknot map first/);
});

test('database report --json: inventory and missing invariants', async () => {
  const { dir } = makeProject([
    node('table', 'public.orders', { name: 'public.orders' }),
    mod('packages/a/repo.ts'), mod('packages/b/repo.ts'),
    node('package', 'a', { name: 'a', path: 'packages/a/package.json' }), node('package', 'b', { name: 'b', path: 'packages/b/package.json' }),
    edge('MUTATES', 'module:packages/a/repo.ts', 'table:public.orders'), edge('MUTATES', 'module:packages/b/repo.ts', 'table:public.orders'),
    node('migration', 'db/V1.sql', { path: 'db/V1.sql', attrs: { framework: 'flyway', has_down: false, statements: [{ kind: 'alter_column_type', table: 'public.orders', forecast: { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'table' } }] } }),
  ]);
  const out = JSON.parse(await capture(() => database.run({ positional: [], flags: { cwd: dir, json: true } })));
  assert.equal(out.command, 'database');
  assert.deepEqual(out.inventory.migrations.by_framework, { flyway: 1 });
  assert.equal(out.inventory.shared_writer_tables[0].table, 'public.orders');
  assert.equal(out.inventory.hazardous_migrations.length, 1);
  assert.equal(out.inventory.invariants.length, 12);
  assert.ok(out.inventory.missing_invariants.includes('cutover_abort'));
  assert.equal(out.inventory.catalog_evidence.facts, 0);
  assert.ok(Array.isArray(out.findings));
  assert.ok('detectors' in out.stats);
  const text = await capture(() => database.run({ positional: [], flags: { cwd: dir } }));
  assert.match(text, /Shared-writer tables: 1/);
  assert.match(text, /Required invariants \(spec 14\.5\): \d+ declared, \d+ missing/);
  assert.match(text, /safer|lock ACCESS EXCLUSIVE/);
});

test('infrastructure report --json: layers present and absent', async () => {
  const { dir } = makeProject([
    node('resource', 'aws_instance.web', { name: 'aws_instance.web', attrs: { type: 'aws_instance', address: 'aws_instance.web', provider: 'aws' } }),
    node('resource', 'aws_security_group.open', { name: 'aws_security_group.open', attrs: { type: 'aws_security_group', public_ingress: true, ports: ['22'] } }),
    node('state_backend', 'recorded/x', { name: 'recorded state', attrs: { recorded: true, serial: 3, resource_count: 2 } }),
    node('resource', 'drift/missing/a', { name: 'missing: a', attrs: { drift: { kind: 'missing', address: 'a' } } }),
  ]);
  const out = JSON.parse(await capture(() => infrastructure.run({ positional: [], flags: { cwd: dir, json: true } })));
  assert.equal(out.command, 'infrastructure');
  assert.equal(out.inventory.resources.declared, 2);
  assert.equal(out.inventory.state_backends.length, 1);
  assert.equal(out.inventory.drift.total, 1);
  assert.equal(out.inventory.public_exposure.length, 1);
  assert.deepEqual(out.inventory.state_hierarchy.map((l) => l.layer), ['declared', 'planned', 'recorded', 'actual', 'observed', 'intended']);
  assert.ok(out.inventory.absent_layers.includes('planned'));
  const text = await capture(() => infrastructure.run({ positional: [], flags: { cwd: dir } }));
  assert.match(text, /State hierarchy \(spec 15\.4\)/);
  assert.match(text, /Absent layers/);
});

test('security report and slice security delta', async () => {
  const { dir, ctx } = makeProject([
    mod('src/auth/login.ts', { security_signals: [{ kind: 'hardcoded-secret', line: 4, detail: 'AKIAIOSFODNN7EXAMPLE' }] }),
    mod('src/util.ts'),
    node('role', 'prod/admin', { name: 'admin', attrs: { cluster_admin: true } }),
    node('service_account', 'prod/api', { name: 'api', attrs: { namespace: 'prod' } }),
    edge('ASSUMES', 'service_account:prod/api', 'role:prod/admin'),
  ]);
  const body = { objective: 'Tighten login', changes: [{ path: 'src/auth/login.ts' }, { path: 'src/util.ts' }], scope: { include: ['src/**'] } };
  ctx.store.insert('slices', { id: 'UK-0001', campaign_id: null, schema_version: '1.0', state: 'AWAITING_APPROVAL', risk: 'high', body, slice_digest: 'd', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' });
  ctx.store.insert('proof_obligations', { id: 'PO-1', slice_id: 'UK-0001', kind: 'secrets-scan', body: { description: 'The diff introduces no credential-like values' }, requires_human: 0, status: 'open' });
  ctx.store.insert('proof_obligations', { id: 'PO-2', slice_id: 'UK-0001', kind: 'human-review', body: { description: 'Security owner reviews the authorization and secrets delta' }, requires_human: 1, status: 'open' });
  ctx.store.insert('proof_obligations', { id: 'PO-3', slice_id: 'UK-0001', kind: 'lint', body: { description: 'Project linter passes' }, requires_human: 0, status: 'pass' });

  const plain = JSON.parse(await capture(() => security.run({ positional: [], flags: { cwd: dir, json: true } })));
  assert.equal(plain.command, 'security');
  assert.equal(plain.inventory.threats.length, 11);
  assert.deepEqual(plain.inventory.secret_findings, [{ kind: 'hardcoded-secret', location: 'src/auth/login.ts:4' }]);
  assert.ok(!JSON.stringify(plain).includes('AKIAIOSFODNN7EXAMPLE'));
  assert.equal(plain.inventory.privilege_paths[0].role, 'admin');
  assert.equal(plain.inventory.slice_delta, undefined);

  const withSlice = JSON.parse(await capture(() => security.run({ positional: ['UK-0001'], flags: { cwd: dir, json: true } })));
  const d = withSlice.inventory.slice_delta;
  assert.equal(d.slice, 'UK-0001');
  assert.deepEqual(d.changed_paths.map((p) => p.path), ['src/auth/login.ts']);
  assert.deepEqual(d.obligations.map((o) => o.id), ['PO-1', 'PO-2']);
  assert.deepEqual(d.unsatisfied, ['PO-1', 'PO-2']);

  const text = await capture(() => security.run({ positional: ['UK-0001'], flags: { cwd: dir } }));
  assert.match(text, /Threat checklist \(spec 16\.1\)/);
  assert.match(text, /hardcoded-secret at src\/auth\/login\.ts:4/);
  assert.match(text, /Security delta of UK-0001/);

  await assert.rejects(() => security.run({ positional: ['UK-9999'], flags: { cwd: dir } }), /no slice UK-9999/);
});

test('database on a distributed monolith still reports instead of throwing', async () => {
  const { dir } = makeProject(distributedMonolith());
  const out = JSON.parse(await capture(() => database.run({ positional: [], flags: { cwd: dir, json: true } })));
  assert.equal(out.inventory.shared_writer_tables.length, 1);
  assert.deepEqual(out.inventory.shared_writer_tables[0].writers, ['ledger', 'orders', 'payments']);
});
