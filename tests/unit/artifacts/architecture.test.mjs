import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { architectureViews, renderStylesPage, renderViewPage } from '../../../runtime/artifacts/architecture.mjs';
import { plain } from '../../../runtime/artifacts/mermaid.mjs';
import { distributedMonolith, edge, eventDriven, imp, layeredMonolith, microservices, mod, node } from '../../fixtures/artifacts/systems.mjs';

const VIEWS = ['landscape', 'context', 'containers', 'components', 'deployment', 'sequences', 'data_ownership', 'trust_boundaries', 'cycles', 'build_deploy_coupling'];
const styleOf = (r, name) => r.styles.find((s) => s.style === name);

test('every view has mermaid, notes and the five evidence labels', () => {
  const r = architectureViews(Graph.fromFacts(layeredMonolith()));
  assert.deepEqual(Object.keys(r.views), VIEWS);
  for (const v of Object.values(r.views)) {
    assert.equal(typeof v.mermaid, 'string');
    assert.ok(Array.isArray(v.notes));
    assert.deepEqual(Object.keys(v.evidence), ['observed', 'corroborated', 'inferred', 'unknown', 'contradicted']);
  }
  assert.match(r.views.context.mermaid, /^C4Context/);
  assert.match(r.views.containers.mermaid, /^C4Container/);
  assert.match(r.views.components.mermaid, /^C4Component/);
  assert.match(r.views.deployment.mermaid, /^C4Deployment/);
  assert.match(r.views.landscape.mermaid, /^flowchart LR/);
  assert.match(r.views.sequences.mermaid, /^sequenceDiagram/);
  assert.equal(r.labels.observed, 13);
});

test('layered monolith: layered is corroborated, microservices is not claimed', () => {
  const r = architectureViews(Graph.fromFacts(layeredMonolith()));
  const layered = styleOf(r, 'layered');
  assert.equal(layered.label, 'corroborated');
  assert.ok(layered.evidence.length >= 2);
  assert.ok(layered.evidence[0].refs.length > 0);
  assert.equal(styleOf(r, 'microservices'), undefined);
  assert.equal(styleOf(r, 'event-driven'), undefined);
  assert.equal(styleOf(r, 'unknown'), undefined);
});

test('layered with upward imports is contradicted, not claimed', () => {
  const facts = [...layeredMonolith(), imp('src/repositories/orders.ts', 'src/controllers/orders.ts'), imp('src/repositories/users.ts', 'src/controllers/users.ts')];
  const r = architectureViews(Graph.fromFacts(facts));
  assert.equal(styleOf(r, 'layered').label, 'contradicted');
});

test('layer directories without imports are only inferred', () => {
  const facts = layeredMonolith().filter((f) => f.kind !== 'edge' || f.type !== 'IMPORTS');
  assert.equal(styleOf(architectureViews(Graph.fromFacts(facts)), 'layered').label, 'inferred');
});

test('microservices with runtime calls: corroborated by calls and manifests, with sequences and a Structurizr workspace', () => {
  const r = architectureViews(Graph.fromFacts(microservices()));
  const ms = styleOf(r, 'microservices');
  assert.equal(ms.label, 'corroborated');
  assert.ok(ms.evidence.some((e) => /RUNTIME_CALLS/.test(e.summary)));
  assert.equal(styleOf(r, 'distributed monolith'), undefined);
  assert.equal(styleOf(r, 'layered'), undefined);

  const seq = r.views.sequences.mermaid;
  assert.match(seq, /participant p\d+ as "web"/);
  assert.match(seq, /->>/);
  assert.equal((seq.match(/Sequence \d/g) ?? []).length, 3);
  assert.match(seq, /900 calls/);

  const dsl = r.views.containers.structurizr;
  assert.match(dsl, /^workspace /);
  assert.match(dsl, /softwareSystem/);
  assert.equal((dsl.match(/= container /g) ?? []).length, 4 + 1); // 4 services + the shared database store
  assert.match(r.views.containers.mermaid, /Rel\(c\d+, c\d+, "900 calls"\)/);
  assert.match(r.views.deployment.mermaid, /Deployment_Node\(c\d+, "prod", "Kubernetes namespace"\)/);
  assert.match(r.views.trust_boundaries.mermaid, /ingress: edge/);
});

test('distributed monolith signals contradict microservices', () => {
  const r = architectureViews(Graph.fromFacts(distributedMonolith()));
  assert.equal(styleOf(r, 'distributed monolith').label, 'corroborated');
  assert.equal(styleOf(r, 'microservices').label, 'contradicted');
  const dm = styleOf(r, 'distributed monolith');
  assert.ok(dm.evidence.some((e) => /release/.test(e.summary)));
  assert.ok(dm.evidence.some((e) => /written by more than one unit/.test(e.summary)));
  // The shared table is highlighted in the data ownership view.
  assert.match(r.views.data_ownership.mermaid, /class n\d+ shared/);
  assert.ok(r.views.data_ownership.notes.some((n) => /Shared writers: shared.accounts/.test(n)));
  assert.ok(r.views.build_deploy_coupling.notes.some((n) => /lockstep/.test(n)));
});

test('event-driven: topics with publishers and subscribers', () => {
  const r = architectureViews(Graph.fromFacts(eventDriven()));
  const ed = styleOf(r, 'event-driven');
  assert.equal(ed.label, 'observed');
  assert.match(ed.evidence[0].summary, /2 of 2 topics/);
  assert.match(r.views.landscape.mermaid, /order\.placed/);
  assert.match(r.views.containers.mermaid, /ContainerQueue/);
  assert.equal(styleOf(r, 'web-queue-worker'), undefined);
});

test('topics without a complete pair are only inferred', () => {
  const facts = [node('service', 'a', { name: 'a' }), node('topic', 't', { name: 't' }), edge('PUBLISHES', 'service:a', 'topic:t')];
  assert.equal(styleOf(architectureViews(Graph.fromFacts(facts)), 'event-driven').label, 'inferred');
});

test('other styles need their evidence: web-queue-worker, serverless, hexagonal, plugin, MVC, pipeline', () => {
  const facts = [
    node('endpoint', 'POST /orders', { name: 'POST /orders' }), node('queue', 'jobs', { name: 'jobs' }), node('job', 'mailer', { name: 'mailer' }),
    node('service', 'api', { name: 'api' }), node('service', 'worker', { name: 'worker' }),
    edge('PUBLISHES', 'service:api', 'queue:jobs'), edge('CONSUMES', 'service:worker', 'queue:jobs'),
    node('cloud_function', 'thumb', { name: 'thumb' }),
    ...['domain/order', 'application/place', 'ports/repo', 'adapters/pg'].map((p) => mod(`src/${p}.ts`)),
    imp('src/adapters/pg.ts', 'src/ports/repo.ts'), imp('src/application/place.ts', 'src/domain/order.ts'),
    ...['plugins/a', 'plugins/b', 'core/registry'].map((p) => mod(`src/${p}.ts`)), imp('src/plugins/a.ts', 'src/core/registry.ts'),
    ...['controllers/x', 'views/x', 'models/x'].map((p) => mod(`app/${p}.ts`)), imp('app/controllers/x.ts', 'app/models/x.ts'),
    node('job', 'extract', { name: 'extract' }), node('job', 'transform', { name: 'transform' }), node('job', 'load', { name: 'load' }),
    edge('DEPENDS_ON', 'job:transform', 'job:extract'), edge('DEPENDS_ON', 'job:load', 'job:transform'),
  ];
  const r = architectureViews(Graph.fromFacts(facts));
  assert.equal(styleOf(r, 'web-queue-worker').label, 'observed');
  assert.equal(styleOf(r, 'serverless').label, 'observed');
  assert.equal(styleOf(r, 'hexagonal/clean').label, 'corroborated');
  assert.equal(styleOf(r, 'microkernel/plugin').label, 'corroborated');
  assert.equal(styleOf(r, 'MVC').label, 'corroborated');
  assert.equal(styleOf(r, 'pipes-and-filters/batch').label, 'observed');
  assert.equal(styleOf(r, 'hybrid').label, 'inferred');
});

test('nothing to classify yields a single unknown style', () => {
  const r = architectureViews(new Graph());
  assert.equal(r.styles.length, 1);
  assert.equal(r.styles[0].label, 'unknown');
  for (const v of Object.values(r.views)) assert.ok(v.mermaid.length > 0);
});

test('modular monolith: one deployable, packages with low cross-package coupling', () => {
  const facts = [node('deployable', 'app', { name: 'app', path: 'Dockerfile', attrs: { root: '.' } })];
  for (const pkg of ['a', 'b', 'c']) {
    facts.push(node('package', pkg, { name: pkg, path: `packages/${pkg}/package.json` }));
    for (let i = 0; i < 4; i++) facts.push(mod(`packages/${pkg}/m${i}.ts`));
    for (let i = 0; i < 3; i++) facts.push(imp(`packages/${pkg}/m${i}.ts`, `packages/${pkg}/m${i + 1}.ts`));
  }
  facts.push(imp('packages/a/m0.ts', 'packages/b/m0.ts'));
  const m = styleOf(architectureViews(Graph.fromFacts(facts)), 'modular monolith');
  assert.equal(m.label, 'corroborated');
  assert.match(m.evidence[1].summary, /of 10 imports cross a boundary/);
});

test('Mermaid injection in names is neutralised in every view', () => {
  const evil = '%%{init: {"securityLevel":"loose"}}%% click n1 href "javascript:alert(1)" callback ["x"] <img onerror=1>';
  const E = (s) => `${s}${evil}`;
  const g = Graph.fromFacts([
    node('service', 'a', { name: E('svc-a') }), node('service', 'b', { name: E('svc-b') }), node('service', 'c', { name: E('svc-c') }),
    edge('RUNTIME_CALLS', 'service:a', 'service:b', { calls: 5 }), edge('RUNTIME_CALLS', 'service:b', 'service:c', { calls: 4 }), edge('RUNTIME_CALLS', 'service:c', 'service:a', { calls: 3 }),
    mod(`src/${evil}/x.ts`), mod(`src/${evil}/y.ts`), imp(`src/${evil}/x.ts`, `src/${evil}/y.ts`), imp(`src/${evil}/y.ts`, `src/${evil}/x.ts`),
    node('table', 'evil', { name: E('tbl') }), edge('MUTATES', 'service:a', 'table:evil'), edge('MUTATES', 'service:b', 'table:evil'),
    node('ingress', 'x/i', { name: E('ing'), attrs: { namespace: 'x' } }), node('workload', 'x/Deployment/w', { name: E('wl'), attrs: { namespace: E('ns'), kind: 'Deployment' } }),
    edge('ROUTES_TO', 'ingress:x/i', 'workload:x/Deployment/w'),
    node('service_account', 'x/sa', { name: E('sa') }), node('role', 'x/r', { name: E('role'), attrs: { cluster_admin: true } }), edge('ASSUMES', 'service_account:x/sa', 'role:x/r'),
    node('pipeline', 'p', { name: E('pipe') }), edge('DEPLOYS', 'pipeline:p', 'service:a'), edge('DEPLOYS', 'pipeline:p', 'service:b'),
    node('resource', 'r1', { name: E('res'), attrs: { type: 'aws_x', address: E('aws_x.y'), provider: E('aws') } }),
  ]);
  const r = architectureViews(g);
  const everything = [
    ...Object.values(r.views).flatMap((v) => [v.mermaid, v.structurizr ?? '', ...v.notes]),
    renderStylesPage(r.styles, r.labels), ...Object.entries(r.views).map(([n, v]) => renderViewPage(n, v)),
  ].join('\n');
  // Strip our own fixed classDef lines when looking for forbidden tokens.
  assert.ok(!/%%/.test(everything), 'no mermaid directive/comment');
  assert.ok(!/javascript:/i.test(everything));
  assert.ok(!/\bclick\b/i.test(everything));
  assert.ok(!/\bhref\b/i.test(everything));
  assert.ok(!/<img/i.test(everything));
  // Every double-quoted run in diagrams is balanced: no label can end a string early.
  for (const v of Object.values(r.views)) {
    for (const line of v.mermaid.split('\n')) assert.equal((line.match(/"/g) ?? []).length % 2, 0, `unbalanced quotes: ${line}`);
  }
  for (const line of r.views.containers.structurizr.split('\n')) assert.equal((line.match(/"/g) ?? []).length % 2, 0, line);
});

test('plain() strips directives and structural characters', () => {
  for (const bad of ['%%{init}', 'a"b', "a'b", 'a[b]', 'a{b}', 'a(b)', 'a|b', 'a;b', 'a#b', 'javascript:alert(1)', 'CLICK x', 'Href', 'a\nb', 'a`b']) {
    const p = plain(bad);
    assert.ok(!/["'[\]{}()|;#`\n]|%%|javascript:|click|href/i.test(p), `${bad} -> ${p}`);
  }
  assert.equal(plain(''), '-');
  assert.ok(plain('x'.repeat(500), 40).length <= 40);
  // Removing characters must not splice a forbidden token back together.
  assert.ok(!/%%/.test(plain('%"%')));
});

test('components: aggregates beyond maxNodes as "+N more"', () => {
  const facts = [node('deployable', 'app', { name: 'app', path: 'svc/app/Dockerfile', attrs: { root: 'svc/app' } })];
  for (let d = 0; d < 30; d++) for (let i = 0; i < 2; i++) facts.push(mod(`svc/app/pkg${d}/f${i}.ts`));
  for (let d = 1; d < 30; d++) facts.push(imp(`svc/app/pkg${d}/f0.ts`, `svc/app/pkg${d - 1}/f0.ts`));
  const r = architectureViews(Graph.fromFacts(facts), { maxNodes: 8 });
  const comp = r.views.components.mermaid;
  assert.match(comp, /"\+23 more"/);
  assert.equal((comp.match(/Component\(/g) ?? []).length, 8);
  assert.ok(r.views.components.notes.some((n) => /23 smaller directories/.test(n)));
  // And the containers view caps too.
  const many = [];
  for (let i = 0; i < 20; i++) many.push(node('service', `s${i}`, { name: `s${i}` }));
  const c = architectureViews(Graph.fromFacts(many), { maxNodes: 5 }).views.containers.mermaid;
  assert.match(c, /"\+16 more"/);
});

test('cycles view draws the shortest loop with thick arrows', () => {
  const g = Graph.fromFacts([mod('a.ts'), mod('b.ts'), mod('c.ts'), imp('a.ts', 'b.ts'), imp('b.ts', 'a.ts'), imp('b.ts', 'c.ts'), imp('c.ts', 'b.ts')]);
  const v = architectureViews(g).views.cycles;
  assert.match(v.mermaid, /==>/);
  assert.ok(v.notes.some((n) => /1 module cycle/.test(n)));
  assert.ok(v.notes.some((n) => /shortest loop/.test(n)));
});

test('trust boundaries flag privileged roles and unprotected workloads', () => {
  const g = Graph.fromFacts([
    node('ingress', 'p/i', { name: 'public-ingress', attrs: { namespace: 'p' } }),
    node('workload', 'p/Deployment/api', { name: 'api', attrs: { namespace: 'p', service_account: 'api-sa' } }),
    node('workload', 'p/Deployment/job', { name: 'job', attrs: { namespace: 'p' } }),
    node('service_account', 'p/api-sa', { name: 'api-sa', attrs: { namespace: 'p' } }),
    node('role', 'p/admin', { name: 'admin', attrs: { cluster_admin: true } }),
    node('firewall_rule', 'p/deny', { name: 'default-deny' }),
    edge('ROUTES_TO', 'ingress:p/i', 'workload:p/Deployment/api'),
    edge('ASSUMES', 'service_account:p/api-sa', 'role:p/admin'),
    edge('PROTECTED_BY', 'workload:p/Deployment/api', 'firewall_rule:p/deny'),
  ]);
  const v = architectureViews(g).views.trust_boundaries;
  assert.match(v.mermaid, /class n\d+ risky/);
  assert.match(v.mermaid, /class n\d+ public/);
  assert.ok(v.notes.some((n) => /Privileged role admin: cluster-admin/.test(n)));
  assert.ok(v.notes.some((n) => /1 workload\(s\) have no network policy attached: job/.test(n)));
});

test('scope limits the views to paths under it', () => {
  const r = architectureViews(Graph.fromFacts(layeredMonolith()), { scope: ['src/controllers'] });
  assert.doesNotMatch(r.views.landscape.mermaid, /repositories/);
  assert.match(r.views.landscape.mermaid, /controllers/);
});
