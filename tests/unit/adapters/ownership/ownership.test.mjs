import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import adapter from '../../../../adapters/ownership/index.mjs';
import { patternToGlob } from '../../../../adapters/ownership/codeowners.mjs';
import { assertFact, nodeFact, prov } from '../../../../runtime/graph/facts.mjs';

const fx = (name) => readFileSync(fileURLToPath(new URL(`../../../fixtures/ownership/${name}`, import.meta.url)), 'utf8');
function run(fixture, path) {
  const facts = adapter.extract({ path, size: 0, language: null, kind: 'config', blob: 'x' }, fx(fixture), {});
  facts.forEach(assertFact);
  return facts;
}
const node = (facts, id) => facts.find((f) => f.kind === 'node' && f.id === id);
const edges = (facts, type, from, to) => facts.filter((f) => f.kind === 'edge' && f.type === type && (!from || f.from === from) && (!to || f.to === to));
const sha = (s) => createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 16);
const P = (ref = 'x:1') => prov({ source_type: 'ast', source_ref: ref, extractor: 'javascript@0.1.0' });
const mod = (path) => nodeFact('module', path, { path }, P(`${path}:1`));

test('adapter shape', () => {
  assert.equal(adapter.id, 'ownership');
  assert.equal(adapter.kind, 'ownership');
  assert.equal(adapter.capabilities.network, false);
  assert.deepEqual(adapter.extract({ path: 'src/a.ts' }, 'x', {}), []);
  assert.deepEqual(adapter.extract({ path: 'docs/adr/README.md' }, '# ADRs', {}), []);
});

test('patternToGlob: gitignore semantics to Unknot globs', () => {
  assert.equal(patternToGlob('*'), '**/*');
  assert.equal(patternToGlob('*.js'), '**/*.js');
  assert.equal(patternToGlob('/docs/x.md'), 'docs/x.md');
  assert.equal(patternToGlob('apps/'), '**/apps/**');
  assert.equal(patternToGlob('/services/checkout/'), 'services/checkout/**');
  assert.equal(patternToGlob('docs/*'), 'docs/*');
  assert.equal(patternToGlob('**/foo'), '**/foo');
});

test('codeowners: rules, teams, users and hashed e-mail owners', () => {
  const f = run('CODEOWNERS', 'CODEOWNERS');
  const file = node(f, 'file:CODEOWNERS');
  assert.equal(file.attrs.rule_count, 6);
  assert.deepEqual(file.attrs.rules[3], { line: 7, pattern: '/services/checkout/', glob: 'services/checkout/**', owners: ['team:@acme/checkout', 'owner:@alice'] });
  assert.ok(node(f, 'team:@acme/platform'));
  assert.ok(node(f, 'owner:@alice'));
  const h = sha('dana.smith@example.com');
  const dana = node(f, `owner:email:${h}`);
  assert.equal(dana.attrs.kind, 'email');
  assert.equal(dana.attrs.email_hash, h);
  const dump = JSON.stringify(f);
  assert.ok(!/example\.com/i.test(dump), 'raw e-mail must never be stored');
  assert.ok(!dump.includes('Dana'));
});

test('codeowners link: last matching rule wins, unowned rule clears ownership', () => {
  const factsByFile = new Map([
    ['CODEOWNERS', run('CODEOWNERS', 'CODEOWNERS')],
    ['src/a.ts', [mod('services/checkout/src/a.ts'), mod('services/checkout/docs/x.md'), mod('src/app.js'), mod('README.md'), mod('docs/guide.md'), mod('apps/x/legacy/y.ts')]],
  ]);
  const out = adapter.link({ files: new Map(), factsByFile, options: {} });
  out.forEach(assertFact);
  const owned = (id) => edges(out, 'OWNED_BY', id).map((e) => e.to).sort();
  assert.deepEqual(owned('module:services/checkout/src/a.ts'), ['owner:@alice', 'team:@acme/checkout']);
  assert.deepEqual(owned('module:services/checkout/docs/x.md'), ['team:@acme/docs']);
  // services/checkout/src/a.ts is not .js, but a .js file elsewhere takes the *.js rule over *.
  assert.deepEqual(owned('module:src/app.js'), ['team:@acme/frontend']);
  assert.deepEqual(owned('module:README.md'), ['team:@acme/platform']);
  assert.deepEqual(owned('module:docs/guide.md'), [`owner:email:${sha('dana.smith@example.com')}`]);
  assert.deepEqual(owned('module:apps/x/legacy/y.ts'), []);
  const e = edges(out, 'OWNED_BY', 'module:services/checkout/src/a.ts')[0];
  assert.equal(e.attrs.rule_line, 7);
  const attr = out.find((f) => f.kind === 'node' && f.id === 'module:services/checkout/src/a.ts');
  assert.deepEqual(attr.attrs.owners, ['owner:@alice', 'team:@acme/checkout']);
  assert.equal(attr.attrs.rule_line, 7);
});

test('catalog-info: component, api, resource, system, group', () => {
  const f = run('catalog-info.yaml', 'services/checkout/catalog-info.yaml');
  const svc = node(f, 'service:checkout');
  assert.equal(svc.attrs.code_root, 'services/checkout');
  assert.equal(svc.path, 'services/checkout');
  assert.equal(svc.attrs.lifecycle, 'production');
  assert.equal(svc.attrs.system, 'shop');
  assert.equal(svc.provenance.source_type, 'catalog');
  assert.equal(edges(f, 'OWNED_BY', 'service:checkout', 'team:payments').length, 1);
  assert.equal(edges(f, 'EXPOSES', 'service:checkout', 'endpoint:api:checkout-api').length, 1);
  assert.equal(edges(f, 'CONSUMES', 'service:checkout', 'endpoint:api:pricing-api').length, 1);
  assert.equal(edges(f, 'DEPENDS_ON', 'service:checkout', 'service:pricing').length, 1);
  assert.equal(edges(f, 'DEPENDS_ON', 'service:checkout', 'resource:orders-db').length, 1);
  assert.equal(node(f, 'endpoint:api:checkout-api').attrs.api_type, 'openapi');
  assert.equal(edges(f, 'OWNED_BY', 'resource:orders-db', 'owner:carol').length, 1);
  assert.equal(edges(f, 'CONTAINS', 'namespace:system:shop', 'service:checkout').length, 1);
  const team = node(f, 'team:payments');
  assert.equal(team.attrs.display_name, 'Payments');
  assert.equal(team.attrs.email_hash, sha('payments-team@example.com'));
  assert.deepEqual(team.attrs.members, ['carol']);
  assert.ok(!/example\.com/.test(JSON.stringify(f)));
  assert.equal(f.filter((x) => x.id === 'team:payments').length, 1);
});

test('ADRs: nygard and MADR metadata, redaction', () => {
  const a1 = run('0001-use-postgres.md', 'docs/adr/0001-use-postgres.md')[0];
  assert.equal(a1.id, 'adr:docs/adr/0001-use-postgres.md');
  assert.equal(a1.attrs.title, 'Use Postgres for orders');
  assert.equal(a1.attrs.status, 'accepted');
  assert.equal(a1.attrs.date, '2023-03-14');
  assert.equal(a1.attrs.number, 1);
  assert.equal(a1.attrs.decision, 'We will use PostgreSQL as the system of record for orders. See https://example.com/docs/pg for details.');
  assert.deepEqual(a1.attrs.mentioned_paths, ['services/checkout/src']);
  assert.ok(!JSON.stringify(a1).includes('eve@'));
  const a2 = run('0002-use-cockroach.md', 'docs/adr/0002-use-cockroach.md')[0];
  assert.deepEqual(a2.attrs.supersedes, ['docs/adr/0001-use-postgres.md']);
  const a3 = run('madr-0003-queue.md', 'docs/decisions/0003-queue.md')[0];
  assert.equal(a3.attrs.status, 'proposed');
  assert.equal(a3.attrs.date, '2025-01-20');
  assert.equal(a3.attrs.title, 'Use a queue for emails');
  assert.match(a3.attrs.decision, /^Chosen option/);
});

test('ADR decision summary is capped at 300 characters', () => {
  const long = `# 9. Long\n\n## Status\n\nProposed\n\n## Decision\n\n${'word '.repeat(200)}\n`;
  const [a] = adapter.extract({ path: 'adr/0009-long.md' }, long, {});
  assert.ok(a.attrs.decision.length <= 300);
  assert.ok(a.attrs.decision.endsWith('…'));
});

test('ADR link: SUPERSEDES, superseded status and DESCRIBED_BY by exact path', () => {
  const factsByFile = new Map([
    ['docs/adr/0001-use-postgres.md', run('0001-use-postgres.md', 'docs/adr/0001-use-postgres.md')],
    ['docs/adr/0002-use-cockroach.md', run('0002-use-cockroach.md', 'docs/adr/0002-use-cockroach.md')],
    ['services/checkout/catalog-info.yaml', run('catalog-info.yaml', 'services/checkout/catalog-info.yaml')],
    ['m', [mod('services/checkout/src'), mod('services/billing/src')]],
  ]);
  const out = adapter.link({ files: new Map(), factsByFile, options: {} });
  out.forEach(assertFact);
  assert.equal(edges(out, 'SUPERSEDES', 'adr:docs/adr/0002-use-cockroach.md', 'adr:docs/adr/0001-use-postgres.md').length, 1);
  const old = out.find((f) => f.kind === 'node' && f.id === 'adr:docs/adr/0001-use-postgres.md');
  assert.equal(old.attrs.status, 'superseded');
  assert.deepEqual(old.attrs.superseded_by, ['docs/adr/0002-use-cockroach.md']);
  const described = edges(out, 'DESCRIBED_BY', 'module:services/checkout/src').map((e) => e.to);
  assert.deepEqual(described, ['adr:docs/adr/0001-use-postgres.md']);
  assert.equal(edges(out, 'DESCRIBED_BY', 'module:services/billing/src').length, 0);
  // The checkout service's code_root is mentioned exactly by ADR 2.
  assert.deepEqual(edges(out, 'DESCRIBED_BY', 'service:checkout').map((e) => e.to), ['adr:docs/adr/0002-use-cockroach.md']);
});

test('OWNERS: per-directory owners, per-file, includes, noparent, hashed e-mails', () => {
  const co = run('OWNERS-checkout', 'services/checkout/OWNERS');
  const f = node(co, 'file:services/checkout/OWNERS');
  assert.equal(f.attrs.dir, 'services/checkout');
  assert.deepEqual(f.attrs.includes, ['services/shared/OWNERS']);
  assert.equal(f.attrs.per_file[0].globs[0], '*.md');
  assert.ok(!/example\.org/.test(JSON.stringify(co)));
  const root = run('OWNERS-root', 'OWNERS');
  assert.equal(node(root, 'file:OWNERS').attrs.anyone, true);
  const shared = run('OWNERS-shared', 'services/shared/OWNERS');
  assert.equal(node(shared, 'file:services/shared/OWNERS').attrs.noparent, true);

  const factsByFile = new Map([
    ['services/checkout/OWNERS', co], ['OWNERS', root], ['services/shared/OWNERS', shared],
    ['m', [mod('services/checkout/src/a.ts'), mod('services/checkout/README.md'), mod('top.ts'), mod('services/shared/x.ts')]],
  ]);
  const out = adapter.link({ files: new Map(), factsByFile, options: {} });
  const to = (id) => edges(out, 'OWNED_BY', id).map((e) => e.to).sort();
  const h = (e) => `owner:email:${sha(e)}`;
  assert.deepEqual(to('module:services/checkout/src/a.ts'), [h('alice@example.org'), h('root@example.org'), h('shared@example.org')].sort());
  assert.ok(to('module:services/checkout/README.md').includes(h('bob@example.org')));
  assert.deepEqual(to('module:top.ts'), [h('root@example.org')]);
  // noparent stops inheritance from the root OWNERS.
  assert.deepEqual(to('module:services/shared/x.ts'), [h('shared@example.org')]);
});

test('codeowners precedence: .github/CODEOWNERS beats the root file', () => {
  const gh = run('CODEOWNERS', '.github/CODEOWNERS');
  const rootOnly = [nodeFact('file', 'CODEOWNERS', { path: 'CODEOWNERS', attrs: { codeowners: true, rules: [{ line: 1, pattern: '*', glob: '**/*', owners: ['team:@x/y'] }] } }, P())];
  const out = adapter.link({ files: new Map(), factsByFile: new Map([['.github/CODEOWNERS', gh], ['CODEOWNERS', rootOnly], ['m', [mod('README.md')]]]), options: {} });
  assert.deepEqual(edges(out, 'OWNED_BY', 'module:README.md').map((e) => e.to), ['team:@acme/platform']);
});
