import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { databaseInventory, infrastructureInventory, securityInventory, threatChecklist } from '../../../runtime/artifacts/reports.mjs';
import { edge, mod, node } from '../../fixtures/artifacts/systems.mjs';

function dbFacts() {
  return [
    node('engine', 'postgresql', { name: 'postgresql', attrs: { version: '16.2' } }),
    node('table', 'public.orders', { name: 'public.orders' }), node('table', 'public.users', { name: 'public.users' }),
    mod('packages/orders/repo.ts'), mod('packages/billing/repo.ts'), mod('packages/users/repo.ts'),
    node('package', 'orders', { name: 'orders', path: 'packages/orders/package.json' }),
    node('package', 'billing', { name: 'billing', path: 'packages/billing/package.json' }),
    node('package', 'users', { name: 'users', path: 'packages/users/package.json' }),
    edge('MUTATES', 'module:packages/orders/repo.ts', 'table:public.orders'),
    edge('MUTATES', 'module:packages/billing/repo.ts', 'table:public.orders'),
    edge('MUTATES', 'module:packages/users/repo.ts', 'table:public.users'),
    edge('OWNS_DATA', 'module:packages/users/repo.ts', 'table:public.users'),
    node('migration', 'db/V1__init.sql', { path: 'db/V1__init.sql', attrs: { framework: 'flyway', has_down: true, statements: [{ kind: 'create_table', table: 'public.orders', forecast: { lock_mode: 'ACCESS EXCLUSIVE', rewrite: false } }] } }),
    node('migration', 'db/V2__alter.sql', {
      path: 'db/V2__alter.sql',
      attrs: {
        framework: 'flyway', has_down: false, destructive: false,
        statements: [{ kind: 'alter_column_type', table: 'public.orders', forecast: { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'table', scan: 'full', safer_alternative: 'add a new column and backfill', confidence: 'high' } }],
      },
    }),
    node('migration', 'db/V3__add.sql', { path: 'db/V3__add.sql', attrs: { framework: 'flyway', has_down: true, statements: [{ kind: 'add_column', table: 'public.users', forecast: { lock_mode: 'NONE', rewrite: 'none' } }] } }),
    node('migration', 'prisma/m1/migration.sql', { path: 'prisma/m1/migration.sql', attrs: { framework: 'prisma', has_down: true, statements: [] } }),
    node('constraint', 'orders_pkey', { name: 'orders_pkey' }),
  ];
}

test('database inventory: shared writers, hazards by forecast, framework counts', () => {
  const inv = databaseInventory(Graph.fromFacts(dbFacts()));
  assert.equal(inv.migrations.total, 4);
  assert.deepEqual(inv.migrations.by_framework, { flyway: 3, prisma: 1 });
  assert.equal(inv.engines[0].version, '16.2');
  assert.equal(inv.tables.total, 2);
  assert.equal(inv.shared_writer_tables.length, 1);
  assert.equal(inv.shared_writer_tables[0].table, 'public.orders');
  assert.deepEqual(inv.shared_writer_tables[0].writers, ['billing', 'orders']);
  assert.deepEqual(inv.writers_by_group.users, ['public.users']);
  // V2 rewrites a table and has no down migration; V3's lock is NONE so it is not hazardous.
  const ids = inv.hazardous_migrations.map((m) => m.path);
  assert.ok(ids.includes('db/V2__alter.sql'));
  const v2 = inv.hazardous_migrations.find((m) => m.path === 'db/V2__alter.sql');
  assert.ok(v2.hazards.includes('no down migration'));
  assert.ok(v2.hazards.some((h) => /rewrites public\.orders/.test(h)));
  assert.equal(v2.forecasts[0].safer_alternative, 'add a new column and backfill');
  assert.ok(!ids.includes('db/V3__add.sql'));
});

test('database invariants: missing unless the graph or config states them', () => {
  const inv = databaseInventory(Graph.fromFacts(dbFacts()));
  assert.equal(inv.invariants.length, 12);
  const by = Object.fromEntries(inv.invariants.map((i) => [i.id, i]));
  assert.equal(by.source_of_truth.status, 'declared');
  assert.equal(by.source_of_truth.source, 'graph');
  assert.equal(by.constraints.status, 'declared');
  for (const id of ['transaction_boundaries', 'ordering_idempotency', 'encryption_keys', 'rpo_rto_backup_restore', 'compatibility_window', 'reconciliation', 'cutover_abort']) {
    assert.equal(by[id].status, 'missing', id);
  }
  assert.ok(inv.missing_invariants.includes('reconciliation'));

  const withConfig = databaseInventory(Graph.fromFacts(dbFacts()), { config: { database: { invariants: { reconciliation: 'row counts match within 0.1%' } } } });
  const rec = withConfig.invariants.find((i) => i.id === 'reconciliation');
  assert.deepEqual([rec.status, rec.source], ['declared', 'config']);
  // Nothing at all declared: all twelve are missing, none invented.
  const empty = databaseInventory(Graph.fromFacts([node('table', 'public.t', { name: 'public.t' })]));
  assert.equal(empty.missing_invariants.length, 12);
});

test('infrastructure inventory: resources, state backends, plans, drift, exposure, IAM, layers', () => {
  const g = Graph.fromFacts([
    node('resource', 'aws_instance.web', { name: 'aws_instance.web', attrs: { type: 'aws_instance', address: 'aws_instance.web', provider: 'aws' } }),
    node('resource', 'aws_s3_bucket.logs', { name: 'aws_s3_bucket.logs', attrs: { type: 'aws_s3_bucket', address: 'aws_s3_bucket.logs', provider: 'aws' } }),
    node('resource', 'aws_security_group.open', { name: 'aws_security_group.open', attrs: { type: 'aws_security_group', address: 'aws_security_group.open', public_ingress: true, ports: ['22'] } }),
    node('resource', 'aws_iam_policy.admin', { name: 'aws_iam_policy.admin', attrs: { type: 'aws_iam_policy', address: 'aws_iam_policy.admin', wildcard_actions: ['*'], wildcard_resources: true } }),
    node('state_backend', 'recorded/abc', { name: 'recorded state', attrs: { recorded: true, serial: 7, resource_count: 4 } }),
    node('state_backend', 'dir/s3', { name: 'backend s3', attrs: { type: 's3', bucket: 'tf-state' } }),
    node('plan_action', 'h1/(plan)', { name: 'plan h1', attrs: { summary: { create: 1, delete: 1 }, source: 'plan.json' } }),
    node('plan_action', 'h1/aws_instance.web', { name: 'delete aws_instance.web', attrs: { action: 'delete' } }),
    node('plan_action', 'h1/aws_s3_bucket.logs', { name: 'create', attrs: { action: 'create' } }),
    node('resource', 'drift/missing/aws_instance.db', { name: 'missing: aws_instance.db', attrs: { drift: { kind: 'missing', address: 'aws_instance.db' }, source: 'inventory.json' } }),
    node('ingress', 'prod/edge', { name: 'edge', attrs: { namespace: 'prod' } }),
    node('workload', 'prod/Deployment/api', { name: 'api', attrs: { namespace: 'prod' } }),
  ]);
  const inv = infrastructureInventory(g);
  assert.equal(inv.resources.declared, 4);
  assert.equal(inv.resources.by_type.aws_instance, 1);
  assert.equal(inv.resources.by_kind.workload, 1);
  assert.equal(inv.state_backends.length, 2);
  assert.equal(inv.state_backends.find((b) => b.recorded).serial, 7);
  assert.equal(inv.plans.imported, 1);
  assert.deepEqual(inv.plans.actions, { create: 1, delete: 1 });
  assert.deepEqual(inv.drift.by_kind, { missing: 1 });
  assert.ok(inv.public_exposure.some((e) => e.name === 'edge'));
  assert.ok(inv.public_exposure.some((e) => /public ingress/.test(e.why)));
  assert.ok(inv.iam_wildcards.some((i) => i.name === 'aws_iam_policy.admin' && i.reasons.some((r) => /wildcard/.test(r))));
  const layers = Object.fromEntries(inv.state_hierarchy.map((l) => [l.layer, l.present]));
  assert.deepEqual(layers, { declared: true, planned: true, recorded: true, actual: true, observed: false, intended: false });
  assert.deepEqual(inv.absent_layers, ['observed', 'intended']);
});

test('infrastructure inventory on an empty graph reports every layer absent', () => {
  const inv = infrastructureInventory(new Graph());
  assert.equal(inv.absent_layers.length, 6);
  assert.equal(inv.resources.declared, 0);
});

test('security inventory: secrets by kind and location only, privilege paths, trust boundaries', () => {
  const SECRET_VALUE = 'AKIAIOSFODNN7EXAMPLE';
  const g = Graph.fromFacts([
    mod('src/config.ts', { security_signals: [{ kind: 'hardcoded-secret', line: 12, detail: SECRET_VALUE }, { kind: 'exec', line: 30, detail: 'child_process.exec' }] }),
    node('secret_ref', 'prod/db', { name: 'db', attrs: { namespace: 'prod' } }),
    node('service_account', 'prod/api', { name: 'api', attrs: { namespace: 'prod' } }),
    node('role', 'prod/admin', { name: 'admin', attrs: { cluster_admin: true } }),
    node('permission', 'k8s/prod/admin', { name: 'admin permissions' }),
    edge('ASSUMES', 'service_account:prod/api', 'role:prod/admin'),
    edge('GRANTS', 'role:prod/admin', 'permission:k8s/prod/admin'),
    node('workload', 'prod/Deployment/api', { name: 'api', attrs: { namespace: 'prod', service_account: 'api' } }),
    node('ingress', 'prod/edge', { name: 'edge' }),
    node('firewall_rule', 'prod/deny', { name: 'deny' }),
  ]);
  const inv = securityInventory(g);
  assert.deepEqual(inv.secret_findings, [{ kind: 'hardcoded-secret', location: 'src/config.ts:12' }]);
  assert.ok(!JSON.stringify(inv).includes(SECRET_VALUE));
  assert.equal(inv.secret_references, 1);
  assert.equal(inv.privilege_paths.length, 1);
  assert.deepEqual([inv.privilege_paths[0].role, inv.privilege_paths[0].permissions, inv.privilege_paths[0].workloads], ['admin', ['admin permissions'], ['api']]);
  assert.ok(inv.privilege_paths[0].risky.includes('cluster-admin'));
  assert.equal(inv.trust_boundaries.public_entries.length, 1);
  assert.deepEqual(inv.trust_boundaries.workloads_without_policy, ['api']);
});

test('threat checklist covers all eleven spec threats and says "none" when there is no evidence', () => {
  const list = threatChecklist(new Graph());
  assert.equal(list.length, 11);
  assert.ok(list.every((t) => t.evidenced === false && t.evidence.length === 0));
  assert.ok(list.find((t) => t.id === 'hallucinated-evidence').note);

  const g = Graph.fromFacts([
    mod('src/run.ts', { security_signals: [{ kind: 'child_process.exec', line: 3 }, { kind: 'prompt-injection', line: 9 }] }),
    node('column', 'public.t.tenant_id', { name: 'tenant_id' }),
    node('migration', 'db/V9.sql', { path: 'db/V9.sql', attrs: { destructive: true } }),
    node('dependency', 'left-pad', { name: 'left-pad', attrs: { pinned: false } }),
  ]);
  const hit = Object.fromEntries(threatChecklist(g, { staleFacts: 3 }).map((t) => [t.id, t.evidenced]));
  assert.equal(hit['shell-injection-traversal'], true);
  assert.equal(hit['prompt-injection'], true);
  assert.equal(hit['cross-boundary-leakage'], true);
  assert.equal(hit['destructive-actions'], true);
  assert.equal(hit['dependency-confusion'], true);
  assert.equal(hit['stale-evidence'], true);
  assert.equal(hit['excessive-permission'], false);
});
