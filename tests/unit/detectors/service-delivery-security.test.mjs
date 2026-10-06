import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The engine reads $UNKNOT_HOME for keys, so point it at a temp dir before importing.
const HOME = mkdtempSync(join(tmpdir(), 'unknot-home-'));
const PROJECT = mkdtempSync(join(tmpdir(), 'unknot-proj-'));
process.env.UNKNOT_HOME = HOME;
after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
});

const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { diagnose } = await import('../../../runtime/diagnose/engine.mjs');
const { openProject } = await import('../../../runtime/context.mjs');
const service = (await import('../../../runtime/diagnose/detectors/service.mjs')).default;
const delivery = (await import('../../../runtime/diagnose/detectors/delivery.mjs')).default;
const security = (await import('../../../runtime/diagnose/detectors/security.mjs')).default;
const adapter = (await import('../../../adapters/security/index.mjs')).default;

const P = prov({ source_type: 'ast', source_ref: 'x:1', extractor: 'test@0', confidence: 'high' });
const N = (type, key, attrs = {}, { name, path } = {}) => nodeFact(type, key, { name, path, attrs }, P);
const E = (type, from, to, attrs = {}) => edgeFact(type, from, to, attrs, P);
const mod = (path, attrs = {}) => N('module', path, { loc: 10, ...attrs }, { path });
const svc = (name, attrs = {}) => N('service', name, { span_count: 1000, ...attrs }, { name });

const all = [...service, ...delivery, ...security];
const byId = new Map(all.map((d) => [d.id, d]));
function run(id, facts, options = {}) {
  return byId.get(id).detect({ graph: Graph.fromFacts(facts), options, config: {}, scope: [] });
}

// ---------------------------------------------------------------- registry

test('every detector has a unique id, category and kinds', () => {
  assert.equal(new Set(all.map((d) => d.id)).size, all.length);
  assert.equal(service.length, 10);
  assert.equal(delivery.length, 6);
  assert.equal(security.length, 9);
  for (const d of service) assert.equal(d.category, 'service');
  for (const d of delivery) assert.equal(d.category, 'delivery');
  for (const d of security) assert.equal(d.category, 'security');
});

// ---------------------------------------------------------------- service

const twoServices = () => [
  svc('orders', { code_root: 'services/orders' }),
  svc('billing', { code_root: 'services/billing' }),
  N('deployable', 'orders', { co_deployed_with: ['billing'] }),
  N('deployable', 'billing', { co_deployed_with: ['orders'] }),
];

test('distributed-monolith: co-deployed services with a call cycle', () => {
  const f = twoServices();
  f[0].attrs.call_cycles = [{ path: 'orders>billing>orders', traces: 4 }];
  const out = run('service.distributed-monolith', f);
  assert.equal(out.length, 1);
  assert.equal(out[0].measurements['service.count'], 2);
  assert.deepEqual(out[0].scope, ['services/billing', 'services/orders']);
});

test('distributed-monolith: co-deployed services sharing a written table', () => {
  const f = [
    ...twoServices(),
    mod('services/orders/db.ts'), mod('services/billing/db.ts'), N('table', 'public.orders'),
    E('MUTATES', 'module:services/orders/db.ts', 'table:public.orders', { line: 4 }),
    E('MUTATES', 'module:services/billing/db.ts', 'table:public.orders', { line: 9 }),
  ];
  assert.equal(run('service.distributed-monolith', f).length, 1);
});

test('distributed-monolith: no finding without coupling, or without co-deployment', () => {
  assert.equal(run('service.distributed-monolith', twoServices()).length, 0);
  const cyc = [svc('orders', { code_root: 'services/orders', call_cycles: [{ path: 'orders>billing>orders' }] }), svc('billing', { code_root: 'services/billing' })];
  assert.equal(run('service.distributed-monolith', cyc).length, 0);
});

test('distributed-monolith: a deploy job with two targets counts as co-deployment', () => {
  const f = [
    svc('orders', { code_root: 'services/orders', call_cycles: [{ path: 'orders>billing>orders' }] }), svc('billing', { code_root: 'services/billing' }),
    N('job', '.github/workflows/d.yml#deploy', { deploys: ['orders', 'billing'], deploy_signal: true }),
  ];
  assert.equal(run('service.distributed-monolith', f).length, 1);
});

test('chatty-calls: flags only above the threshold', () => {
  const f = (n) => [svc('a'), svc('b'), E('RUNTIME_CALLS', 'service:a', 'service:b', { per_request_p95: n, traces: 20 })];
  const out = run('service.chatty-calls', f(8));
  assert.equal(out.length, 1);
  assert.equal(out[0].measurements['boundary.calls_per_request_p95'], 8);
  assert.equal(run('service.chatty-calls', f(5)).length, 0);
  assert.equal(run('service.chatty-calls', f(8), { chatty_per_request: 10 }).length, 0);
});

test('high-fan-out-orchestrator: p95 at or above six', () => {
  const out = run('service.high-fan-out-orchestrator', [svc('gw', { fan_out_p95: 6 }), svc('ok', { fan_out_p95: 5 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].measurements['service.fan_out_p95'], 6);
});

test('nanoservice: tiny service among several; not when big, busy or alone', () => {
  const base = (spans) => [
    svc('tiny', { code_root: 'services/tiny', span_count: spans }), svc('big', { code_root: 'services/big' }), svc('mid', { code_root: 'services/mid' }),
    mod('services/tiny/main.ts'),
    ...['a', 'b', 'c', 'd', 'e'].flatMap((x) => [mod(`services/big/${x}.ts`), mod(`services/mid/${x}.ts`)]),
  ];
  const out = run('service.nanoservice', base(10));
  assert.equal(out.length, 1);
  assert.ok(out[0].factors.evidence <= 0.4, 'low confidence');
  assert.equal(run('service.nanoservice', base(50_000)).length, 0);
  assert.equal(run('service.nanoservice', base(10).slice(0, 1).concat(mod('services/tiny/main.ts'))).length, 0, 'a lone service is not a nanoservice');
  const withEndpoints = [...base(10), N('endpoint', 'GET /a'), N('endpoint', 'GET /b'),
    E('EXPOSES', 'module:services/tiny/main.ts', 'endpoint:GET /a'), E('EXPOSES', 'module:services/tiny/main.ts', 'endpoint:GET /b')];
  assert.equal(run('service.nanoservice', withEndpoints).length, 0);
});

test('shared-database: writers from two roots, not one root, not tests', () => {
  const f = (paths) => [
    N('table', 'public.orders'),
    ...paths.flatMap((p) => [mod(p), E('MUTATES', `module:${p}`, 'table:public.orders', { line: 3 })]),
  ];
  const out = run('service.shared-database', f(['services/orders/a.ts', 'services/billing/b.ts']));
  assert.equal(out.length, 1);
  assert.equal(out[0].measurements['table.writers'], 2);
  assert.equal(run('service.shared-database', f(['services/orders/a.ts', 'services/orders/b.ts'])).length, 0);
  assert.equal(run('service.shared-database', f(['services/orders/a.ts', 'services/billing/b.test.ts'])).length, 0);
  assert.equal(run('service.shared-database', f(['services/orders/a.ts', 'services/billing/migrations/001.ts'])).length, 0);
});

test('shared-database: runtime service writers map onto their code root', () => {
  const f = [
    svc('orders', { code_root: 'services/orders' }), svc('billing', { code_root: 'services/billing' }), N('table', 'public.invoices'),
    mod('services/orders/x.ts'),
    E('MUTATES', 'service:billing', 'table:public.invoices', { calls: 5 }),
    E('MUTATES', 'module:services/orders/x.ts', 'table:public.invoices', { line: 1 }),
  ];
  assert.equal(run('service.shared-database', f).length, 1);
  const same = [...f.slice(0, 5), E('MUTATES', 'service:orders', 'table:public.invoices', { calls: 5 })];
  assert.equal(run('service.shared-database', same.filter((x) => !(x.type === 'MUTATES' && x.from === 'service:billing'))).length, 0, 'service and its own module are one writer');
});

test('duplicate-capability: same route in two roots; not health routes, not one root', () => {
  const f = (route, a, b) => [N('endpoint', route), mod(a), mod(b), E('EXPOSES', `module:${a}`, `endpoint:${route}`), E('EXPOSES', `module:${b}`, `endpoint:${route}`)];
  assert.equal(run('service.duplicate-capability', f('GET /orders', 'services/a/r.ts', 'services/b/r.ts')).length, 1);
  assert.equal(run('service.duplicate-capability', f('GET /orders', 'services/a/r.ts', 'services/a/q.ts')).length, 0);
  assert.equal(run('service.duplicate-capability', f('GET /healthz', 'services/a/r.ts', 'services/b/r.ts')).length, 0);
});

const chan = (n, subs, pubs, attrs = {}) => [
  N('topic', 'orders', attrs),
  ...Array.from({ length: pubs }, (_, i) => [mod(`services/p${i}/pub.ts`), E('PUBLISHES', `module:services/p${i}/pub.ts`, 'topic:orders')]).flat(),
  ...Array.from({ length: subs }, (_, i) => [mod(`services/s${i}/sub.ts`), E('SUBSCRIBES', `module:services/s${i}/sub.ts`, 'topic:orders')]).flat(),
  ...n,
];

test('event-soup: many publishers or subscribers, but not a normal fan-out', () => {
  assert.equal(run('service.event-soup', chan([], 1, 3)).length, 1);
  assert.equal(run('service.event-soup', chan([], 5, 1)).length, 1);
  assert.equal(run('service.event-soup', chan([], 4, 2)).length, 0);
});

test('event-soup: subscribers without a contract only when other channels have contracts', () => {
  const other = [N('topic', 'payments', { from_contract: true })];
  assert.equal(run('service.event-soup', chan(other, 2, 1)).length, 1);
  assert.equal(run('service.event-soup', chan([], 2, 1)).length, 0);
  assert.equal(run('service.event-soup', chan(other, 2, 1, { from_contract: true })).length, 0);
});

test('undocumented-endpoints: grouped by root; none when documented', () => {
  const f = [N('endpoint', 'GET /a', { undocumented: true }), N('endpoint', 'GET /b', { undocumented: true }), N('endpoint', 'GET /c', { contract: 'api.yaml' }),
    mod('services/a/r.ts'), E('EXPOSES', 'module:services/a/r.ts', 'endpoint:GET /a'), E('EXPOSES', 'module:services/a/r.ts', 'endpoint:GET /b')];
  const out = run('service.undocumented-endpoints', f);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 2);
  assert.equal(run('service.undocumented-endpoints', [N('endpoint', 'GET /c', { contract: 'api.yaml' })]).length, 0);
});

test('obsolete-compat-path: deprecated and implemented; stronger with zero observed calls', () => {
  const dep = [N('endpoint', 'GET /v1/old', { deprecated: true, contract: 'api.yaml' }), mod('src/old.ts'), E('EXPOSES', 'module:src/old.ts', 'endpoint:GET /v1/old')];
  const noRuntime = run('service.obsolete-compat-path', dep);
  assert.equal(noRuntime.length, 1);
  const live = [...dep, svc('api'), N('endpoint', 'GET /v1/new'), E('EXPOSES', 'service:api', 'endpoint:GET /v1/new', { calls: 50 })];
  const unused = run('service.obsolete-compat-path', live);
  assert.match(unused[0].title, /no traffic/);
  assert.ok(unused[0].factors.evidence > noRuntime[0].factors.evidence);
  const used = run('service.obsolete-compat-path', [...live, E('EXPOSES', 'service:api', 'endpoint:GET /v1/old', { calls: 9 })]);
  assert.ok(used[0].factors.evidence < unused[0].factors.evidence);
});

test('obsolete-compat-path: deprecated contract entry with no implementation is not a finding', () => {
  assert.equal(run('service.obsolete-compat-path', [N('endpoint', 'GET /gone', { deprecated: true, unimplemented: true })]).length, 0);
  assert.equal(run('service.obsolete-compat-path', [N('endpoint', 'GET /x', {}), mod('a.ts'), E('EXPOSES', 'module:a.ts', 'endpoint:GET /x')]).length, 0);
});

test('missing-idempotency: consumer without idempotency names; not with them', () => {
  const base = [mod('src/worker.ts'), N('queue', 'jobs'), E('SUBSCRIBES', 'module:src/worker.ts', 'queue:jobs')];
  const out = run('service.missing-idempotency', base);
  assert.equal(out.length, 1);
  assert.ok(out[0].factors.evidence <= 0.35, 'inference is low confidence');
  const withFn = [...base, N('function', 'src/worker.ts#dedupeMessage', {}, { name: 'dedupeMessage', path: 'src/worker.ts' }),
    E('CONTAINS', 'module:src/worker.ts', 'function:src/worker.ts#dedupeMessage')];
  assert.equal(run('service.missing-idempotency', withFn).length, 0);
  assert.equal(run('service.missing-idempotency', [mod('src/idempotent-handler.ts'), N('queue', 'jobs'), E('SUBSCRIBES', 'module:src/idempotent-handler.ts', 'queue:jobs')]).length, 0);
  assert.equal(run('service.missing-idempotency', [mod('src/a.test.ts', { is_test: true }), N('queue', 'jobs'), E('SUBSCRIBES', 'module:src/a.test.ts', 'queue:jobs')]).length, 0);
});

// ---------------------------------------------------------------- delivery

test('lockstep-deployables: groups co_deployed_with; none for independent deployables', () => {
  const out = run('delivery.lockstep-deployables', [N('deployable', 'api', { co_deployed_with: ['web', 'worker'] }), N('deployable', 'web', { co_deployed_with: ['api'] }), N('deployable', 'worker', { co_deployed_with: ['api'] })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].measurements['service.count'], 3);
  assert.equal(run('delivery.lockstep-deployables', [N('deployable', 'api', { inferred: true })]).length, 0);
});

test('duplicated-pipelines: duplicate_of only', () => {
  const wf = (attrs) => N('workflow', '.github/workflows/b.yml', attrs, { path: '.github/workflows/b.yml' });
  const out = run('delivery.duplicated-pipelines', [wf({ duplicate_of: 'workflow:.github/workflows/a.yml', duplicate_similarity: 0.9 })]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].scope, ['.github/workflows/a.yml', '.github/workflows/b.yml']);
  assert.equal(run('delivery.duplicated-pipelines', [wf({ duplicated_by: ['x'] })]).length, 0);
});

test('missing-health-checks: workloads and compose services', () => {
  const c = (probes) => [{ name: 'app', image: 'app:1', probes }];
  const wl = (kind, probes, name = 'api') => N('workload', `prod/${kind}/${name}`, { kind, containers: c(probes) }, { name, path: 'k8s/api.yaml' });
  const none = { liveness: false, readiness: false, startup: false };
  assert.equal(run('delivery.missing-health-checks', [wl('Deployment', none)]).length, 1);
  assert.equal(run('delivery.missing-health-checks', [wl('Deployment', { ...none, readiness: true })]).length, 0);
  assert.equal(run('delivery.missing-health-checks', [wl('Job', none)]).length, 0);
  const compose = (healthcheck, built) => [N('service', 'compose/web', { runtime: 'compose', deployable: true, healthcheck, built_image: built ?? null }, { name: 'web', path: 'docker-compose.yml' })];
  assert.equal(run('delivery.missing-health-checks', compose(false)).length, 1);
  assert.equal(run('delivery.missing-health-checks', compose(true)).length, 0);
  assert.equal(run('delivery.missing-health-checks', [...compose(false, 'image:web/Dockerfile'), N('image', 'web/Dockerfile', { kind: 'Dockerfile', healthcheck: true })]).length, 0, 'Dockerfile HEALTHCHECK counts');
});

test('missing-rollback-path: deploy job without any rollback hint; low confidence', () => {
  const wfId = 'workflow:.github/workflows/d.yml';
  const f = (extra = []) => [
    N('workflow', '.github/workflows/d.yml', { step_signatures: ['run:kubectl apply -f k8s'] }, { name: 'Deploy', path: '.github/workflows/d.yml' }),
    N('job', '.github/workflows/d.yml#deploy', { workflow: wfId, deploy_signal: true, deploys: ['api'] }, { name: 'deploy', path: '.github/workflows/d.yml' }),
    E('CONTAINS', wfId, 'job:.github/workflows/d.yml#deploy'),
    ...extra,
  ];
  const out = run('delivery.missing-rollback-path', f());
  assert.equal(out.length, 1);
  assert.ok(out[0].factors.evidence <= 0.35);
  const withRollback = f([N('job', '.github/workflows/d.yml#rollback', { workflow: wfId }, { name: 'rollback', path: '.github/workflows/d.yml' }), E('CONTAINS', wfId, 'job:.github/workflows/d.yml#rollback')]);
  assert.equal(run('delivery.missing-rollback-path', withRollback).length, 0);
  const canary = f(); canary[0].attrs.step_signatures.push('uses:argoproj/argo-rollouts');
  assert.equal(run('delivery.missing-rollback-path', canary).length, 0);
  assert.equal(run('delivery.missing-rollback-path', [N('job', 'x#test', { deploy_signal: false })]).length, 0);
});

test('unused-feature-flags: archived, or unreferenced only when references were scanned', () => {
  const flag = (key, attrs = {}) => N('feature_flag', key, attrs, { name: key, path: 'flags.json' });
  assert.equal(run('delivery.unused-feature-flags', [flag('old', { archived: true })]).length, 1);
  assert.equal(run('delivery.unused-feature-flags', [flag('dead'), mod('a.ts', { flags: [] })]).length, 1);
  assert.equal(run('delivery.unused-feature-flags', [flag('dead')]).length, 0, 'unscanned: cannot tell');
  assert.equal(run('delivery.unused-feature-flags', [flag('live', { reference_count: 2, referenced_in: ['a.ts'] })]).length, 0);
});

test('broad-ci-permissions: write-all or missing; not when restricted', () => {
  const wf = (attrs) => [N('workflow', '.github/workflows/a.yml', attrs, { path: '.github/workflows/a.yml' })];
  assert.equal(run('delivery.broad-ci-permissions', wf({ permissions_broad: true })).length, 1);
  assert.equal(run('delivery.broad-ci-permissions', wf({ permissions_broad: true, permissions: 'write-all' }))[0].title.includes('write-all'), true);
  assert.equal(run('delivery.broad-ci-permissions', wf({ permissions: { contents: 'read' } })).length, 0);
  assert.equal(run('delivery.broad-ci-permissions', wf({ permissions_broad: false })).length, 0);
});

// ---------------------------------------------------------------- security

const AWS = `AKIA${'IOSFODNN7EXAMPLE'}`;
const PRIVATE = `-----BEGIN ${'RSA'} PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefakefake\n-----END RSA PRIVATE KEY-----`;

test('secret-exposure: kind and location only, never the value', () => {
  const facts = adapter.extract({ path: 'conf/prod.env', size: 100, kind: 'config' }, `x=1\ny=${AWS}\n${PRIVATE}\n`);
  const out = run('security.secret-exposure', facts);
  assert.equal(out.length, 1);
  const json = JSON.stringify(out);
  assert.ok(!json.includes(AWS) && !json.includes('IOSFODNN7') && !json.includes('MIIEowIBAAK'));
  assert.match(out[0].title, /conf\/prod\.env:2/);
  assert.match(out[0].title, /aws-access-key-id/);
  assert.equal(run('security.secret-exposure', [N('file', 'a.txt', {}, { path: 'a.txt' })]).length, 0);
});

const sig = (kind, line = 3) => ({ kind, line, detail: kind });

test('unsafe-command-construction: shell signals; not in tests; not other kinds', () => {
  const m = (path, signals, attrs = {}) => mod(path, { security_signals: signals, ...attrs });
  const out = run('security.unsafe-command-construction', [m('src/run.js', [sig('spawn-shell'), sig('exec-nonliteral', 9)])]);
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.length, 2);
  assert.equal(run('security.unsafe-command-construction', [m('src/run.js', [sig('eval')])]).length, 0);
  assert.equal(run('security.unsafe-command-construction', [m('tests/run.test.js', [sig('spawn-shell')])]).length, 0);
  assert.equal(run('security.unsafe-command-construction', [m('src/ok.js', [])]).length, 0);
  assert.equal(run('security.unsafe-command-construction', [m('src/p.py', [sig('shell_true')])]).length, 1);
});

test('injection-risk and unsafe-deserialization split signals by class', () => {
  const m = mod('app/x.py', { security_signals: [sig('sql_injection'), sig('pickle_load'), sig('yaml_unsafe_load', 8)] });
  assert.equal(run('security.injection-risk', [m]).length, 1);
  const d = run('security.unsafe-deserialization', [m]);
  assert.equal(d.length, 1);
  assert.equal(d[0].evidence.length, 2);
  assert.equal(run('security.unsafe-deserialization', [mod('app/y.py', { security_signals: [sig('eval')] })]).length, 0);
});

test('privilege-sprawl: k8s wildcard and bound cluster-admin; not narrow or unbound built-ins', () => {
  const role = (name, attrs) => N('role', `prod/${name}`, { kind: 'Role', ...attrs }, { name, path: `k8s/${name}.yaml` });
  const wild = run('security.privilege-sprawl', [role('god', { wildcard_verbs: true, wildcard_resources: true })]);
  assert.equal(wild.length, 1);
  assert.equal(wild[0].measurements['iam.wildcards'], 2);
  assert.equal(run('security.privilege-sprawl', [role('reader', { wildcard_verbs: false, wildcard_resources: false, secrets_read: false })]).length, 0);
  const builtin = N('role', '_cluster/cluster-admin', { kind: 'ClusterRole', builtin: true, cluster_admin: true }, { name: 'cluster-admin' });
  assert.equal(run('security.privilege-sprawl', [builtin]).length, 0);
  const bound = run('security.privilege-sprawl', [builtin, N('service_account', 'prod/ci', {}, { name: 'ci' }), E('ASSUMES', 'service_account:prod/ci', 'role:_cluster/cluster-admin')]);
  assert.equal(bound.length, 1);
  assert.match(bound[0].title, /ci/);
});

test('privilege-sprawl: IaC policies with wildcard actions or admin', () => {
  const pol = (attrs) => N('policy', 'aws_iam_policy.p', attrs, { name: 'aws_iam_policy.p', path: 'iam.tf' });
  const out = run('security.privilege-sprawl', [pol({ wildcard_actions: ['s3:*'], admin: false })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].measurements['iam.wildcards'], 1);
  assert.equal(run('security.privilege-sprawl', [pol({ wildcard_actions: [], admin: false })]).length, 0);
  assert.equal(run('security.privilege-sprawl', [pol({ wildcard_actions: [], admin: true })]).length, 1);
});

test('unpinned-build-inputs: CI references, Dockerfiles, workloads and IaC', () => {
  const wf = N('workflow', '.github/workflows/ci.yml', {}, { path: '.github/workflows/ci.yml' });
  const dep = (name, pinned) => [N('dependency', `gha:${name}`, { ecosystem: 'github-actions', pinned }, { name: `gha:${name}` }),
    E('DEPENDS_ON', 'workflow:.github/workflows/ci.yml', `dependency:gha:${name}`, { ref: pinned ? 'a'.repeat(40) : 'v4', pinned })];
  const out = run('security.unpinned-build-inputs', [wf, ...dep('actions/checkout', false), ...dep('actions/cache', false), ...dep('actions/setup-node', true)]);
  assert.equal(out.length, 1, 'one finding per workflow');
  assert.equal(out[0].evidence.length, 2);
  assert.equal(run('security.unpinned-build-inputs', [wf, ...dep('actions/checkout', true)]).length, 0);

  const docker = N('image', 'svc/Dockerfile', { kind: 'Dockerfile', unpinned_bases: 1, latest_bases: ['node'] }, { path: 'svc/Dockerfile' });
  assert.equal(run('security.unpinned-build-inputs', [docker]).length, 1);
  assert.equal(run('security.unpinned-build-inputs', [N('image', 'svc/Dockerfile', { kind: 'Dockerfile', unpinned_bases: 0 })]).length, 0);

  const wl = (pinned) => N('workload', 'p/Deployment/a', { kind: 'Deployment', containers: [{ name: 'a', image: 'a:latest', image_pinned: pinned, image_tag_latest: !pinned }] }, { name: 'a', path: 'k8s/a.yaml' });
  assert.equal(run('security.unpinned-build-inputs', [wl(false)]).length, 1);
  assert.equal(run('security.unpinned-build-inputs', [wl(true)]).length, 0);

  const tf = [N('iac_module', 'terraform-aws-modules/vpc/aws', { remote: true, pinned: 'unpinned' }), N('dependency', 'tf/aws', { kind: 'provider', provider: 'aws', pinned: 'unpinned' }),
    N('iac_module', 'git::x?ref=v1', { remote: true, pinned: 'ref' })];
  assert.equal(run('security.unpinned-build-inputs', tf).length, 2);
});

test('dangerous-ci-trigger: only the pull_request_target + PR head pattern', () => {
  const wf = (attrs) => [N('workflow', '.github/workflows/pr.yml', attrs, { path: '.github/workflows/pr.yml' })];
  assert.equal(run('security.dangerous-ci-trigger', wf({ triggers: ['pull_request_target'], dangerous_patterns: ['pull_request_target_checkout_pr_head'] })).length, 1);
  assert.equal(run('security.dangerous-ci-trigger', wf({ triggers: ['pull_request_target'] })).length, 0);
  assert.equal(run('security.dangerous-ci-trigger', wf({ triggers: ['pull_request'] })).length, 0);
});

test('duplicated-authorization: the same check in three modules outside an auth package', () => {
  const file = (path, ...shapes) => N('file', path, { authz_checks: shapes.map((shape, i) => ({ shape, line: i + 1 })) }, { path });
  const three = [file('src/a.ts', "hasrole('admin')"), file('src/b.ts', "hasrole('admin')"), file('src/c.ts', "hasrole('admin')", "can('x')")];
  const out = run('security.duplicated-authorization', three);
  assert.equal(out.length, 1);
  assert.ok(out[0].factors.evidence <= 0.5);
  assert.equal(run('security.duplicated-authorization', three.slice(0, 2)).length, 0);
  assert.equal(run('security.duplicated-authorization', [...three.slice(0, 2), file('src/auth/policy.ts', "hasrole('admin')")]).length, 0, 'auth package is the right home');
  assert.equal(run('security.duplicated-authorization', [file('src/a.ts', "hasrole('admin')"), file('src/b.ts', "hasrole('editor')"), file('src/c.ts', "can('x')")]).length, 0, 'different checks are not duplicates');
  const fn = (path, name) => N('function', `${path}#${name}`, {}, { name, path });
  assert.equal(run('security.duplicated-authorization', [fn('src/a.ts', 'isAdmin'), fn('src/b.ts', 'checkPermission'), fn('src/c.ts', 'canAccess')]).length, 0, 'names alone are not evidence');
});

test('scanner-findings: from the security adapter attrs', () => {
  const f = N('file', 'src/a.js', { scanner_findings: [{ tool: 'semgrep', rule: 'r.eval', severity: 'error', line: 3 }] }, { path: 'src/a.js' });
  const out = run('security.scanner-findings', [f]);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /semgrep/);
  assert.equal(run('security.scanner-findings', [N('file', 'src/b.js', { scanner_findings: [] }, { path: 'src/b.js' })]).length, 0);
});

// ---------------------------------------------------------------- end to end

function bigGraph() {
  const wfPath = '.github/workflows/pr.yml';
  return Graph.fromFacts([
    ...twoServices().map((f) => (f.id === 'service:orders' ? { ...f, attrs: { ...f.attrs, call_cycles: [{ path: 'orders>billing>orders', traces: 3 }], fan_out_p95: 7 } } : f)),
    mod('services/orders/db.ts', { security_signals: [sig('spawn-shell'), sig('sql-interpolation', 7), sig('pickle_load', 9)] }),
    mod('services/billing/db.ts'),
    N('table', 'public.orders'),
    E('MUTATES', 'module:services/orders/db.ts', 'table:public.orders', { line: 4 }),
    E('MUTATES', 'module:services/billing/db.ts', 'table:public.orders', { line: 9 }),
    E('RUNTIME_CALLS', 'service:orders', 'service:billing', { per_request_p95: 9, traces: 30 }),
    N('workflow', wfPath, { permissions_broad: true, triggers: ['pull_request_target'], dangerous_patterns: ['pull_request_target_checkout_pr_head'] }, { path: wfPath }),
    N('dependency', 'gha:actions/checkout', { ecosystem: 'github-actions', pinned: false }),
    E('DEPENDS_ON', `workflow:${wfPath}`, 'dependency:gha:actions/checkout', { ref: 'v4', pinned: false }),
    N('role', 'prod/god', { kind: 'Role', wildcard_verbs: true, wildcard_resources: true }, { name: 'god', path: 'k8s/god.yaml' }),
    ...adapter.extract({ path: 'conf/prod.env', size: 50, kind: 'config' }, `key=${AWS}\n`),
    N('workload', 'p/Deployment/api', { kind: 'Deployment', containers: [{ name: 'api', image: 'api:latest', image_pinned: false, image_tag_latest: true, probes: { liveness: false, readiness: false, startup: false } }] }, { name: 'api', path: 'k8s/api.yaml' }),
  ]);
}

test('diagnose runs all three categories end to end with zero errors and no secret echo', async () => {
  const ctx = openProject(PROJECT, { create: true });
  const config = { approvals: { low: [], medium: [], high: ['owner'], critical: ['owner'], critical_min_approvers: 2 } };
  const res = await diagnose(ctx, { config, graph: bigGraph(), only: ['service', 'delivery', 'security'] });
  assert.deepEqual(res.errors, []);
  const kinds = new Set(res.findings.map((f) => f.kind));
  for (const k of [
    'service.distributed-monolith', 'service.chatty-calls', 'service.high-fan-out-orchestrator', 'service.shared-database',
    'delivery.missing-health-checks', 'delivery.broad-ci-permissions',
    'security.secret-exposure', 'security.unsafe-command-construction', 'security.injection-risk', 'security.unsafe-deserialization',
    'security.privilege-sprawl', 'security.unpinned-build-inputs', 'security.dangerous-ci-trigger',
  ]) assert.ok(kinds.has(k), `expected ${k}; got ${[...kinds].join(', ')}`);
  const json = JSON.stringify(res.findings);
  assert.ok(!json.includes(AWS));
  assert.ok(!json.includes('IOSFODNN7'));
  for (const f of res.findings) {
    assert.ok(f.alternatives.some((a) => a.id === 'retain'));
  }
  const known = res.findings.flatMap((f) => f.patterns).filter((p) => p.fit === 'not_evaluated');
  assert.deepEqual(known, [], 'all referenced pattern cards exist');
  ctx.store.close?.();
});

test('security findings never propose removing a control', () => {
  const g = bigGraph();
  for (const d of security) {
    for (const draft of d.detect({ graph: g, options: {}, config: {}, scope: [] })) {
      assert.ok(!/^\s*(remove|delete|disable|drop|turn off)\b/i.test(draft.smallest_simplification), `${draft.kind}: ${draft.smallest_simplification}`);
      for (const a of draft.alternatives) {
        assert.ok(!/(^|-)(remove|delete|disable|drop)(-|$)/i.test(a.id), `${draft.kind}: alternative ${a.id}`);
        assert.ok(!/^\s*(remove|delete|disable|drop)\b/i.test(a.summary), `${draft.kind}: ${a.summary}`);
      }
      assert.ok(draft.alternatives.some((a) => a.id === 'retain'));
      assert.equal(draft.quality_impacts.security, 'high');
    }
  }
});

test('detectors report no findings on an empty-ish graph', () => {
  const g = Graph.fromFacts([mod('src/a.ts'), mod('src/b.ts')]);
  for (const d of all) assert.deepEqual(d.detect({ graph: g, options: {}, config: {}, scope: [] }), [], d.id);
});

test('missing-rollback-path: a backup/restore drill that deploys nothing is not a deploy job', () => {
  const wfId = 'workflow:.github/workflows/drill.yml';
  const g = (deploy_step) => [
    N('workflow', '.github/workflows/drill.yml', { step_signatures: ['run:python manage.py migrate'] }, { name: 'Restore drill', path: '.github/workflows/drill.yml' }),
    N('job', '.github/workflows/drill.yml#restore', { workflow: wfId, deploy_signal: true, deploys: ['restore'], deploy_step }, { name: 'restore', path: '.github/workflows/drill.yml' }),
    E('CONTAINS', wfId, 'job:.github/workflows/drill.yml#restore'),
  ];
  assert.equal(run('delivery.missing-rollback-path', g(false)).length, 0);
  assert.equal(run('delivery.missing-rollback-path', g(true)).length, 1);
});
