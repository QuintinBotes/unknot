// A SCIP index replaces name matching where it covers a file: two types share a member name, the
// member of one is read only through the other, and the index names the unused one; coverage says
// semantic for indexed files and lexical for the rest; doctor reports a missing and a stale index.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../../helpers/kernel.mjs';
import * as S from '../../../helpers/scip.mjs';
import { mapRepository } from '../../../../runtime/graph/builder.mjs';
import { scipChecks } from '../../../../adapters/semantic/scip/locate.mjs';

after(() => K.cleanup());

const MAILER = 'namespace Shop\n{\n    public class Mailer\n    {\n        public void Send() { }\n    }\n}\n';
const ORDERS = 'namespace Shop\n{\n    public class OrderService\n    {\n        [Inject] public Mailer Notifier { get; set; }\n        public void Place() { }\n    }\n}\n';
const REPORTS = 'namespace Shop\n{\n    public class ReportService\n    {\n        [Inject] public Mailer Notifier { get; set; }\n        public void Run() { Notifier.Send(); }\n    }\n}\n';
// `s` has no declared type: by name alone, `s.Notifier` could be either type's member.
const CALLER = 'namespace Shop\n{\n    public class Caller\n    {\n        public void Go() { var s = Make(); s.Notifier.Send(); }\n    }\n}\n';
const LEGACY = 'namespace Shop\n{\n    public class Legacy\n    {\n        [Inject] private Mailer _mailer;\n    }\n}\n';

const FILES = {
  'Shop/Mailer.cs': MAILER,
  'Shop/OrderService.cs': ORDERS,
  'Shop/ReportService.cs': REPORTS,
  'Shop/Caller.cs': CALLER,
  'Shop/Legacy.cs': LEGACY,
};

const sy = {
  mailer: S.sym('Shop', 'Mailer'),
  send: S.sym('Shop', 'Mailer', 'Send().'),
  orders: S.sym('Shop', 'OrderService'),
  ordersNotifier: S.sym('Shop', 'OrderService', 'Notifier.'),
  place: S.sym('Shop', 'OrderService', 'Place().'),
  reports: S.sym('Shop', 'ReportService'),
  reportsNotifier: S.sym('Shop', 'ReportService', 'Notifier.'),
  run: S.sym('Shop', 'ReportService', 'Run().'),
  caller: S.sym('Shop', 'Caller'),
  go: S.sym('Shop', 'Caller', 'Go().'),
};

const D = S.ROLE.Definition;
const def = (symbol, line, extra = {}) => ({ range: [line, 8, 20], symbol, roles: D, ...extra });
const ref = (symbol, line, roles = S.ROLE.ReadAccess) => ({ range: [line, 20, 28], symbol, roles });

/** What scip-dotnet would write for FILES (Legacy.cs is deliberately left out of the index). */
function indexBytes(extra = {}) {
  return {
    projectRoot: undefined,
    documents: [
      S.document({ path: 'Shop/Mailer.cs', occurrences: [def(sy.mailer, 2), def(sy.send, 4)] }),
      S.document({
        path: 'Shop/OrderService.cs',
        occurrences: [def(sy.orders, 2), def(sy.ordersNotifier, 4), ref(sy.mailer, 4, 0), def(sy.place, 5), ...(extra.orders ?? [])],
        symbols: [{ symbol: sy.orders, kind: S.KIND.Class, relationships: extra.relationships ?? [] }],
      }),
      S.document({
        path: 'Shop/ReportService.cs',
        occurrences: [def(sy.reports, 2), def(sy.reportsNotifier, 4), ref(sy.mailer, 4, 0), def(sy.run, 5), ref(sy.reportsNotifier, 5), ref(sy.send, 5, 0)],
      }),
      S.document({
        path: 'Shop/Caller.cs',
        occurrences: [def(sy.caller, 2), def(sy.go, 4), ref(sy.reportsNotifier, 4), ref(sy.send, 4, 0)],
      }),
    ],
  };
}

const map = (p) => mapRepository(p.ctx, { config: K.cfg({ mode: 'plan' }), configDigest: 'd', history: false });
const importEdge = (p, from, to) => {
  const r = p.ctx.store.get("SELECT attrs, label FROM edges WHERE type = 'IMPORTS' AND src = ? AND dst = ?", `module:${from}`, `module:${to}`);
  return r && { ...JSON.parse(r.attrs), label: r.label };
};
const moduleAttrs = (p, path) => JSON.parse(p.ctx.store.get('SELECT attrs FROM nodes WHERE id = ?', `module:${path}`).attrs);

test('lexically, a member name shared by two types leaves the unused one ambiguous; the index decides', async () => {
  const p = K.makeProject({ files: FILES });
  await map(p);
  const lexical = importEdge(p, 'Shop/OrderService.cs', 'Shop/Mailer.cs');
  assert.ok(!lexical.declared_only, 'by name, `s.Notifier` might be OrderService.Notifier');
  assert.equal(lexical.use_evidence, 'name-only');
  assert.equal(moduleAttrs(p, 'Shop/OrderService.cs').parse_quality, 'lexical');

  S.writeIndex(join(p.dir, 'index.scip'), indexBytes());
  const r = await map(p);
  const semantic = importEdge(p, 'Shop/OrderService.cs', 'Shop/Mailer.cs');
  assert.equal(semantic.declared_only, true);
  assert.equal(semantic.unused_member, 'Notifier');
  assert.equal(semantic.unused_evidence, 'semantic');
  assert.ok(!semantic.use_evidence, 'the name-only evidence is replaced, not merged');
  assert.equal(semantic.label, 'observed', 'the edge now rests on the compiler-resolved fact (source lsp), not on name matching');
  // The type that really reads its member is not reported.
  const used = importEdge(p, 'Shop/ReportService.cs', 'Shop/Mailer.cs');
  assert.ok(!used.declared_only);
  assert.equal(r.scip.covered, 4);
  assert.equal(r.scip.documents, 4);
});

test('an assignment in the constructor is a write, not a read; a read elsewhere is a use', async () => {
  const p = K.makeProject({ files: FILES });
  const ctorWrite = [{ range: [5, 12, 20], symbol: sy.ordersNotifier, roles: S.ROLE.WriteAccess }];
  S.writeIndex(join(p.dir, 'index.scip'), indexBytes({ orders: ctorWrite }));
  await map(p);
  assert.equal(importEdge(p, 'Shop/OrderService.cs', 'Shop/Mailer.cs').declared_only, true, 'write-only keeps it unused');
  const read = [{ range: [5, 12, 20], symbol: sy.ordersNotifier, roles: S.ROLE.ReadAccess }];
  S.writeIndex(join(p.dir, 'index.scip'), indexBytes({ orders: read }));
  await map(p);
  assert.ok(!importEdge(p, 'Shop/OrderService.cs', 'Shop/Mailer.cs').declared_only, 'a read is a use');
});

test('lexical stays for files the index does not cover', async () => {
  const p = K.makeProject({ files: FILES });
  S.writeIndex(join(p.dir, 'index.scip'), indexBytes());
  await map(p);
  const legacy = importEdge(p, 'Shop/Legacy.cs', 'Shop/Mailer.cs');
  assert.equal(legacy.declared_only, true, 'name matching still finds the unused private field');
  assert.ok(!legacy.unused_evidence);
});

test('coverage is semantic for indexed files, with counts per quality; the rest keep lexical', async () => {
  const p = K.makeProject({ files: FILES });
  S.writeIndex(join(p.dir, 'index.scip'), indexBytes());
  const r = await map(p);
  const cs = r.coverage.find((c) => c.language === 'csharp');
  assert.equal(cs.files, 5);
  assert.deepEqual(cs.qualities, { lexical: 1, semantic: 4 });
  assert.equal(cs.quality, 'semantic');
  assert.ok(r.notices.some((n) => /csharp 4 of 5 source files are resolved by the SCIP index/.test(n)), JSON.stringify(r.notices));
  assert.ok(!r.unavailable.some((u) => u.adapter === 'language:csharp'), 'the dominant language is no longer lexical only');
  assert.equal(moduleAttrs(p, 'Shop/OrderService.cs').parse_quality, 'semantic');
  assert.equal(moduleAttrs(p, 'Shop/Legacy.cs').parse_quality, 'lexical');
  assert.deepEqual(moduleAttrs(p, 'Shop/OrderService.cs').semantic.unreferenced, ['OrderService.Notifier', 'OrderService.Place']);
});

test('references become REFERENCES, method calls CALLS, relationships EXTENDS and IMPLEMENTS', async () => {
  const p = K.makeProject({ files: { ...FILES, 'Shop/IOrder.cs': 'namespace Shop\n{\n    public interface IOrder { }\n}\n' } });
  const iorder = S.sym('Shop', 'IOrder');
  const bytes = indexBytes({ relationships: [{ symbol: iorder, implementation: true }] });
  bytes.documents.push(S.document({ path: 'Shop/IOrder.cs', occurrences: [def(iorder, 2)], symbols: [{ symbol: iorder, kind: S.KIND.Interface }] }));
  S.writeIndex(join(p.dir, 'index.scip'), bytes);
  await map(p);
  const row = (type, from, to) => p.ctx.store.get('SELECT attrs, label FROM edges WHERE type = ? AND src = ? AND dst = ?', type, from, to);
  const refs = row('REFERENCES', 'module:Shop/Caller.cs', 'module:Shop/ReportService.cs');
  assert.equal(JSON.parse(refs.attrs).via, 'scip');
  assert.equal(refs.label, 'observed');
  const calls = row('CALLS', 'module:Shop/Caller.cs', 'module:Shop/Mailer.cs');
  assert.equal(JSON.parse(calls.attrs).count, 1);
  const impl = p.ctx.store.get("SELECT src, dst FROM edges WHERE type = 'IMPLEMENTS'");
  assert.deepEqual({ ...impl }, { src: 'class:Shop/OrderService.cs#OrderService', dst: 'interface:Shop/IOrder.cs#IOrder' });
  // Unknot reads the index as evidence from a compiler, with spans.
  const f = p.ctx.store.get("SELECT source_type, source_ref, confidence FROM facts WHERE predicate = 'CALLS' AND subject = 'module:Shop/Caller.cs' AND extractor LIKE 'scip@%'");
  assert.deepEqual({ ...f }, { source_type: 'lsp', source_ref: 'Shop/Caller.cs:5', confidence: 'high' });
});

test('an index configured but missing fails the map loudly; none configured and none found is silent', async () => {
  const p = K.makeProject({ files: FILES });
  const r = await mapRepository(p.ctx, { config: K.cfg({ mode: 'plan', adapters: { scip: { index: 'build/missing.scip' } } }), configDigest: 'd', history: false });
  assert.equal(r.status, 'partial');
  assert.ok(r.failures.some((f) => f.adapter === 'scip' && /build\/missing\.scip/.test(f.error)), JSON.stringify(r.failures));
  const q = K.makeProject({ files: FILES });
  const s = await map(q);
  assert.ok(!s.failures.length && !s.scip);
});

test('doctor reports a missing index with how to make one, and a stale one', () => {
  const p = K.makeProject({ files: FILES });
  const [none] = scipChecks(p.dir, {});
  assert.equal(none.level, 'info');
  assert.match(none.detail, /none configured/);
  assert.match(none.detail, /scip-dotnet index/);
  assert.match(none.detail, /scip-typescript index/);
  assert.match(none.detail, /indexers' own commands/);

  const idx = join(p.dir, 'index.scip');
  S.writeIndex(idx, indexBytes());
  const old = new Date(Date.now() - 3 * 86_400_000);
  utimesSync(idx, old, old);
  K.git(p.dir, 'add', '-A');
  K.git(p.dir, 'commit', '-q', '-m', 'index and code');
  const [stale] = scipChecks(p.dir, {});
  assert.equal(stale.level, 'warn');
  assert.match(stale.detail, /covers 4 files/);
  assert.match(stale.detail, /stale/);

  const now = new Date(Date.now() + 60_000);
  utimesSync(idx, now, now);
  const [fresh] = scipChecks(p.dir, {});
  assert.equal(fresh.level, 'ok');
  assert.doesNotMatch(fresh.detail, /stale/);

  const [gone] = scipChecks(p.dir, { index: 'out/none.scip' });
  assert.equal(gone.level, 'warn');
  assert.match(gone.detail, /configured but not found: out\/none\.scip/);
});

test('unknot doctor prints the index check', () => {
  const p = K.makeProject({ files: FILES });
  const r = spawnSync(process.execPath, [join(K.REPO_ROOT, 'bin', 'unknot'), 'doctor', '--json', '--cwd', p.dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home } });
  const c = JSON.parse(r.stdout).checks.find((x) => x.name === 'scip index');
  assert.ok(c, r.stdout.slice(0, 500));
  assert.equal(c.level, 'info');
});

test('an index committed to the repository, or older than a change to a file it covers, is set aside with a notice', async () => {
  const g = (dir, ...args) => spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  const committed = K.makeProject({ files: FILES });
  S.writeIndex(join(committed.dir, 'index.scip'), indexBytes());
  g(committed.dir, 'add', '-f', 'index.scip');
  g(committed.dir, 'commit', '-qm', 'add index');
  const r1 = await map(committed);
  assert.ok((r1.notices ?? []).some((n) => /SCIP index not used: index\.scip is committed to the repository/.test(n)), JSON.stringify(r1.notices));
  assert.equal(importEdge(committed, 'Shop/OrderService.cs', 'Shop/Mailer.cs').use_evidence, 'name-only', 'the lexical result stands');

  const edited = K.makeProject({ files: FILES });
  S.writeIndex(join(edited.dir, 'index.scip'), indexBytes());
  const old = (Date.now() - 3600_000) / 1000;
  utimesSync(join(edited.dir, 'index.scip'), old, old);
  const r2 = await map(edited);
  assert.ok((r2.notices ?? []).some((n) => /SCIP index not used: .*(changed after index\.scip was written|older than commit)/.test(n)), JSON.stringify(r2.notices));
  assert.ok(!importEdge(edited, 'Shop/OrderService.cs', 'Shop/Mailer.cs').unused_evidence);
});

// --- any language: the decision comes from the index alone --------------------------------------------------

const TS_MAILER = "export class Mailer {\n  send(): void {}\n}\n";
const TS_ORDERS = "import { Mailer } from './mailer';\n\nexport class OrderService {\n  @Inject() notifier: Mailer;\n  place(): void {}\n}\n";
const TS_REPORTS = "import { Mailer } from './mailer';\n\nexport class ReportService {\n  @Inject() notifier: Mailer;\n  run(): void { this.notifier.send(); }\n}\n";
// `s` has no declared type: by name alone, `s.notifier` could be either class's member.
const TS_CALLER = "export function go(make: () => any) {\n  const s = make();\n  s.notifier.send();\n}\n";
const TS_FILES = { 'src/mailer.ts': TS_MAILER, 'src/orders.ts': TS_ORDERS, 'src/reports.ts': TS_REPORTS, 'src/caller.ts': TS_CALLER };

/** scip-typescript style symbols: `sym('orders.ts', 'OrderService#', 'notifier.')`. */
const tsSym = (file, ...descriptors) => `scip-typescript npm app 1.0.0 src/\`${file}\`/${descriptors.join('')}`;
const ts = {
  mailer: tsSym('mailer.ts', 'Mailer#'),
  send: tsSym('mailer.ts', 'Mailer#', 'send().'),
  orders: tsSym('orders.ts', 'OrderService#'),
  ordersNotifier: tsSym('orders.ts', 'OrderService#', 'notifier.'),
  reports: tsSym('reports.ts', 'ReportService#'),
  reportsNotifier: tsSym('reports.ts', 'ReportService#', 'notifier.'),
};
const IMPORT = S.ROLE.Import;

/** What scip-typescript would write for TS_FILES: definition ranges as enclosing ranges, imports with the Import role. */
function tsIndex({ orders = [], reports = [] } = {}) {
  return {
    documents: [
      S.document({ path: 'src/mailer.ts', language: 'typescript', occurrences: [def(ts.mailer, 0, { enclosing: [0, 0, 2, 1] }), def(ts.send, 1)] }),
      S.document({
        path: 'src/orders.ts',
        language: 'typescript',
        occurrences: [
          { range: [0, 9, 15], symbol: ts.mailer, roles: IMPORT },
          def(ts.orders, 2, { enclosing: [2, 0, 5, 1] }),
          def(ts.ordersNotifier, 3, { enclosing: [3, 2, 3, 30] }),
          ref(ts.mailer, 3, 0),
          ...orders,
        ],
      }),
      S.document({
        path: 'src/reports.ts',
        language: 'typescript',
        occurrences: [
          { range: [0, 9, 15], symbol: ts.mailer, roles: IMPORT },
          def(ts.reports, 2, { enclosing: [2, 0, 5, 1] }),
          def(ts.reportsNotifier, 3, { enclosing: [3, 2, 3, 30] }),
          ref(ts.mailer, 3, 0),
          ref(ts.reportsNotifier, 4),
          ref(ts.send, 4, 0),
          ...reports,
        ],
      }),
      S.document({ path: 'src/caller.ts', language: 'typescript', occurrences: [] }),
    ],
  };
}

test('TypeScript: the index decides the unused member without any C# path, replacing the name-only guess', async () => {
  const p = K.makeProject({ files: TS_FILES });
  await map(p);
  const lexical = importEdge(p, 'src/orders.ts', 'src/mailer.ts');
  assert.ok(!lexical.declared_only, 'by name, `s.notifier` might be OrderService.notifier');
  assert.equal(lexical.use_evidence, 'name-only');

  S.writeIndex(join(p.dir, 'index.scip'), tsIndex());
  const r = await map(p);
  const e = importEdge(p, 'src/orders.ts', 'src/mailer.ts');
  assert.equal(e.declared_only, true);
  assert.equal(e.unused_member, 'notifier');
  assert.equal(e.member_visibility, 'public');
  assert.equal(e.unused_evidence, 'semantic');
  assert.ok(!e.use_evidence, 'the name-only evidence is replaced, not merged');
  assert.deepEqual(e.names, ['Mailer'], 'the import edge keeps its own facts');
  assert.equal(e.label, 'observed');
  assert.ok(!importEdge(p, 'src/reports.ts', 'src/mailer.ts').declared_only, 'the class that reads its member is not reported');
  assert.equal(moduleAttrs(p, 'src/orders.ts').parse_quality, 'semantic');
  assert.equal(r.scip.covered, 4);
  const cov = r.coverage.find((c) => c.language === 'typescript');
  assert.equal(cov?.quality, 'semantic');
});

test('TypeScript: a write is not a read, a read elsewhere is, and the index overrules the lexical verdict both ways', async () => {
  const p = K.makeProject({ files: TS_FILES });
  const write = [{ range: [4, 4, 12], symbol: ts.ordersNotifier, roles: S.ROLE.WriteAccess }];
  S.writeIndex(join(p.dir, 'index.scip'), tsIndex({ orders: write }));
  await map(p);
  assert.equal(importEdge(p, 'src/orders.ts', 'src/mailer.ts').declared_only, true, 'write-only keeps it unused');

  // The source text shows no read of the member (the lexical verdict would be declared-only once `s` is typed away), the index does.
  const quiet = { ...TS_FILES, 'src/caller.ts': 'export const x = 1;\n' };
  const q = K.makeProject({ files: quiet });
  await map(q);
  assert.equal(importEdge(q, 'src/orders.ts', 'src/mailer.ts').declared_only, true, 'lexically unused');
  const read = [{ range: [4, 4, 12], symbol: ts.ordersNotifier, roles: S.ROLE.ReadAccess }];
  S.writeIndex(join(q.dir, 'index.scip'), tsIndex({ orders: read }));
  await map(q);
  const e = importEdge(q, 'src/orders.ts', 'src/mailer.ts');
  assert.ok(!e.declared_only, 'a read the compiler resolved is a use');
  assert.ok(!e.unused_evidence);
});

test('TypeScript: a constructor parameter property is found by its type-definition relationship; a type used elsewhere keeps the module in use', async () => {
  const files = {
    'src/mailer.ts': TS_MAILER,
    'src/orders.ts': "import { Mailer } from './mailer';\n\nexport class OrderService {\n  constructor(private readonly mailer: Mailer) {}\n}\n",
  };
  const m = tsSym('orders.ts', 'OrderService#', 'mailer.');
  const index = (extra = []) => ({
    documents: [
      S.document({ path: 'src/mailer.ts', language: 'typescript', occurrences: [def(ts.mailer, 0)] }),
      S.document({
        path: 'src/orders.ts',
        language: 'typescript',
        occurrences: [{ range: [0, 9, 15], symbol: ts.mailer, roles: IMPORT }, def(ts.orders, 2, { enclosing: [2, 0, 6, 1] }), def(m, 3), ref(ts.mailer, 3, 0), ...extra],
        symbols: [{ symbol: m, kind: S.KIND.Property, relationships: [{ symbol: ts.mailer, typeDefinition: true }] }],
      }),
    ],
  });
  const p = K.makeProject({ files });
  S.writeIndex(join(p.dir, 'index.scip'), index());
  await map(p);
  const e = importEdge(p, 'src/orders.ts', 'src/mailer.ts');
  assert.equal(e.declared_only, true);
  assert.equal(e.unused_member, 'mailer');
  assert.equal(e.member_visibility, 'public', 'the index does not state visibility: unknown is treated as public');

  // The same type mentioned where nothing is stored (a local) is a use of the module.
  S.writeIndex(join(p.dir, 'index.scip'), index([{ range: [5, 4, 10], symbol: ts.mailer, roles: 0 }]));
  await map(p);
  assert.ok(!importEdge(p, 'src/orders.ts', 'src/mailer.ts').declared_only);
});

test('Python: a parameter stored on self is the member\'s type, and a stored-only parameter does not count as a use', async () => {
  const files = {
    'shop/repo.py': 'class OrderRepo:\n    def save(self):\n        pass\n',
    'shop/orders.py': 'from shop.repo import OrderRepo\n\n\nclass OrderService:\n    def __init__(self, repo: OrderRepo):\n        self._repo = repo\n',
  };
  const py = (...d) => `scip-python python app 1.0.0 shop/${d.join('')}`;
  const repo = py('repo/', 'OrderRepo#');
  const orders = py('orders/', 'OrderService#');
  const attr = py('orders/', 'OrderService#', '_repo.');
  const index = (extra = []) => ({
    documents: [
      S.document({ path: 'shop/repo.py', language: 'python', occurrences: [def(repo, 0, { enclosing: [0, 0, 2, 12] })] }),
      S.document({
        path: 'shop/orders.py',
        language: 'python',
        occurrences: [
          { range: [0, 22, 31], symbol: repo, roles: IMPORT },
          def(orders, 3, { enclosing: [3, 0, 5, 24] }),
          def('local 1', 4, { enclosing: [4, 15, 4, 40] }),
          ref(repo, 4, 0),
          { range: [5, 13, 18], symbol: attr, roles: D | S.ROLE.WriteAccess },
          { range: [5, 21, 25], symbol: 'local 1', roles: S.ROLE.ReadAccess },
          ...extra,
        ],
        symbols: [{ symbol: 'local 1', kind: 37 }],
      }),
    ],
  });
  const p = K.makeProject({ files });
  S.writeIndex(join(p.dir, 'index.scip'), index());
  await map(p);
  const e = importEdge(p, 'shop/orders.py', 'shop/repo.py');
  assert.equal(e.declared_only, true);
  assert.equal(e.unused_member, '_repo');
  assert.equal(e.member_visibility, 'private');
  assert.equal(e.unused_evidence, 'semantic');

  // The parameter is also used (not only stored): the dependency is live.
  S.writeIndex(join(p.dir, 'index.scip'), index([{ range: [6, 8, 12], symbol: 'local 1', roles: S.ROLE.ReadAccess }]));
  await map(p);
  assert.ok(!importEdge(p, 'shop/orders.py', 'shop/repo.py').declared_only, 'a read of the parameter on another line is not a store');
});
