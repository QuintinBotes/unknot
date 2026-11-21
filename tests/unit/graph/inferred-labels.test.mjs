// Edges found only by matching names are labelled inferred, and confidence follows the labels (#77).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import * as S from '../../helpers/scip.mjs';
import { analyse } from '../../golden/_harness.mjs';

const { mapRepository } = await import('../../../runtime/graph/builder.mjs');
const { decompose } = await import('../../../runtime/decompose/index.mjs');
const { diagnose } = await import('../../../runtime/diagnose/engine.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { architectureViews } = await import('../../../runtime/artifacts/architecture.mjs');

after(() => K.cleanup());

const map = (p) => mapRepository(p.ctx, { config: K.cfg({ mode: 'plan' }), configDigest: 'd', history: false });
const edge = (p, type, from, to) => p.ctx.store.get('SELECT label FROM edges WHERE type = ? AND src = ? AND dst = ?', type, `module:${from}`, `module:${to}`)?.label;
const moduleEdges = (ctx) => ctx.store.all("SELECT type, label FROM edges WHERE type IN ('IMPORTS', 'CALLS') AND src LIKE 'module:%' AND dst LIKE 'module:%'");

test('scenario 1 and SC-001: on a lexical map of the golden C# repository no name-matched edge is observed', async () => {
  const { ctx } = await analyse('equivalent-csharp', { skipDiagnose: true });
  const edges = moduleEdges(ctx);
  assert.ok(edges.some((e) => e.type === 'IMPORTS'), 'the fixture has type-reference edges');
  assert.deepEqual([...new Set(edges.map((e) => e.label))], ['inferred']);
});

const MAILER = 'namespace Shop\n{\n    public class Mailer\n    {\n        public void Send() { }\n    }\n}\n';
const REPORTS = 'namespace Shop\n{\n    public class ReportService\n    {\n        public Mailer Notifier { get; set; }\n        public void Run() { Notifier.Send(); }\n    }\n}\n';
const sy = { mailer: S.sym('Shop', 'Mailer'), send: S.sym('Shop', 'Mailer', 'Send().'), reports: S.sym('Shop', 'ReportService'), notifier: S.sym('Shop', 'ReportService', 'Notifier.'), run: S.sym('Shop', 'ReportService', 'Run().') };
const def = (symbol, line) => ({ range: [line, 8, 20], symbol, roles: S.ROLE.Definition });
const ref = (symbol, line, roles = S.ROLE.ReadAccess) => ({ range: [line, 20, 28], symbol, roles });

test('scenario 2: with a SCIP index the same type-reference edge is observed', async () => {
  const p = K.makeProject({ files: { 'Shop/Mailer.cs': MAILER, 'Shop/ReportService.cs': REPORTS } });
  await map(p);
  assert.equal(edge(p, 'IMPORTS', 'Shop/ReportService.cs', 'Shop/Mailer.cs'), 'inferred');
  S.writeIndex(join(p.dir, 'index.scip'), {
    documents: [
      S.document({ path: 'Shop/Mailer.cs', occurrences: [def(sy.mailer, 2), def(sy.send, 4)] }),
      S.document({ path: 'Shop/ReportService.cs', occurrences: [def(sy.reports, 2), def(sy.notifier, 4), ref(sy.mailer, 4, 0), def(sy.run, 5), ref(sy.notifier, 5), ref(sy.send, 5, 0)] }),
    ],
  });
  await map(p);
  assert.equal(edge(p, 'IMPORTS', 'Shop/ReportService.cs', 'Shop/Mailer.cs'), 'observed');
});

test('scenario 3: a JavaScript relative import resolved to a file path stays observed', async () => {
  const p = K.makeProject({ files: { 'src/a.js': "import { b } from './b.js';\nexport const a = () => b();\n", 'src/b.js': 'export const b = () => 1;\n' } });
  await map(p);
  assert.equal(edge(p, 'IMPORTS', 'src/a.js', 'src/b.js'), 'observed');
});

const inferAll = (ctx) => ctx.store.run("UPDATE edges SET label = 'inferred' WHERE type IN ('IMPORTS', 'CALLS')");
// Only the module-to-module edges: an import of an external package stays observed and must not dilute the share.
const inferModules = (ctx) => ctx.store.run("UPDATE edges SET label = 'inferred' WHERE type IN ('IMPORTS', 'CALLS') AND src LIKE 'module:%' AND dst LIKE 'module:%'");

test('scenario 4: the same boundary on inferred edges has the lower confidence and says why', async () => {
  const r = await analyse('modular-monolith', { skipDiagnose: true });
  const observed = await decompose(r.ctx, { config: r.config, dryRun: true });
  assert.ok(r.ctx.store.get("SELECT COUNT(*) AS n FROM edges WHERE type = 'IMPORTS' AND dst LIKE 'dependency:%' AND label = 'observed'").n > 0, 'the fixture imports external packages');
  inferModules(r.ctx);
  const inferred = await decompose(r.ctx, { config: r.config, dryRun: true });
  const order = ['low', 'medium', 'high'];
  const pairs = observed.details.map((o) => [o, inferred.details.find((i) => i.fingerprint === o.fingerprint)]);
  const lowered = pairs.filter(([o]) => o.confidence !== 'low');
  assert.ok(lowered.length, `a boundary above low confidence: ${observed.details.map((d) => d.confidence)}`);
  for (const [o, i] of lowered) {
    assert.equal(order.indexOf(i.confidence), order.indexOf(o.confidence) - 1, `${o.candidate.name}: ${o.confidence} -> ${i.confidence}`);
    assert.match(i.confidence_lowered, /matched by name \(inferred\)/);
    assert.ok(i.evidence_gaps.includes(i.confidence_lowered));
    assert.equal(i.candidate.metrics['boundary.inferred_share'], 1);
    assert.equal(o.confidence_lowered, undefined);
  }
});

test('architecture views state the share of inferred edges, and a style resting on them is one step less sure', async () => {
  const p = K.makeProject({ files: {
    'src/controllers/orders.js': "import { place } from '../services/orders.js';\nexport const post = () => place();\n",
    'src/services/orders.js': "import { save } from '../repositories/orders.js';\nexport const place = () => save();\n",
    'src/repositories/orders.js': 'export const save = () => 1;\n',
  } });
  await map(p);
  const before = architectureViews(Graph.fromStore(p.ctx.store));
  inferAll(p.ctx);
  const after = architectureViews(Graph.fromStore(p.ctx.store));
  const layered = (v) => v.styles.find((s) => s.style === 'layered');
  assert.ok(['corroborated', 'observed'].includes(layered(before).label), layered(before).label);
  const rank = ['inferred', 'observed', 'corroborated'];
  assert.equal(rank.indexOf(layered(after).label), rank.indexOf(layered(before).label) - 1);
  assert.match(layered(after).summary, /matched by name/);
  const notes = (v) => Object.values(v.views).flatMap((x) => x.notes).join('\n');
  assert.match(notes(after), /of the \d+ edges this view rests on \(100%\) were matched by name \(inferred\)/);
  assert.doesNotMatch(notes(before), /matched by name/);
});

test('scenario 5: finding fingerprints do not depend on labels', async () => {
  const r = await analyse('equivalent-csharp');
  const fps = (fs) => fs.map((f) => f.fingerprint).sort();
  assert.ok(r.findings.length);
  r.ctx.store.run("UPDATE edges SET label = 'observed'");
  const again = await diagnose(r.ctx, { config: r.config });
  assert.deepEqual(fps(again.findings), fps(r.findings));
});

test('a style keeps its label when only imports inside one layer are inferred', async () => {
  const p = K.makeProject({ files: {
    'src/controllers/orders.js': "import { place } from '../services/orders.js';\nexport const post = () => place();\n",
    'src/services/orders.js': "import { save } from '../repositories/orders.js';\nimport { check } from './rules.js';\nimport { price } from './pricing.js';\nexport const place = () => save() + check() + price();\n",
    'src/services/rules.js': 'export const check = () => 1;\n',
    'src/services/pricing.js': 'export const price = () => 1;\n',
    'src/repositories/orders.js': 'export const save = () => 1;\n',
  } });
  await map(p);
  const label = () => architectureViews(Graph.fromStore(p.ctx.store)).styles.find((s) => s.style === 'layered').label;
  const before = label();
  p.ctx.store.run("UPDATE edges SET label = 'inferred' WHERE type = 'IMPORTS' AND src = 'module:src/services/orders.js' AND dst LIKE 'module:src/services/%'");
  assert.equal(label(), before);
});

test('a Ruby require or C include found by the tail of its path is inferred; a path read is observed', async () => {
  const p = K.makeProject({ files: {
    'app/models/order.rb': "require 'json_codec'\nrequire 'lib/money'\nclass Order; end\n",
    'engines/codec/json_codec.rb': 'module JsonCodec; end\n',
    'lib/money.rb': 'module Money; end\n',
    'src/main.c': '#include "util/config.h"\n#include "list.h"\nint main(void) { return 0; }\n',
    'third/x/util/config.h': 'int config(void);\n',
    'src/list.h': 'int count(void);\n',
  } });
  await map(p);
  assert.equal(edge(p, 'IMPORTS', 'app/models/order.rb', 'engines/codec/json_codec.rb'), 'inferred');
  assert.equal(edge(p, 'IMPORTS', 'app/models/order.rb', 'lib/money.rb'), 'observed');
  assert.equal(edge(p, 'IMPORTS', 'src/main.c', 'third/x/util/config.h'), 'inferred');
  assert.equal(edge(p, 'IMPORTS', 'src/main.c', 'src/list.h'), 'observed');
});

test('a Go import path the generic adapter resolves stays observed', async () => {
  const p = K.makeProject({ files: {
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'main.go': 'package main\n\nimport "example.com/shop/store"\n\nfunc main() { store.Open() }\n',
    'store/store.go': 'package store\n\nfunc Open() {}\n',
  } });
  await map(p);
  assert.equal(edge(p, 'IMPORTS', 'main.go', 'store/store.go'), 'observed');
});

test('a dependency-cycle finding on name-matched edges labels its cut edges inferred', async () => {
  const { findings } = await analyse('equivalent-csharp', { extra: {
    'src/Loop/Ledger.cs': 'namespace Shop.Loop\n{\n    public class Ledger\n    {\n        Invoice i;\n    }\n}\n',
    'src/Loop/Invoice.cs': 'namespace Shop.Loop\n{\n    public class Invoice\n    {\n        Ledger l;\n    }\n}\n',
  } });
  const cycle = findings.find((f) => f.kind === 'module.dependency-cycle' && f.scope.includes('src/Loop/Ledger.cs'));
  assert.ok(cycle, findings.map((f) => f.kind).join(', '));
  const cuts = cycle.evidence.filter((e) => /^cut: /.test(e.summary));
  assert.ok(cuts.length && cuts.every((e) => e.label === 'inferred'), JSON.stringify(cuts));
});
