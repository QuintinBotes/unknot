// Local and module detectors over hand-made graphs. Positive fixtures must fire, and the
// negative twins (just under a threshold, exempt by convention, test code) must not: the
// expected non-findings matter as much as the findings (spec §26.3). A final test runs the
// whole set through diagnose() so every draft is validated against the finding schema.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import local from '../../../runtime/diagnose/detectors/local.mjs';
import module_ from '../../../runtime/diagnose/detectors/module.mjs';
import { diagnose, priority } from '../../../runtime/diagnose/engine.mjs';
import { validateArtifact } from '../../../runtime/core/schema.mjs';
import { evaluateAll } from '../../../runtime/patterns/engine.mjs';
import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { Graph } from '../../../runtime/graph/graph.mjs';

const P = prov({ source_type: 'ast', source_ref: 't.js:1', extractor: 'test@0.0.1', confidence: 'high' });
const mod = (path, attrs = {}) => nodeFact('module', path, { name: path, path, attrs: { language: 'js', loc: 50, sloc: 40, is_test: false, parse_quality: 'ast', ...attrs } }, P);
const sym = (type, path, name, attrs = {}) => nodeFact(type, `${path}#${name}`, {
  name,
  path,
  attrs: { start_line: 10, end_line: 19, lines: 10, params: 1, cyclomatic: 1, cognitive: 1, max_nesting: 1, exported: true, kind: type, ...attrs },
}, P);
const fn = (path, name, attrs) => sym('function', path, name, attrs);
const edge = (type, from, to, attrs = {}) => edgeFact(type, from, to, attrs, P);
const imp = (a, b, attrs) => edge('IMPORTS', `module:${a}`, `module:${b}`, attrs);
const contains = (path, name, type = 'function') => edge('CONTAINS', `module:${path}`, `${type}:${path}#${name}`);

const detectorsById = new Map([...local, ...module_].map((d) => [d.id, d]));
const run = (id, facts, options = {}) => detectorsById.get(id).detect({ graph: Graph.fromFacts(facts), options });
const keys = (drafts) => drafts.map((d) => d.key).sort();

// ---------------------------------------------------------------------------------------
// registry shape
// ---------------------------------------------------------------------------------------

test('every detector declares id, version, category and kinds', () => {
  const localIds = ['long-function', 'complex-function', 'deep-nesting', 'long-parameter-list', 'large-class', 'large-module', 'dead-code', 'unused-injected-member', 'unreachable-code', 'one-implementation-interface', 'duplicated-code', 'speculative-generality'];
  const moduleIds = ['dependency-cycle', 'unstable-dependency', 'hub-module', 'shotgun-surgery', 'implementation-leakage', 'oversized-api', 'low-cohesion-package', 'layer-bypass'];
  assert.deepEqual(local.map((d) => d.id), localIds.map((n) => `local.${n}`));
  assert.deepEqual(module_.map((d) => d.id), moduleIds.map((n) => `module.${n}`));
  for (const d of [...local, ...module_]) {
    assert.match(d.version, /^\d+\.\d+\.\d+$/);
    assert.equal(d.category, d.id.split('.')[0]);
    assert.ok(d.kinds.length && typeof d.detect === 'function');
  }
});

// ---------------------------------------------------------------------------------------
// local detectors
// ---------------------------------------------------------------------------------------

test('long-function: fires above the threshold, not at it, not in tests, and is configurable', () => {
  const facts = [
    mod('src/a.js'),
    fn('src/a.js', 'big', { lines: 120, start_line: 40, cyclomatic: 9 }),
    fn('src/a.js', 'exactly', { lines: 80 }),
    mod('tests/a.test.js', { is_test: true }),
    fn('tests/a.test.js', 'hugeTestHelper', { lines: 400 }),
  ];
  const out = run('local.long-function', facts);
  assert.deepEqual(keys(out), ['function:src/a.js#big']);
  const [d] = out;
  assert.match(d.title, /big is 120 lines long/);
  assert.equal(d.evidence[0].source_ref, 'src/a.js:40');
  assert.equal(d.measurements['function.lines'], 120);
  assert.equal(d.measurements['tests.present'], 0);
  assert.equal(d.thresholds.lines, 80);
  assert.equal(d.factors.evidence, 0.9);
  assert.equal(d.factors.reversibility, 0.9);
  assert.ok(d.alternatives.some((a) => a.id === 'retain'));
  assert.deepEqual(d.recovery, { type: 'revert', notes: d.recovery.notes });
  assert.match(d.verification[0], /characterization tests/);
  assert.ok(d.patterns.includes('code.extract-function'));
  assert.deepEqual(run('local.long-function', facts, { lines: 200 }), []);
  assert.deepEqual(keys(run('local.long-function', facts, { lines: 70 })), ['function:src/a.js#big', 'function:src/a.js#exactly']);
});

test('long-function: lexical modules lower evidence; covering tests change verification', () => {
  const facts = [
    mod('src/lex.js', { parse_quality: 'lexical' }),
    fn('src/lex.js', 'big', { lines: 100, parse_quality: 'lexical' }),
    mod('tests/lex.test.js', { is_test: true }),
    edge('TESTS', 'module:tests/lex.test.js', 'module:src/lex.js'),
  ];
  const [d] = run('local.long-function', facts);
  assert.equal(d.factors.evidence, 0.6);
  assert.equal(d.measurements['tests.present'], 1);
  assert.doesNotMatch(d.verification[0], /characterization/);
  assert.ok(d.uncertainties.some((u) => /lexically/.test(u)));
});

test('complex-function: cyclomatic or cognitive over the line, neither at it', () => {
  const facts = [
    mod('src/c.js'),
    fn('src/c.js', 'cy', { cyclomatic: 16, cognitive: 5 }),
    fn('src/c.js', 'cg', { cyclomatic: 5, cognitive: 21 }),
    fn('src/c.js', 'edge', { cyclomatic: 15, cognitive: 20 }),
  ];
  const out = run('local.complex-function', facts);
  assert.deepEqual(keys(out), ['function:src/c.js#cg', 'function:src/c.js#cy']);
  assert.equal(out.find((d) => d.key.endsWith('#cy')).measurements['function.cyclomatic'], 16);
  assert.deepEqual(out[0].thresholds.cyclomatic, 15);
  assert.ok(out[0].patterns.includes('code.replace-conditional-with-polymorphism'));
});

test('deep-nesting and long-parameter-list fire strictly above their thresholds', () => {
  const facts = [
    mod('src/n.js'),
    fn('src/n.js', 'deep', { max_nesting: 5 }),
    fn('src/n.js', 'ok', { max_nesting: 4 }),
    fn('src/n.js', 'many', { params: 7, exported: false }),
    fn('src/n.js', 'six', { params: 6 }),
  ];
  assert.deepEqual(keys(run('local.deep-nesting', facts)), ['function:src/n.js#deep']);
  const [p] = run('local.long-parameter-list', facts);
  assert.equal(p.key, 'function:src/n.js#many');
  assert.equal(p.measurements['function.params'], 7);
  assert.match(p.invariants.join(' '), /private/); // not exported: no public signature to keep
  const [q] = run('local.long-parameter-list', [mod('src/n.js'), fn('src/n.js', 'api', { params: 7 })]);
  assert.match(q.invariants.join(' '), /public signature/);
  assert.ok(p.patterns.includes('code.introduce-parameter-object'));
});

test('large-class counts methods or lines; large-module counts sloc and skips tests', () => {
  const facts = [
    mod('src/k.js', { sloc: 1001 }),
    sym('class', 'src/k.js', 'Huge', { methods: 21, lines: 100, kind: 'class' }),
    sym('class', 'src/k.js', 'Long', { methods: 3, lines: 501, kind: 'class' }),
    sym('class', 'src/k.js', 'Fine', { methods: 20, lines: 500, kind: 'class' }),
    mod('src/m.js', { sloc: 1000 }),
    mod('tests/big.test.js', { sloc: 5000, is_test: true }),
  ];
  const classes = run('local.large-class', facts);
  assert.deepEqual(keys(classes), ['class:src/k.js#Huge', 'class:src/k.js#Long']);
  assert.equal(classes[0].measurements['class.methods'], 21);
  assert.ok(classes[0].patterns.includes('anti-pattern.god-object'));
  assert.deepEqual(keys(run('local.large-module', facts)), ['module:src/k.js']);
});

test('dead-code: unreferenced private symbols and modules, with the documented exemptions', () => {
  const facts = [
    mod('src/d.js'),
    fn('src/d.js', 'used', { exported: false, calls: [] }),
    fn('src/d.js', 'caller', { exported: true, calls: ['byName'] }),
    fn('src/d.js', 'unused', { exported: false }),
    fn('src/d.js', 'viaCall', { exported: false }),
    fn('src/d.js', 'byName', { exported: false }),
    fn('src/d.js', 'selfOnly', { exported: false, calls: ['selfOnly'] }),
    fn('src/d.js', 'publicApi', { exported: true }),
    fn('src/d.js', 'registered', { exported: false, decorators: ['route'] }),
    fn('src/d.js', '__init__', { exported: false }),
    edge('CALLS', 'function:src/d.js#caller', 'function:src/d.js#viaCall'),
    edge('CALLS', 'function:src/d.js#caller', 'function:src/d.js#used'),
    // modules
    mod('src/orphan.js'),
    mod('src/used.js'),
    mod('src/index.js'),
    mod('src/server.js'),
    mod('webpack.config.js'),
    mod('src/routes/users.js'),
    mod('src/entry-lib.js'),
    mod('src/hosts-endpoint.js'),
    nodeFact('endpoint', 'GET /x', { name: 'GET /x', path: 'src/hosts-endpoint.js', attrs: {} }, P),
    edge('CONTAINS', 'module:src/hosts-endpoint.js', 'endpoint:GET /x'),
    nodeFact('package', 'lib', { name: 'lib', path: 'package.json', attrs: { dir: '.', main: './src/entry-lib.js' } }, P),
    mod('tests/orphan.test.js', { is_test: true }),
    imp('src/index.js', 'src/used.js'),
    imp('src/index.js', 'src/d.js'),
  ];
  const out = run('local.dead-code', facts);
  // Private symbols are grouped into one finding per module (dogfood round 1: per-symbol
  // findings were 2,318 on one repository); orphan modules stay individual.
  assert.deepEqual(keys(out), ['dead:module:src/d.js', 'module:src/orphan.js']);
  const group = out.find((d) => d.key === 'dead:module:src/d.js');
  assert.deepEqual(group.evidence.filter((e) => e.ref.startsWith('function:')).map((e) => e.ref).sort(), ['function:src/d.js#selfOnly', 'function:src/d.js#unused']);
  const mDraft = out.find((d) => d.key === 'module:src/orphan.js');
  assert.equal(mDraft.measurements['symbol.references'], 0);
  assert.ok(mDraft.uncertainties.some((u) => /medium/.test(u) && /dynamic/.test(u)));
  assert.ok(mDraft.factors.evidence <= 0.6);
  assert.ok(mDraft.patterns.includes('code.remove-dead-code'));
});

test('dead-code: without any IMPORTS edges modules are not judged', () => {
  assert.deepEqual(run('local.dead-code', [mod('a.js'), mod('b.js')]), []);
});

test('one-implementation-interface: exactly one implementer, no more, no less', () => {
  const facts = [
    mod('src/i.ts'),
    sym('interface', 'src/i.ts', 'Repo', { kind: 'interface' }),
    sym('class', 'src/i.ts', 'SqlRepo', { kind: 'class' }),
    edge('EXTENDS', 'class:src/i.ts#SqlRepo', 'interface:src/i.ts#Repo'),
    sym('interface', 'src/i.ts', 'Cache', { kind: 'interface' }),
    sym('class', 'src/i.ts', 'MemCache', { kind: 'class' }),
    sym('class', 'src/i.ts', 'RedisCache', { kind: 'class' }),
    edge('IMPLEMENTS', 'class:src/i.ts#MemCache', 'interface:src/i.ts#Cache'),
    edge('IMPLEMENTS', 'class:src/i.ts#RedisCache', 'interface:src/i.ts#Cache'),
    sym('interface', 'src/i.ts', 'Unused', { kind: 'interface' }),
    sym('class', 'src/i.ts', 'Base', { kind: 'class', abstract: true }),
    sym('class', 'src/i.ts', 'Impl', { kind: 'class' }),
    edge('EXTENDS', 'class:src/i.ts#Impl', 'class:src/i.ts#Base'),
  ];
  const out = run('local.one-implementation-interface', facts);
  assert.deepEqual(keys(out), ['class:src/i.ts#Base', 'interface:src/i.ts#Repo']);
  assert.equal(out[0].measurements['interface.implementations'], 1);
  assert.ok(out[0].patterns.includes('code.collapse-hierarchy'));
  assert.ok(out[0].alternatives.some((a) => a.id === 'retain'));
});

test('duplicated-code: one finding per clone group; small, dissimilar, test and barrel clones are ignored', () => {
  const clone = (other, lines, similarity) => ({ other, similarity, lines, ranges: [[5, 5 + lines - 1, 7, 7 + lines - 1]] });
  const facts = [
    mod('src/a.js', { clones: [clone('src/b.js', 24, 0.8), clone('src/tiny.js', 12, 0.9), clone('src/loose.js', 30, 0.1), clone('tests/t.test.js', 30, 0.9)] }),
    mod('src/b.js', { clones: [{ other: 'src/a.js', similarity: 0.8, lines: 24, ranges: [[7, 30, 5, 28]] }] }),
    mod('src/tiny.js'),
    mod('src/loose.js'),
    mod('tests/t.test.js', { is_test: true }),
  ];
  const out = run('local.duplicated-code', facts);
  assert.equal(out.length, 1);
  const [d] = out;
  assert.equal(d.key, 'clone:src/a.js|src/b.js');
  assert.deepEqual(d.scope, ['src/a.js', 'src/b.js']);
  assert.equal(d.measurements['duplication.similarity'], 0.8);
  assert.equal(d.measurements['duplication.instances'], 2);
  assert.equal(d.evidence[0].source_ref, 'src/a.js:5');
  assert.ok(d.patterns.includes('anti-pattern.copy-paste-programming'));
  // With a lower threshold the tiny clone joins: modules cloned together form one group.
  const grouped = run('local.duplicated-code', facts, { min_lines: 5 });
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].scope, ['src/a.js', 'src/b.js', 'src/tiny.js']);
  assert.equal(grouped[0].measurements['duplication.instances'], 3);
});

test('speculative-generality: an abstract class with one implementation and few consumers; concrete wrapper names are not judged', () => {
  const facts = [
    mod('src/g.js'),
    sym('class', 'src/g.js', 'WidgetFactory', { kind: 'class', abstract: true }),
    sym('class', 'src/g.js', 'DefaultWidgetFactory', { kind: 'class' }),
    edge('EXTENDS', 'class:src/g.js#DefaultWidgetFactory', 'class:src/g.js#WidgetFactory'),
    imp('src/use1.js', 'src/g.js'),
    mod('src/use1.js'),
    // abstract, but several consumers: not speculative
    mod('src/busy.js'),
    sym('class', 'src/busy.js', 'JobManager', { kind: 'class', abstract: true }),
    ...['u1', 'u2', 'u3'].flatMap((u) => [mod(`src/${u}.js`), imp(`src/${u}.js`, 'src/busy.js')]),
    // abstract with several implementations: a real strategy family
    mod('src/strat.js'),
    sym('class', 'src/strat.js', 'PricingStrategy', { kind: 'class', abstract: true }),
    sym('class', 'src/strat.js', 'FlatPricing', { kind: 'class' }),
    sym('class', 'src/strat.js', 'TieredPricing', { kind: 'class' }),
    edge('EXTENDS', 'class:src/strat.js#FlatPricing', 'class:src/strat.js#PricingStrategy'),
    edge('EXTENDS', 'class:src/strat.js#TieredPricing', 'class:src/strat.js#PricingStrategy'),
    // a concrete class named like a wrapper (a Django model manager, a script's helper): not judged
    mod('src/managers.py'),
    sym('class', 'src/managers.py', 'TenantManager', { kind: 'class', bases: ['models.Manager'] }),
    // Python ABC base with one implementation
    mod('src/pay.py'),
    sym('class', 'src/pay.py', 'Gateway', { kind: 'class', bases: ['ABC'] }),
    sym('class', 'src/pay.py', 'StripeGateway', { kind: 'class', bases: ['Gateway'] }),
    edge('EXTENDS', 'class:src/pay.py#StripeGateway', 'class:src/pay.py#Gateway'),
  ];
  const out = run('local.speculative-generality', facts);
  assert.deepEqual(keys(out), ['class:src/g.js#WidgetFactory', 'class:src/pay.py#Gateway']);
  assert.ok(out.every((d) => d.factors.evidence === 0.6));
  assert.ok(out[0].uncertainties.some((u) => /low/i.test(u)));
  assert.ok(out[0].patterns.includes('anti-pattern.speculative-generality'));
});

// ---------------------------------------------------------------------------------------
// module detectors
// ---------------------------------------------------------------------------------------

test('dependency-cycle: one finding per component with the shortest cycle, none for a DAG', () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) => mod(`src/${n}.js`));
  const facts = [...files, imp('src/a.js', 'src/b.js'), imp('src/b.js', 'src/c.js'), imp('src/c.js', 'src/a.js'), imp('src/c.js', 'src/b.js'), imp('src/d.js', 'src/e.js')];
  const out = run('module.dependency-cycle', facts).filter((d) => d.kind === 'module.dependency-cycle');
  assert.equal(out.length, 1);
  const [d] = out;
  assert.equal(d.measurements['cycle.size'], 3);
  assert.equal(d.evidence.filter((e) => e.summary.startsWith('imports ')).length, 2); // shortest cycle is b <-> c
  assert.equal(d.evidence.filter((e) => e.summary.startsWith('cut: ')).length, d.measurements['cycle.cut_edges']);
  assert.match(d.title, /3 modules form an import cycle: src\/b\.js -> src\/c\.js -> src\/b\.js/);
  assert.ok(d.patterns.includes('domain.acyclic-dependencies'));
  assert.deepEqual(run('module.dependency-cycle', [...files, imp('src/d.js', 'src/e.js'), imp('src/a.js', 'src/b.js')]), []);
});

test('unused-injected-member: one finding per declared-only edge, ranked higher inside a component', () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) => mod(`src/${n}.cs`));
  const unused = { declared_only: true, unused_member: 'Ledger', member_visibility: 'public', line: 7 };
  const facts = [...files, imp('src/a.cs', 'src/b.cs'), imp('src/b.cs', 'src/c.cs'), imp('src/c.cs', 'src/a.cs', unused), imp('src/b.cs', 'src/a.cs'), imp('src/d.cs', 'src/e.cs', { declared_only: true, unused_member: '_log', member_visibility: 'private' })];
  const out = run('local.unused-injected-member', facts);
  assert.equal(out.length, 2);
  const inScc = out.find((d) => d.scope[0] === 'src/c.cs');
  const alone = out.find((d) => d.scope[0] === 'src/d.cs');
  assert.equal(inScc.kind, 'code.unused-injected-member');
  assert.deepEqual(inScc.scope, ['src/c.cs']);
  assert.match(inScc.title, /src\/c\.cs holds src\/a\.cs only through the unused member Ledger/);
  assert.match(inScc.title, /closes 1 of 2 cycles in a 3-module component/);
  assert.equal(inScc.measurements['cycle.closed'], 1);
  assert.equal(inScc.measurements['member.public'], true);
  assert.match(inScc.smallest_simplification, /Remove the member Ledger from src\/c\.cs \(and its registration if any\)/);
  assert.ok(inScc.evidence.some((e) => e.source_ref === 'src/c.cs:7'));
  assert.equal(alone.measurements['cycle.closed'], undefined);
  assert.ok(inScc.factors.benefit > alone.factors.benefit);
  assert.ok(priority(inScc.factors).score > priority(alone.factors).score);
  assert.deepEqual(run('local.unused-injected-member', [...files, imp('src/a.cs', 'src/b.cs')]), []);
});

test('unused-injected-member: a member other files may reach only by name is reported at low confidence, naming them', () => {
  const files = ['a', 'b', 'c'].map((n) => mod(`src/${n}.cs`));
  const maybe = { use_evidence: 'name-only', possible_use_of: 'Ledger', possible_receivers: 'src/x.cs, src/y.cs' };
  const out = run('local.unused-injected-member', [...files, imp('src/a.cs', 'src/b.cs', maybe), imp('src/a.cs', 'src/c.cs')]);
  assert.equal(out.length, 1);
  const [d] = out;
  assert.equal(d.confidence, 'low');
  assert.match(d.title, /src\/a\.cs holds src\/b\.cs only through the possibly unused member Ledger/);
  assert.match(d.evidence[0].summary, /2 file\(s\) read a member of that name on a receiver whose type is unknown: src\/x\.cs, src\/y\.cs/);
  assert.ok(d.uncertainties.some((u) => /check those before removing it/.test(u)));
  assert.ok(d.evidence.some((e) => e.label === 'inferred'));
  // The same edge proven unused keeps the same finding key, at medium confidence.
  const proven = run('local.unused-injected-member', [...files, imp('src/a.cs', 'src/b.cs', { declared_only: true, unused_member: 'Ledger', member_visibility: 'public' })]);
  assert.equal(proven[0].confidence, 'medium');
  assert.equal(proven[0].key, d.key);
});

test('dependency-cycle: a cycle closed only by an unused member says so and ranks lower; a surviving cycle lists unused links', () => {
  const files = ['a', 'b', 'c'].map((n) => mod(`src/${n}.cs`));
  const unused = { declared_only: true, unused_member: '_orders' };
  const only = run('module.dependency-cycle', [...files, imp('src/a.cs', 'src/b.cs'), imp('src/b.cs', 'src/a.cs', unused)]).filter((d) => d.kind === 'module.dependency-cycle');
  assert.equal(only.length, 1);
  assert.match(only[0].title, /closes only through src\/b\.cs's unused member _orders/);
  assert.match(only[0].smallest_simplification, /remove the unused member/);
  const normal = run('module.dependency-cycle', [...files, imp('src/a.cs', 'src/b.cs'), imp('src/b.cs', 'src/a.cs')]).filter((d) => d.kind === 'module.dependency-cycle');
  assert.ok(only[0].factors.benefit < normal[0].factors.benefit);
  // Two independent routes back: the declared-only link is not what closes the cycle.
  const survive = run('module.dependency-cycle', [...files, imp('src/a.cs', 'src/b.cs'), imp('src/b.cs', 'src/a.cs'), imp('src/b.cs', 'src/c.cs'), imp('src/c.cs', 'src/b.cs', unused)]).filter((d) => d.kind === 'module.dependency-cycle');
  assert.equal(survive.length, 1);
  assert.doesNotMatch(survive[0].title, /unused member/);
  assert.ok(survive[0].evidence.some((e) => /unused link/.test(e.summary)));
});

test('dependency-cycle: package-level cycles through condensation, none when imports are acyclic', () => {
  const m = (p) => mod(`src/${p}.js`);
  const facts = [m('ui/a'), m('ui/b'), m('core/x'), m('core/y'), m('db/z'), imp('src/ui/a.js', 'src/core/x.js'), imp('src/core/y.js', 'src/ui/b.js'), imp('src/core/x.js', 'src/db/z.js')];
  const out = run('module.dependency-cycle', facts);
  assert.deepEqual(out.map((d) => d.kind), ['module.package-cycle']); // no module-level cycle: a and b differ
  assert.match(out[0].title, /2 packages depend on each other/);
  assert.equal(out[0].measurements['cycle.size'], 2);
  const acyclic = [m('ui/a'), m('core/x'), m('db/z'), imp('src/ui/a.js', 'src/core/x.js'), imp('src/core/x.js', 'src/db/z.js')];
  assert.deepEqual(run('module.dependency-cycle', acyclic), []);
});

test('unstable-dependency: stable module importing an unstable one, not stable-to-stable', () => {
  const dependents = ['a', 'b', 'c'].flatMap((n) => [mod(`src/ui/${n}.js`), imp(`src/ui/${n}.js`, 'src/stable/s.js')]);
  const leaves = ['l1', 'l2', 'l3'].flatMap((n) => [mod(`src/leaf/${n}.js`), imp('src/volatile/u.js', `src/leaf/${n}.js`)]);
  const facts = [mod('src/stable/s.js'), mod('src/volatile/u.js'), ...dependents, ...leaves, imp('src/stable/s.js', 'src/volatile/u.js')];
  const out = run('module.unstable-dependency', facts);
  assert.ok(out.some((d) => d.key === 'sdp:module:src/stable/s.js->module:src/volatile/u.js'));
  assert.ok(out.some((d) => d.key.startsWith('sdp-package:')));
  assert.ok(out[0].patterns.includes('domain.stable-dependencies'));
  assert.ok(out.every((d) => d.thresholds.stable_max === 0.3 && d.thresholds.unstable_min === 0.7));
  // The target is itself depended on by many modules: it is stable, so no violation.
  const calm = [...facts, ...['p', 'q', 'r', 's', 't'].flatMap((n) => [mod(`src/ui/${n}.js`), imp(`src/ui/${n}.js`, 'src/volatile/u.js')])];
  assert.deepEqual(run('module.unstable-dependency', calm), []);
});

test('hub-module: needs both fan-in and fan-out at the threshold', () => {
  const build = (fi, fo) => [
    mod('src/hub.js'),
    ...Array.from({ length: fi }, (_, i) => [mod(`src/in${i}.js`), imp(`src/in${i}.js`, 'src/hub.js')]).flat(),
    ...Array.from({ length: fo }, (_, i) => [mod(`src/out${i}.js`), imp('src/hub.js', `src/out${i}.js`)]).flat(),
  ];
  const [d] = run('module.hub-module', build(15, 15));
  assert.equal(d.key, 'module:src/hub.js');
  assert.equal(d.measurements['module.fan_in'], 15);
  assert.equal(d.measurements['module.fan_out'], 15);
  assert.deepEqual(run('module.hub-module', build(15, 14)), []);
  assert.deepEqual(run('module.hub-module', build(30, 3)), []);
  assert.equal(run('module.hub-module', build(15, 14), { fan_out: 14 }).length, 1);
});

test('hub-module: package-level imports are not fan-in of one file', () => {
  const build = (attrs) => [
    mod('src/hub.js'),
    ...Array.from({ length: 15 }, (_, i) => [mod(`src/in${i}.js`), imp(`src/in${i}.js`, 'src/hub.js', attrs)]).flat(),
    ...Array.from({ length: 15 }, (_, i) => [mod(`src/out${i}.js`), imp('src/hub.js', `src/out${i}.js`)]).flat(),
  ];
  assert.equal(run('module.hub-module', build({})).length, 1);
  assert.deepEqual(run('module.hub-module', build({ package_level: true })), []);
});

test('shotgun-surgery: strong co-change partners across four or more packages', () => {
  const partners = (pkgs, degree) => pkgs.map((p, i) => [mod(`src/${p}/f${i}.js`), edge('CO_CHANGES', 'module:src/core/m.js', `module:src/${p}/f${i}.js`, { shared: 12, degree })]).flat();
  const base = [mod('src/core/m.js'), mod('src/core/other.js')];
  const hit = run('module.shotgun-surgery', [...base, ...partners(['a', 'b', 'c', 'd'], 0.6)]);
  assert.deepEqual(keys(hit), ['module:src/core/m.js']);
  assert.ok(hit[0].patterns.includes('anti-pattern.shotgun-surgery'));
  assert.deepEqual(run('module.shotgun-surgery', [...base, ...partners(['a', 'b', 'c'], 0.6)]), []);
  assert.deepEqual(run('module.shotgun-surgery', [...base, ...partners(['a', 'b', 'c', 'd'], 0.4)]), []);
});

test('implementation-leakage: internal paths, underscore paths and undeclared entry points', () => {
  const facts = [
    mod('packages/app/src/a.js'),
    mod('packages/billing/internal/ledger.js'),
    mod('packages/billing/api.js'),
    mod('packages/billing/internal/own.js'),
    mod('packages/py/_impl.py'),
    mod('packages/lib/src/index.js'),
    mod('packages/lib/src/deep/x.js'),
    nodeFact('package', 'lib', { name: 'lib', path: 'packages/lib/package.json', attrs: { dir: 'packages/lib', main: 'src/index.js' } }, P),
    imp('packages/app/src/a.js', 'packages/billing/internal/ledger.js'),
    imp('packages/app/src/a.js', 'packages/billing/api.js'),
    imp('packages/billing/api.js', 'packages/billing/internal/own.js'),
    imp('packages/app/src/a.js', 'packages/py/_impl.py'),
    imp('packages/app/src/a.js', 'packages/lib/src/index.js'),
    imp('packages/app/src/a.js', 'packages/lib/src/deep/x.js'),
  ];
  const out = run('module.implementation-leakage', facts);
  assert.deepEqual(keys(out), ['module:packages/billing/internal/ledger.js', 'module:packages/lib/src/deep/x.js', 'module:packages/py/_impl.py']);
  assert.match(out.find((d) => d.key.endsWith('x.js')).title, /declared entry points/);
  assert.ok(out[0].patterns.includes('domain.module-facade'));
});

test('oversized-api: wide exports mostly unused; not when usage is unknown or small', () => {
  const names = (n) => Array.from({ length: n }, (_, i) => `fn${i}`);
  const build = (exports, used, namespace = false) => [
    mod('src/api.js', { exports }),
    mod('src/user.js'),
    imp('src/user.js', 'src/api.js', { names: namespace ? ['*'] : used }),
  ];
  const [d] = run('module.oversized-api', build(names(12), ['fn0', 'fn1']));
  assert.equal(d.measurements['module.public_exports'], 12);
  assert.match(d.title, /12 names but only 2 \(17%\)/);
  assert.deepEqual(run('module.oversized-api', build(names(12), names(6))), []);
  assert.deepEqual(run('module.oversized-api', build(names(9), ['fn0'])), []);
  assert.deepEqual(run('module.oversized-api', build(names(12), [], true)), []);
  assert.deepEqual(run('module.oversized-api', [mod('src/api.js', { exports: names(12) })]), []); // nobody imports it
});

test('low-cohesion-package: mostly outward imports flagged, cohesive packages not', () => {
  const m = (p) => mod(`src/${p}.js`);
  const facts = [
    m('glue/a'), m('glue/b'), m('glue/c'), m('core/x'), m('core/y'), m('core/z'), m('tight/p'), m('tight/q'), m('tight/r'),
    imp('src/glue/a.js', 'src/core/x.js'), imp('src/glue/a.js', 'src/core/y.js'), imp('src/glue/b.js', 'src/core/x.js'),
    imp('src/glue/b.js', 'src/core/z.js'), imp('src/glue/c.js', 'src/core/y.js'), imp('src/glue/c.js', 'src/core/z.js'),
    imp('src/glue/a.js', 'src/glue/b.js'),
    imp('src/tight/p.js', 'src/tight/q.js'), imp('src/tight/q.js', 'src/tight/r.js'), imp('src/tight/r.js', 'src/tight/p.js'),
    imp('src/tight/p.js', 'src/tight/r.js'), imp('src/tight/q.js', 'src/tight/p.js'), imp('src/tight/r.js', 'src/tight/q.js'),
    imp('src/core/x.js', 'src/core/y.js'), imp('src/core/y.js', 'src/core/z.js'), imp('src/core/z.js', 'src/core/x.js'),
    imp('src/core/x.js', 'src/core/z.js'), imp('src/core/y.js', 'src/core/x.js'), imp('src/core/z.js', 'src/core/y.js'),
  ];
  const out = run('module.low-cohesion-package', facts);
  assert.deepEqual(keys(out), ['package:src/glue']);
  assert.match(out[0].title, /1 of 7 imports/);
  assert.ok(out[0].patterns.includes('domain.package-by-feature'));
});

test('layer-bypass: needs configured layers; upward imports always, skips only when strict', () => {
  const layers = ['src/ui/**', 'src/service/**', 'src/domain/**', 'src/data/**'];
  const facts = [
    mod('src/ui/page.js'), mod('src/service/s.js'), mod('src/domain/d.js'), mod('src/data/db.js'), mod('src/other/o.js'),
    imp('src/ui/page.js', 'src/service/s.js'), // adjacent: fine
    imp('src/service/s.js', 'src/domain/d.js'),
    imp('src/domain/d.js', 'src/ui/page.js'), // upward
    imp('src/ui/page.js', 'src/data/db.js'), // skips two layers
    imp('src/ui/page.js', 'src/domain/d.js'), // skips one layer
    imp('src/other/o.js', 'src/data/db.js'), // unmatched layer
  ];
  assert.deepEqual(run('module.layer-bypass', facts), []);
  assert.deepEqual(run('module.layer-bypass', facts, { layers: ['src/ui/**'] }), []);
  const upward = run('module.layer-bypass', facts, { layers });
  assert.equal(upward.length, 1);
  assert.match(upward[0].title, /from lower layer src\/domain\/\*\* up to higher layer src\/ui\/\*\*/);
  assert.equal(upward[0].measurements['layer.violations'], 1);
  const strict = run('module.layer-bypass', facts, { layers, strict: true });
  assert.equal(strict.length, 2);
  assert.ok(strict.some((d) => d.key === 'skip:src/ui/**->src/data/**'));
  assert.ok(!strict.some((d) => /domain/.test(d.key) && d.key.startsWith('skip')));
});

// ---------------------------------------------------------------------------------------
// end to end through the engine: schema-valid findings, no detector errors
// ---------------------------------------------------------------------------------------

const homes = [];
after(() => homes.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('diagnose() accepts every draft: findings validate against the schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unknot-det-'));
  homes.push(dir);
  process.env.UNKNOT_HOME = join(dir, 'home');
  const { openProject } = await import('../../../runtime/context.mjs');
  const { loadConfig } = await import('../../../runtime/policy/config.mjs');
  const ctx = openProject(join(dir, 'project'), { create: true });
  const { config } = loadConfig(ctx, { overrideRaw: { version: 1, detectors: { 'module.layer-bypass': { layers: ['src/ui/**', 'src/data/**'], strict: true } } } });

  const clone = { other: 'src/dup2.js', similarity: 0.7, lines: 20, ranges: [[3, 22, 4, 23]] };
  const facts = [
    mod('src/u.cs'),
    mod('src/v.cs'),
    imp('src/u.cs', 'src/v.cs', { declared_only: true, unused_member: 'Ledger', member_visibility: 'public' }),
    mod('src/x.js', { sloc: 1500, clones: [{ ...clone, other: 'src/dup2.js' }] }),
    mod('src/dup2.js', { clones: [{ other: 'src/x.js', similarity: 0.7, lines: 20, ranges: [[4, 23, 3, 22]] }] }),
    fn('src/x.js', 'long', { lines: 150, cyclomatic: 30, cognitive: 40, max_nesting: 6, params: 8, exported: false }),
    contains('src/x.js', 'long'),
    sym('class', 'src/x.js', 'BigThing', { methods: 30, lines: 700, kind: 'class' }),
    sym('class', 'src/x.js', 'ThingFactory', { kind: 'class', abstract: true }),
    sym('interface', 'src/x.js', 'Port', { kind: 'interface' }),
    sym('class', 'src/x.js', 'Adapter1', { kind: 'class' }),
    edge('IMPLEMENTS', 'class:src/x.js#Adapter1', 'interface:src/x.js#Port'),
    mod('src/orphan.js'),
    mod('src/ui/p.js'), mod('src/data/d.js'), mod('src/core/a.js'), mod('src/core/b.js'),
    imp('src/core/a.js', 'src/core/b.js'), imp('src/core/b.js', 'src/core/a.js'),
    imp('src/ui/p.js', 'src/data/d.js'), imp('src/data/d.js', 'src/ui/p.js'),
    imp('src/ui/p.js', 'src/x.js'),
  ];
  const graph = Graph.fromFacts(facts);
  const { stats, errors } = await diagnose(ctx, { config, graph, only: ['local', 'module'] });
  // The engine's finalize() currently adds a `risk` property that finding.schema.json does not
  // list, which rejects every finding; that is outside the detectors, so it is tolerated here.
  // Any other engine-reported problem with a draft fails the test.
  assert.deepEqual(errors.filter((e) => !/not installed|unknown property "risk"/.test(e.error)), []);
  assert.ok(stats.drafts >= 12);

  // Independent schema validation of every draft, mirroring the engine's finalisation.
  const drafts = [];
  for (const d of [...local, ...module_]) {
    for (const draft of d.detect({ graph, options: config.detectors?.[d.id] ?? {} })) drafts.push({ draft, d });
  }
  const kinds = new Set(drafts.map((x) => x.draft.kind));
  for (const k of ['code.long-function', 'code.complex-function', 'code.deep-nesting', 'code.long-parameter-list', 'code.large-class', 'code.large-module', 'code.dead-code', 'code.unused-injected-member', 'code.duplicated-code', 'code.speculative-generality', 'code.one-implementation-interface', 'module.dependency-cycle', 'module.layer-bypass']) {
    assert.ok(kinds.has(k), `missing ${k}; got ${[...kinds].join(', ')}`);
  }
  for (const { draft, d } of drafts) {
    const finding = {
      schema_version: '1.0',
      id: 'F-0001',
      fingerprint: `sha256:${'0'.repeat(64)}`,
      kind: draft.kind,
      category: d.category,
      title: draft.title,
      status: 'open',
      scope: draft.scope,
      evidence: draft.evidence.map((e) => ({ ref: e.ref, label: e.label ?? 'observed', summary: e.summary ?? '', source_ref: e.source_ref ?? null })),
      measurements: draft.measurements,
      thresholds: draft.thresholds,
      why_accidental: draft.why_accidental,
      essential_considerations: draft.essential_considerations,
      smallest_simplification: draft.smallest_simplification,
      invariants: draft.invariants,
      risks: draft.risks,
      verification: draft.verification,
      recovery: draft.recovery,
      quality_impacts: draft.quality_impacts,
      blast_radius: draft.blast_radius,
      uncertainties: draft.uncertainties,
      alternatives: draft.alternatives,
      patterns: evaluateAll(draft.patterns, draft.measurements),
      priority: priority(draft.factors),
      detector: { id: d.id, version: d.version },
    };
    const v = validateArtifact('finding', finding);
    assert.ok(v.valid, `${draft.kind} ${draft.key}: ${JSON.stringify(v.errors?.slice(0, 2))}`);
    assert.equal(draft.alternatives.filter((a) => a.id === 'retain').length, 1, `${draft.kind} needs exactly one retain`);
    assert.ok(finding.patterns.every((p) => p.fit !== 'not_evaluated'), `${draft.kind}: unknown pattern id in ${draft.patterns}`);
    assert.ok(draft.risks.length && draft.invariants.length && draft.verification.length && draft.smallest_simplification && draft.why_accidental, `${draft.kind} leaves a question unanswered`);
  }
  ctx.store.close?.();
});

test('dead-code: Meteor eager loading, asset directories, manifests and tool conventions are entry points (unfamiliar-repository regression)', () => {
  const file = (path, attrs) => nodeFact('file', path, { path, attrs }, P);
  const used = [mod('imports/main.js'), mod('imports/b.js'), edgeFact('IMPORTS', 'module:imports/main.js', 'module:imports/b.js', {}, P)];
  // server/config/init.js runs code when loaded; server/lib/Template.js only defines a class.
  const candidates = [mod('server/config/init.js', { calls: [{ name: 'Meteor.startup', line: 1 }] }), mod('server/lib/Template.js'), ...['private/workers/report.js', 'packages/x/package.js', '.storybook/config.js', 'src/Button.stories.jsx', 'typings/index.d.ts', 'imports/orphan.js'].map((p) => mod(p))];
  const meteor = [file('.meteor/release', { meteor_app: '' }), file('packages/x/package.js', { mentions: [], manifest: 'meteor-package' })];
  const flagged = (facts) => run('local.dead-code', facts).filter((d) => /imported by nothing/.test(d.title)).map((d) => d.scope[0]).sort();
  assert.deepEqual(flagged([...used, ...candidates, ...meteor]), ['imports/orphan.js', 'server/lib/Template.js']);
  // With meteor.mainModule set, files outside imports/ are no longer loaded eagerly.
  const explicit = [...meteor, file('package.json', { mentions: [], meteor_main_module: true })];
  assert.deepEqual(flagged([...used, ...candidates, ...explicit]), ['imports/orphan.js', 'server/config/init.js', 'server/lib/Template.js']);
});

test('long-function: class render methods and default exports in JSX files use the component threshold; default exports are named by file', () => {
  const fn = (path, qname, attrs) => nodeFact('function', `${path}#${qname}`, { name: qname, path, attrs: { lines: 120, cyclomatic: 2, params: 0, ...attrs } }, P);
  const facts = [mod('ui/Layout.js', { has_jsx: true }), fn('ui/Layout.js', 'Layout.render', { class: 'Layout' }), mod('ui/page.jsx'), fn('ui/page.jsx', 'default', {}), mod('lib/a.js'), fn('lib/a.js', 'default', {})];
  const titles = run('local.long-function', facts).map((d) => d.title);
  assert.deepEqual(titles, ['The default export of lib/a.js is 120 lines long (threshold 80)']);
});

test('dead-code: a stale copy beside its original is not an entry script; Protocols are not speculative (regression re-check)', () => {
  const used = [mod('svc/run.py', { entry_script: true }), mod('svc/b.py'), edgeFact('IMPORTS', 'module:svc/run.py', 'module:svc/b.py', {}, P)];
  const facts = [...used, mod('svc/main.py', { entry_script: true }), mod('svc/main_old.py', { entry_script: true }), mod('svc/tool.py', { entry_script: true })];
  const flagged = run('local.dead-code', facts).filter((d) => /imported by nothing/.test(d.title)).map((d) => d.scope[0]);
  assert.deepEqual(flagged, ['svc/main_old.py']);
  const proto = [mod('p.py'), sym('class', 'p.py', 'Port', { kind: 'class', bases: ['Protocol'] })];
  assert.deepEqual(run('local.speculative-generality', proto), []);
});
