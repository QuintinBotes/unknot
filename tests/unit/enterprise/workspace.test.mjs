import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../../runtime/context.mjs');
const { loadConfig } = await import('../../../runtime/policy/config.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { edgeFact, nodeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { stringifyYAML } = await import('../../../runtime/core/yaml.mjs');
const { buildWorkspaceGraph, graphFromDocument, listWorkspace, loadWorkspaceGraph, mapWorkspace, planWorkspaceCampaign, qualify, resolveRepositories, summarizeWorkspace, unqualify } = await import('../../../runtime/enterprise/workspace.mjs');
const { catalogSummary } = await import('../../../runtime/enterprise/catalog.mjs');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

function repo(parent, name, files) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const P = prov({ source_type: 'config', extractor: 'test@1' });
const node = (type, key, attrs = {}) => nodeFact(type, key, { name: key, attrs }, P);
const edge = (type, a, b) => edgeFact(type, a, b, {}, P);

test('cross-repository inference on explicit graphs: packages, contracts, topics, shared tables', () => {
  const lib = Graph.fromFacts([
    node('package', 'shared-lib', { name: 'shared-lib' }),
    node('module', 'src/pub.ts'),
    node('topic', 'orders.created'),
    edge('PUBLISHES', 'module:src/pub.ts', 'topic:orders.created'),
    node('endpoint', 'GET /users'),
    edge('EXPOSES', 'module:src/pub.ts', 'endpoint:GET /users'),
    node('table', 'public.orders', { name: 'orders' }),
    edge('MUTATES', 'module:src/pub.ts', 'table:public.orders'),
    edge('OWNS_DATA', 'module:src/pub.ts', 'table:public.orders'),
  ]);
  const app = Graph.fromFacts([
    node('package', 'app', { name: 'app' }),
    node('module', 'src/sub.ts'),
    node('dependency', 'shared-lib'),
    edge('DEPENDS_ON', 'package:app', 'dependency:shared-lib'),
    node('topic', 'orders.created'),
    edge('SUBSCRIBES', 'module:src/sub.ts', 'topic:orders.created'),
    node('endpoint', 'GET /users'),
    edge('CALLS', 'module:src/sub.ts', 'endpoint:GET /users'),
    node('table', 'orders'),
    edge('QUERIES', 'module:src/sub.ts', 'table:orders'),
    node('table', 'private_only'),
    edge('QUERIES', 'module:src/sub.ts', 'table:private_only'),
  ]);
  const { graph, analysis } = buildWorkspaceGraph(new Map([['lib', lib], ['app', app]]));

  assert.ok(graph.node('module:lib:src/pub.ts'));
  assert.deepEqual(unqualify('module:lib:src/pub.ts'), { type: 'module', repo: 'lib', local: 'module:src/pub.ts' });
  assert.equal(qualify('lib', 'table:public.orders'), 'table:lib:public.orders');

  const has = (type, from, to) => graph.edges(type).some((e) => e.from === from && e.to === to && e.attrs.cross_repo);
  assert.ok(has('DEPENDS_ON', 'package:app:app', 'package:lib:shared-lib'), 'package dependency');
  assert.ok(has('CONSUMES', 'module:app:src/sub.ts', 'endpoint:lib:GET /users'), 'contract consumer');
  assert.ok(has('SUBSCRIBES', 'module:app:src/sub.ts', 'topic:lib:orders.created'), 'topic subscriber');
  assert.ok(has('QUERIES', 'module:app:src/sub.ts', 'table:lib:public.orders'), 'shared table access');

  assert.deepEqual(analysis.cross_repo_edges.by_via, { contract: 1, package: 1, shared_table: 1, topic: 1 });
  assert.equal(analysis.shared_database, true);
  assert.equal(analysis.shared_tables.length, 1);
  assert.equal(analysis.shared_tables[0].owner_repo, 'lib');
  assert.deepEqual(analysis.shared_tables[0].repos.map((r) => r.repo), ['app', 'lib']);
  assert.ok(analysis.release_coupling.some((h) => h.kind === 'ordered' && h.via === 'package' && h.before === 'lib' && h.after === 'app'));
  assert.ok(analysis.release_coupling.some((h) => h.kind === 'lockstep' && h.via === 'shared_table'));
  assert.deepEqual(analysis.repo_dependencies.map((d) => `${d.from}->${d.to}`), ['app->lib']);

  // The serialised form round-trips into a graph the catalog code can read.
  const back = graphFromDocument({ nodes: graph.nodes(), edges: graph.edges() });
  assert.equal(back.size.nodes, graph.size.nodes);
});

test('no inference between unrelated repositories', () => {
  const a = Graph.fromFacts([node('package', 'one', { name: 'one' }), node('table', 'x'), node('module', 'm'), edge('QUERIES', 'module:m', 'table:x')]);
  const b = Graph.fromFacts([node('package', 'two', { name: 'two' })]);
  const { analysis } = buildWorkspaceGraph(new Map([['a', a], ['b', b]]));
  assert.equal(analysis.cross_repo_edges.total, 0);
  assert.equal(analysis.shared_database, false);
});

test('workspace of two real git repositories: map, store, summarise, campaign', { timeout: 120_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'uk-ws-'));
  repo(parent, 'lib', {
    'package.json': JSON.stringify({ name: 'shared-lib', version: '1.0.0' }),
    'src/pub.mjs': "export async function publish(producer) {\n  await producer.send({ topic: 'orders.created', messages: [] });\n}\n",
  });
  repo(parent, 'app', {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'shared-lib': '^1.0.0' } }),
    'src/sub.mjs': "export async function run(consumer) {\n  await consumer.subscribe({ topic: 'orders.created' });\n}\n",
  });
  const root = repo(parent, 'platform', { 'README.md': 'workspace root\n' });
  mkdirSync(join(root, '.unknot'));
  writeFileSync(join(root, '.unknot/config.yaml'), stringifyYAML({
    version: 1,
    mode: 'plan',
    workspace: { repositories: [{ name: 'lib', path: '../lib' }, { name: 'app', path: '../app', remote: 'git@example.com:org/app.git' }] },
  }));
  const ctx = openProject(root, { create: true });
  const cfg = loadConfig(ctx);

  // Before mapping, listing shows uninitialised repositories and creates nothing.
  const before = listWorkspace(ctx, cfg.config);
  assert.deepEqual(before.map((r) => [r.name, r.initialized]), [['lib', false], ['app', false]]);

  const r = await mapWorkspace(ctx, { config: cfg.config, history: false });
  assert.equal(r.repositories.length, 2);
  assert.match(r.digest, /^sha256:/);
  const after = listWorkspace(ctx, cfg.config);
  assert.ok(after.every((x) => x.initialized && x.generation >= 1), 'each repository has its own store');

  const doc = loadWorkspaceGraph(ctx);
  const summary = summarizeWorkspace(doc);
  assert.equal(summary.repositories.length, 2);
  assert.ok(summary.cross_repo_edges.by_via.package >= 1, `package edge expected: ${JSON.stringify(summary.cross_repo_edges)}`);
  assert.ok(summary.cross_repo_edges.by_via.topic >= 1, `topic edge expected: ${JSON.stringify(summary.cross_repo_edges)}`);
  assert.ok(summary.release_coupling.some((h) => h.via === 'package' && h.before === 'lib' && h.after === 'app'));
  assert.equal(summary.shared_database, false);
  assert.ok(Array.isArray(summary.catalog.services));

  // Campaign across both repositories: scope is prefixed by repository, sources recorded.
  const { campaign, slices } = planWorkspaceCampaign(ctx, {
    config: cfg.config,
    actor: 'model:main',
    objective: 'Move the order contract to the new schema',
    drafts: [
      { repo: 'lib', objective: 'Publish v2 of the order event alongside v1', sources: ['F-0001'], scope: { include: ['src/**'] } },
      { repo: 'app', objective: 'Subscribe to the v2 order event', scope: { include: ['src/**'] } },
    ],
  });
  assert.equal(campaign.slices.length, 2);
  assert.deepEqual(slices[0].scope.include, ['lib/src/**']);
  assert.deepEqual(slices[1].scope.include, ['app/src/**']);
  assert.deepEqual(slices[0].sources, ['F-0001']);
  assert.match(slices[0].rationale, /^\[repo lib\]/);
  assert.deepEqual(slices[1].preconditions, [slices[0].id], 'repo slices are sequenced');
  assert.throws(() => planWorkspaceCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Touch a stranger', drafts: [{ repo: 'nope', objective: 'x', scope: { include: ['a'] } }] }), (e) => e.code === 'UK_CONFIG_INVALID');
  assert.throws(() => planWorkspaceCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Escape the repo', drafts: [{ repo: 'lib', objective: 'x', scope: { include: ['../app/**'] } }] }), (e) => e.code === 'UK_SCOPE_VIOLATION');
});

test('repositories must be git roots, distinct and listed once', () => {
  const parent = mkdtempSync(join(tmpdir(), 'uk-ws2-'));
  repo(parent, 'a', { 'x.txt': '1\n' });
  mkdirSync(join(parent, 'plain'));
  const root = repo(parent, 'root', { 'x.txt': '1\n' });
  mkdirSync(join(root, '.unknot'));
  const ctx = openProject(root, { create: true });
  const cfg = (repositories) => ({ workspace: { repositories } });
  assert.throws(() => resolveRepositories(ctx, cfg([{ name: 'p', path: '../plain' }])), (e) => e.code === 'UK_CONFIG_INVALID');
  assert.throws(() => resolveRepositories(ctx, cfg([{ name: 'gone', path: '../missing' }])), (e) => e.code === 'UK_NOT_FOUND');
  assert.throws(() => resolveRepositories(ctx, cfg([{ name: 'a', path: '../a' }, { name: 'a', path: '../a' }])), (e) => e.code === 'UK_CONFIG_INVALID');
  assert.throws(() => resolveRepositories(ctx, cfg([{ name: 'self', path: '.' }])), (e) => e.code === 'UK_CONFIG_INVALID');
  assert.equal(resolveRepositories(ctx, cfg([{ name: 'a', path: '../a' }]))[0].name, 'a');
});

test('catalogSummary reconciles services with deployables and owners', () => {
  const g = Graph.fromFacts([
    node('service', 'orders', { owner: 'team-a', code_root: 'services/orders' }),
    node('service', 'billing', { owner: 'team-a', code_root: 'services/billing' }),
    node('service', 'ghost', { code_root: 'services/ghost' }),
    node('deployable', 'orders'),
    node('workload', 'prod/Deployment/billing', { path: 'services/billing/k8s/deploy.yaml' }),
    node('module', 'services/orders/index.ts'),
    node('team', 'team-a'),
    node('team', 'team-idle'),
  ]);
  g.nodes('module')[0].path = 'services/orders/index.ts';
  const c = catalogSummary(g);
  assert.deepEqual(c.services.map((s) => [s.name, s.mapped]), [['billing', true], ['ghost', false], ['orders', true]]);
  assert.deepEqual(c.unmapped_code_roots.map((u) => u.service), ['ghost']);
  assert.deepEqual(c.services_without_owner, ['ghost']);
  assert.deepEqual(c.owners_without_services, ['team-idle']);
  assert.equal(c.services.find((s) => s.name === 'orders').code_present, true);
});
