// Incremental linking (#88, FR-001) stores exactly the graph a cold map of the same tree stores
// (FR-002): after a body edit, a symbol rename, a change to a widely used type, a member read from
// another file, a manifest change, and a file deleted and added. Each step is compared, row by row,
// with a cold map of the tree as it then is, and the generic and quality linkers are shown to have
// linked again only part of the files when nothing global changed.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';

after(() => K.cleanup());

const config = K.cfg({ mode: 'plan' });
const map = (p) => mapRepository(p.ctx, { config, configDigest: 'd', history: false });

/** The stored graph, minus what legitimately differs between maps (generation, time, commit). */
function dump(ctx) {
  const all = (sql) => ctx.store.all(sql).map((r) => ({ ...r }));
  return {
    nodes: all('SELECT * FROM nodes ORDER BY id'),
    edges: all('SELECT * FROM edges ORDER BY id'),
    facts: all('SELECT id, kind, subject, predicate, object, attrs, source_type, source_ref, extractor, confidence, scope, contradicts, path, expires_at, digest FROM facts ORDER BY id'),
    derived: all("SELECT kind, key, body FROM derived WHERE kind != '_done' ORDER BY kind, key, body"),
  };
}

const cls = (ns, name, body = '', usings = '') => `${usings}namespace ${ns}\n{\n    public class ${name}\n    {\n${body}\n    }\n}\n`;
// Two types with bases: a cached fact keeps its keys sorted, a fresh one does not, and that is no change.
const pair = (body) => `namespace Shop.Svc\n{\n    public class Zeta : Leaf, IDisposable\n    {\n        public void Dispose() { }\n    }\n    public class Alpha : Leaf\n    {\n        public int A() { ${body} }\n    }\n}\n`;
const csproj = (refs = []) => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup>${refs.map((r) => `<ProjectReference Include="${r}" />`).join('')}</ItemGroup></Project>\n`;
// Two files the clone detector pairs, and one it does not.
const clone = (name) => readFileSync(new URL(`../../fixtures/detectors/clones/${name}`, import.meta.url), 'utf8');

const tree = {
  'Core/Core.csproj': csproj(),
  'Core/Order.cs': cls('Shop.Core', 'Order', '        public int Total() { return 1; }'),
  'Core/Mailer.cs': cls('Shop.Core', 'Mailer', '        public void Send() { }'),
  'Core/Tool.cs': cls('Shop.Core', 'Tool', '        public void Run() { }'),
  'Svc/Svc.csproj': csproj(['../Core/Core.csproj']),
  'Svc/Checkout.cs': cls('Shop.Svc', 'Checkout', '        public int Go(Order o) { return o.Total(); }', 'using Shop.Core;\n'),
  'Svc/Notify.cs': cls('Shop.Svc', 'Notify', '        [Dependency]\n        public Mailer Mailer { get; set; }', 'using Shop.Core;\n'),
  'Svc/Billing.cs': cls('Shop.Svc', 'Billing', '        public int Bill(Order o) { var t = new Tool(); t.Run(); return o.Total(); }', 'using Shop.Core;\n'),
  'Svc/Leaf.cs': cls('Shop.Svc', 'Leaf', '        public int N() { return 2; }'),
  'Svc/Pair.cs': pair('return 1;'),
  'web/orders.js': clone('orders.js'),
  'web/invoices.js': clone('invoices.js'),
  'web/unrelated.js': clone('unrelated.js'),
  'java/com/x/Repo.java': 'package com.x;\n\npublic class Repo { public int save() { return 1; } }\n',
  'java/com/x/Service.java': 'package com.x;\n\npublic class Service { private final Repo repo = new Repo(); public int run() { return repo.save(); } }\n',
  'go.mod': 'module example.com/shop\n\ngo 1.22\n',
  'pkg/a/a.go': 'package a\n\nfunc A() int { return 1 }\n',
  'pkg/b/b.go': 'package b\n\nimport "example.com/shop/pkg/a"\n\nfunc B() int { return a.A() }\n',
};

const write = (dir, path, body) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
};

test('an incremental map links again only what a change reaches, and stores what a cold map stores', async () => {
  const files = { ...tree };
  const p = K.makeProject({ files });
  const first = await map(p);
  assert.equal(first.link?.generic?.relinked, first.link?.generic?.modules, 'the first map links every file');

  const step = async (name, edit) => {
    edit(files);
    for (const [path, body] of Object.entries(files)) write(p.dir, path, body);
    K.git(p.dir, 'add', '-A');
    K.git(p.dir, 'commit', '-q', '-m', name);
    const delta = await map(p);
    const cold = K.makeProject({ files });
    await map(cold);
    const a = dump(p.ctx);
    const b = dump(cold.ctx);
    for (const k of Object.keys(b)) assert.deepEqual(a[k], b[k], `${name}: ${k} match a cold map`);
    return delta;
  };
  const del = (path) => (f) => {
    delete f[path];
    rmSync(join(p.dir, path));
  };

  const body = await step('body edit', (f) => { f['Svc/Leaf.cs'] = cls('Shop.Svc', 'Leaf', '        public int N() { return 3; }'); });
  assert.ok(body.link.generic.relinked < body.link.generic.modules, `a body edit links few files again (${JSON.stringify(body.link)})`);
  assert.ok(body.link.quality.relinked < body.link.quality.modules);

  const twoTypes = await step('a body edit in a file of two types', (f) => { f['Svc/Pair.cs'] = pair('return 2;'); });
  assert.ok(twoTypes.link.generic.relinked < twoTypes.link.generic.modules, `the same types and bases link few files again (${JSON.stringify(twoTypes.link)})`);

  const reach = await step('a member read from another file', (f) => {
    f['Svc/Leaf.cs'] = cls('Shop.Svc', 'Leaf', '        public void N(Notify n) { n.Mailer.Send(); }', 'using Shop.Core;\n');
  });
  assert.ok(reach.link.generic.relinked < reach.link.generic.modules);
  const notify = p.ctx.store.get("SELECT attrs FROM edges WHERE src = 'module:Svc/Notify.cs' AND dst = 'module:Core/Mailer.cs' AND type = 'IMPORTS'");
  assert.ok(notify && !JSON.parse(notify.attrs).declared_only, 'the unchanged Notify.cs was linked again: its member is now read');

  await step('a widely used type changes', (f) => { f['Core/Order.cs'] = cls('Shop.Core', 'Order', '        public int Total() { return 2; }\n        public int Tax() { return 1; }'); });
  await step('a symbol rename', (f) => {
    f['Core/Tool.cs'] = cls('Shop.Core', 'Gadget', '        public void Run() { }');
    f['Svc/Billing.cs'] = cls('Shop.Svc', 'Billing', '        public int Bill(Order o) { var t = new Gadget(); t.Run(); return o.Total(); }', 'using Shop.Core;\n');
  });
  const clones = () => p.ctx.store.all("SELECT id FROM nodes WHERE attrs LIKE '%\"clones\"%' ORDER BY id").map((r) => r.id);
  assert.deepEqual(clones(), ['module:web/invoices.js', 'module:web/orders.js']);
  await step('a clone is broken', (f) => { f['web/invoices.js'] = 'export const invoices = [];\n'; });
  assert.deepEqual(clones(), [], 'the unchanged orders.js lost its clone');
  await step('a manifest change', (f) => { f['Svc/Svc.csproj'] = csproj(); });
  await step('a file deleted and one added', (f) => {
    del('Svc/Checkout.cs')(f);
    f['Svc/Refund.cs'] = cls('Shop.Svc', 'Refund', '        public int R(Order o) { return o.Total(); }', 'using Shop.Core;\n');
    f['pkg/c/c.go'] = 'package c\n\nimport "example.com/shop/pkg/b"\n\nfunc C() int { return b.B() }\n';
  });
  await step('a Java and a Go edit', (f) => {
    f['java/com/x/Repo.java'] = 'package com.x;\n\npublic class Repo { public int save() { return 2; } public int load() { return 3; } }\n';
    f['pkg/a/a.go'] = 'package a\n\nfunc A() int { return 2 }\n';
  });
});
