import assert from 'node:assert/strict';
import { test } from 'node:test';
import { edgeList, runAdapter, runFixture } from './helpers.mjs';

const importsOf = (graph, from) => graph.out(from, 'IMPORTS').map((e) => `${e.to} ${e.attrs.kind} [${e.attrs.names}] @${e.attrs.line}`).sort();

test('TS monorepo: workspace, tsconfig paths, extends, TS ESM .js specifiers, builtins and npm packages', () => {
  const { graph } = runFixture('monorepo');
  const idx = 'module:packages/checkout/src/index.ts';
  assert.deepEqual(importsOf(graph, idx), [
    'dependency:left-pad static [default] @5',
    'dependency:node:fs static [readFileSync] @6',
    'module:packages/checkout/src/cart.ts static [Cart,addItem] @3',
    'module:packages/checkout/src/totals.ts static [total] @4',
    'module:packages/pricing/src/index.ts static [Discount,Price,priceWithTax] @1',
  ]);
  assert.deepEqual(graph.node(idx).attrs.unresolved, [{ specifier: './missing', line: 7, reason: 'relative' }]);
  assert.deepEqual(graph.out(idx, 'IMPORTS').find((e) => e.to.endsWith('pricing/src/index.ts')).attrs.kinds, ['static', 'type']);
  assert.deepEqual(importsOf(graph, 'module:packages/checkout/src/totals.ts'), ['module:packages/checkout/src/cart.ts type [Cart] @1']);
  assert.deepEqual(importsOf(graph, 'module:packages/pricing/src/index.ts'), ['module:packages/pricing/src/tax.ts static [vat] @1']);
  assert.deepEqual(graph.nodes('dependency').map((n) => n.id).sort(), [
    'dependency:@acme/pricing', 'dependency:@types/node', 'dependency:left-pad', 'dependency:node:fs', 'dependency:node:test', 'dependency:typescript',
  ]);
  assert.equal(graph.node('dependency:node:fs').attrs.builtin, true);
});

test('TS monorepo: calls, instantiation, inheritance, tests, containment', () => {
  const { graph } = runFixture('monorepo');
  assert.deepEqual(edgeList(graph, 'CALLS'), [
    'function:packages/checkout/src/index.ts#checkout -> function:packages/checkout/src/cart.ts#addItem',
    'function:packages/checkout/src/index.ts#checkout -> function:packages/checkout/src/totals.ts#total',
    'function:packages/checkout/src/index.ts#checkout -> function:packages/pricing/src/index.ts#priceWithTax',
    'function:packages/pricing/src/index.ts#priceWithTax -> function:packages/pricing/src/tax.ts#vat',
    'method:packages/checkout/src/index.ts#Checkout.run -> method:packages/checkout/src/index.ts#Checkout.helper',
  ]);
  assert.deepEqual(edgeList(graph, 'INSTANTIATES'), ['function:packages/checkout/src/index.ts#checkout -> class:packages/pricing/src/index.ts#Discount']);
  assert.deepEqual(edgeList(graph, 'EXTENDS'), ['class:packages/checkout/src/index.ts#Checkout -> class:packages/pricing/src/index.ts#Discount']);
  assert.deepEqual(edgeList(graph, 'IMPLEMENTS'), []); // Runnable is declared nowhere in the repository
  assert.deepEqual(edgeList(graph, 'TESTS'), ['module:packages/checkout/src/checkout.test.ts -> module:packages/checkout/src/index.ts']);
  assert.deepEqual(edgeList(graph, 'DEPENDS_ON').filter((e) => e.includes('-> package:')), ['package:@acme/checkout -> package:@acme/pricing']);
  const owned = graph.children('package:@acme/checkout', 'module').map((n) => n.id).sort();
  assert.deepEqual(owned, [
    'module:packages/checkout/src/cart.ts', 'module:packages/checkout/src/checkout.test.ts', 'module:packages/checkout/src/index.ts', 'module:packages/checkout/src/totals.ts',
  ]);
  assert.deepEqual(graph.children('package:acme-root', 'module'), []);
  assert.equal(graph.parent('module:packages/pricing/src/tax.ts').id, 'package:@acme/pricing');
  const call = graph.edges('CALLS').find((e) => e.to.endsWith('#priceWithTax'));
  assert.deepEqual([call.attrs.line, call.provenance[0].confidence], [11, 'medium']);
});

test('Express API: require edges, CommonJS export binding resolves calls, endpoints are exposed', () => {
  const { graph } = runFixture('express-api');
  assert.deepEqual(importsOf(graph, 'module:src/server.js'), [
    'dependency:express require [*] @1',
    'dependency:node:child_process require [exec] @2',
    'module:src/db.js require [*] @3',
  ]);
  assert.deepEqual(edgeList(graph, 'CALLS'), ['function:src/server.js#createOrder -> function:src/db.js#execute']);
  assert.deepEqual(graph.out('module:src/server.js', 'EXPOSES').map((e) => e.to).sort(), [
    'endpoint:GET /api/orders/:id', 'endpoint:GET /health', 'endpoint:GET /items', 'endpoint:POST /api/orders', 'endpoint:POST /items',
  ]);
  const mod = graph.node('module:src/server.js').attrs;
  assert.deepEqual(mod.env_reads, ['PORT']);
  assert.deepEqual(mod.sql.map((s) => s.line), [9, 27]);
  assert.deepEqual(mod.security_signals.map((s) => `${s.kind}@${s.line}`), ['sql-interpolation@9', 'exec-nonliteral@28']);
});

test('Next.js app router: route groups dropped, dynamic segments kept, handlers and pages', () => {
  const { graph } = runFixture('nextjs-app');
  assert.deepEqual(graph.nodes('route').map((n) => n.id).sort(), ['route:/', 'route:/about', 'route:/dashboard/[id]', 'route:/legacy']);
  assert.deepEqual(edgeList(graph, 'RENDERS'), [
    'route:/ -> module:app/(marketing)/page.tsx',
    'route:/about -> module:app/(marketing)/about/page.tsx',
    'route:/dashboard/[id] -> module:app/dashboard/[id]/page.tsx',
    'route:/legacy -> module:pages/legacy.tsx',
  ]);
  assert.deepEqual(graph.nodes('endpoint').map((n) => n.id).sort(), ['endpoint:ALL /api/hello', 'endpoint:GET /api/users/:id', 'endpoint:POST /api/users/:id']);
  assert.deepEqual(graph.out('module:app/api/users/[id]/route.ts', 'EXPOSES').map((e) => e.to).sort(), ['endpoint:GET /api/users/:id', 'endpoint:POST /api/users/:id']);
  assert.equal(graph.node('module:app/dashboard/[id]/page.tsx').attrs.directives[0], 'use client');
});

test('React Router SPA: routes render resolved components, cross-feature imports, stores', () => {
  const { graph } = runFixture('react-spa');
  assert.deepEqual(edgeList(graph, 'RENDERS'), [
    'route:/ -> module:src/features/home/Home.tsx',
    'route:/app -> module:src/features/home/Home.tsx',
    'route:/app -> module:src/shared/Layout.tsx',
    'route:/app/profile -> module:src/features/user/Profile.tsx',
    'route:/cart -> module:src/features/cart/CartPage.tsx',
    'route:/cart/checkout -> module:src/features/cart/Checkout.tsx',
  ]);
  const layout = graph.out('route:/app', 'RENDERS').find((e) => e.to.endsWith('Layout.tsx'));
  assert.equal(layout.attrs.layout, true);
  const cross = edgeList(graph, 'IMPORTS').filter((e) => e.includes('features/cart') && e.includes('features/user') || e.includes('features/user/Profile') && e.includes('features/cart'));
  assert.deepEqual(cross, [
    'module:src/features/cart/CartPage.tsx -> module:src/features/user/userSlice.ts',
    'module:src/features/user/Profile.tsx -> module:src/features/cart/cartSlice.ts',
  ]);
  assert.deepEqual(graph.nodes('store').map((n) => n.id).sort(), [
    'store:src/features/cart/cartSlice.ts#cart', 'store:src/features/user/userSlice.ts#user', 'store:src/store.ts#store',
  ]);
  assert.deepEqual(edgeList(graph, 'CALLS'), ['function:src/features/cart/CartPage.tsx#CartPage -> function:src/features/user/userSlice.ts#selectUserName']);
});

test('tokenizer trap fixtures keep exact function boundaries and ignore injected comment text', () => {
  const { graph, facts } = runFixture('tricky');
  const fn = (id) => graph.node(id).attrs;
  assert.deepEqual([fn('function:regex.js#sentinel').start_line, fn('function:regex.js#sentinel').end_line], [9, 14]);
  assert.deepEqual([fn('function:templates.js#sentinel').start_line, fn('function:templates.js#sentinel').end_line], [8, 13]);
  assert.deepEqual([fn('function:jsx.tsx#sentinel').start_line, fn('function:jsx.tsx#sentinel').end_line], [20, 25]);
  assert.deepEqual([fn('function:comments.js#sentinel').start_line, fn('function:comments.js#sentinel').end_line], [12, 15]);
  assert.deepEqual(graph.nodes('function').filter((n) => n.path === 'comments.js').map((n) => n.name).sort(), ['real', 'sentinel']);
  assert.deepEqual([fn('function:regex.js#pick').cyclomatic, fn('function:regex.js#pick').cognitive], [2, 1]);
  const panel = fn('function:jsx.tsx#Panel');
  assert.deepEqual([panel.cyclomatic, panel.cognitive, panel.max_nesting], [5, 4, 1]);
  assert.equal(fn('function:jsx.tsx#id').kind, 'arrow');
  const repo = fn('method:classes.ts#Repo.save');
  assert.deepEqual([repo.cyclomatic, repo.cognitive], [3, 2]);
  assert.equal(graph.node('module:comments.js').attrs.parse_quality, 'ok');
  assert.deepEqual(graph.node('module:comments.js').attrs.security_signals, []);
  assert.ok(!JSON.stringify(facts).includes('rm -rf'));
  assert.ok(!JSON.stringify(facts).includes('ignore previous'));
});

test('degraded files return partial facts with parse_quality degraded and low confidence', () => {
  const { graph, facts } = runFixture('tricky');
  const mod = graph.node('module:weird.js');
  assert.equal(mod.attrs.parse_quality, 'degraded');
  assert.ok(graph.node('function:weird.js#fine'));
  for (const f of facts.filter((x) => x.kind === 'node' && x.path === 'weird.js')) assert.equal(f.provenance.confidence, 'low', f.id);
});

test('resolution: extension probing, index files, tsconfig paths (relative to an inherited baseUrl) and extends chains', () => {
  const t = (obj) => new Map(Object.entries(obj));
  const { graph } = runAdapter(t({
    'tsconfig.json': '{ "extends": "./tsconfig.base", "compilerOptions": { "paths": { "@lib/*": ["../lib/*"], "@lib/special": ["../special.ts"] } } }',
    'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": "src" } }',
    'src/a.ts': "import './b.js'; import './c'; import './dir'; import '@lib/x'; import '@lib/special'; import 'util/deep'; import './data.json'; import '@nope/y'; import './gone';",
    'src/b.ts': 'export const b = 1;',
    'src/c.tsx': 'export const c = 1;',
    'src/dir/index.mts': 'export const d = 1;',
    'lib/x.ts': 'export const x = 1;',
    'special.ts': 'export const s = 1;',
    'src/util/deep.ts': 'export const u = 1;',
    'src/data.json': '{}',
  }));
  assert.deepEqual(importsOf(graph, 'module:src/a.ts'), [
    'dependency:@nope/y static [] @1',
    'module:lib/x.ts static [] @1',
    'module:special.ts static [] @1',
    'module:src/b.ts static [] @1',
    'module:src/c.tsx static [] @1',
    'module:src/dir/index.mts static [] @1',
    'module:src/util/deep.ts static [] @1',
  ]);
  assert.deepEqual(graph.node('module:src/a.ts').attrs.unresolved.map((u) => u.specifier), ['./gone']);
});

test('resolution: an alias that matches tsconfig paths but no file is unresolved, not an npm package', () => {
  const { graph } = runAdapter(new Map(Object.entries({
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@app/*": ["src/*"] } } }',
    'src/a.ts': "import '@app/missing';",
  })));
  assert.deepEqual(graph.node('module:src/a.ts').attrs.unresolved.map((u) => u.specifier), ['@app/missing']);
  assert.deepEqual(graph.nodes('dependency'), []);
});

test('resolution: workspace package subpaths and scoped npm names', () => {
  const t = new Map(Object.entries({
    'package.json': '{ "name": "root", "workspaces": ["packages/*"] }',
    'packages/ui/package.json': '{ "name": "@org/ui", "exports": { ".": "./dist/index.js", "./button": "./dist/button.js" } }',
    'packages/ui/src/index.ts': 'export * from "./button.js"; export { default as Card } from "./card";',
    'packages/ui/src/button.ts': 'export function Button() { return 1; }',
    'packages/ui/src/card.ts': 'export default function Card() { return 2; }',
    'apps/web/src/app.ts': "import { Button } from '@org/ui'; import { Card } from '@org/ui'; import B from '@org/ui/button'; import x from '@scope/pkg/sub/path'; import y from 'lodash/fp'; import z from 'fs/promises';\nexport function go() { Button(); Card(); }",
  }));
  const { graph } = runAdapter(t);
  assert.deepEqual(importsOf(graph, 'module:apps/web/src/app.ts'), [
    'dependency:@scope/pkg static [default] @1',
    'dependency:lodash static [default] @1',
    'dependency:node:fs/promises static [default] @1',
    'module:packages/ui/src/button.ts static [default] @1',
    'module:packages/ui/src/index.ts static [Button,Card] @1',
  ]);
  // Button is re-exported with `export *`, Card with `export { default as Card } from`.
  assert.deepEqual(edgeList(graph, 'CALLS'), [
    'function:apps/web/src/app.ts#go -> function:packages/ui/src/button.ts#Button',
    'function:apps/web/src/app.ts#go -> function:packages/ui/src/card.ts#Card',
  ]);
});

test('link is deterministic regardless of the order files are supplied', () => {
  const texts = new Map([
    ['src/a.ts', "import { b } from './b'; export function a() { b(); }"],
    ['src/b.ts', 'export function b() {}'],
    ['package.json', '{ "name": "p" }'],
  ]);
  const reversed = new Map([...texts].reverse());
  const one = runAdapter(texts).linked;
  const two = runAdapter(reversed).linked;
  assert.deepEqual(one, two);
  assert.ok(one.length > 0);
});

test('import type and export type ... from edges are marked type_only; mixed imports are not', () => {
  const { graph } = runAdapter(new Map([
    ['a.ts', "import type { B } from './b';\nimport { type C } from './c';\nexport type { D } from './d';\nimport { e, type F } from './e';\nexport const a = e;\n"],
    ['b.ts', "import { a } from './a';\nexport type B = typeof a;\n"],
    ['c.ts', 'export type C = 1;\n'],
    ['d.ts', 'export type D = 1;\n'],
    ['e.ts', 'export const e = 1;\nexport type F = 2;\n'],
  ]));
  const edge = (to) => graph.out('module:a.ts', 'IMPORTS').find((x) => x.to === `module:${to}`).attrs;
  for (const t of ['b.ts', 'c.ts', 'd.ts']) assert.equal(edge(t).type_only, true, t);
  assert.equal(edge('e.ts').type_only, undefined);
  assert.equal(graph.out('module:b.ts', 'IMPORTS')[0].attrs.type_only, undefined);
});

test('.vue single-file components: script and script setup blocks are read for imports', () => {
  const { graph, factsByFile } = runAdapter(new Map([
    ['src/store.ts', 'export const store = 1;\n'],
    ['src/util.ts', 'export const util = 1;\n'],
    ['src/types.ts', 'export type T = 1;\n'],
    ['src/View.vue', "<template>\n  <div>{{ store }}</div>\n</template>\n\n<script lang=\"ts\">\nimport { util } from './util';\nexport default { name: 'View' };\n</script>\n\n<script setup lang=\"ts\">\nimport { store } from './store';\nimport type { T } from './types';\nconst x: T = 1;\n</script>\n"],
    ['src/Plain.vue', "<template><p/></template>\n<script>\nimport { util } from './util.ts';\nexport default {};\n</script>\n"],
    ['src/Empty.vue', '<template><p/></template>\n'],
    ['src/main.ts', "import View from './View.vue';\nexport default View;\n"],
  ]));
  const to = (from) => graph.out(`module:${from}`, 'IMPORTS').map((e) => `${e.to} @${e.attrs.line}${e.attrs.type_only ? ' type' : ''}`).sort();
  assert.deepEqual(to('src/View.vue'), ['module:src/store.ts @11', 'module:src/types.ts @12 type', 'module:src/util.ts @6']);
  assert.deepEqual(to('src/Plain.vue'), ['module:src/util.ts @3']);
  assert.deepEqual(to('src/main.ts'), ['module:src/View.vue @1']);
  assert.equal(factsByFile.get('src/Empty.vue').length, 0);
  assert.equal(graph.in('module:src/store.ts', 'IMPORTS').length, 1);
});
