import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import adapter from '../../../../adapters/language/javascript/index.mjs';
import { matchAny } from '../../../../runtime/core/glob.mjs';
import { FIXTURES, extractOne, fnAttrs, moduleAttrs } from './helpers.mjs';

const fixture = (...p) => readFileSync(join(FIXTURES, ...p), 'utf8');
const nodes = (facts, type) => facts.filter((f) => f.kind === 'node' && f.type === type).map((f) => f.id).sort();
const edges = (facts, type) => facts.filter((f) => f.kind === 'edge' && f.type === type).map((f) => `${f.from} -> ${f.to}`).sort();

test('adapter contract: identity and capabilities', () => {
  assert.equal(adapter.id, 'javascript');
  assert.equal(adapter.version, '0.1.8');
  assert.equal(adapter.kind, 'language');
  assert.deepEqual(adapter.capabilities.executes, []);
  assert.equal(adapter.capabilities.network, false);
  for (const p of ['a.js', 'a/b.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx', 'package.json', 'pkg/package.json', 'tsconfig.json', 'a/tsconfig.build.json', 'jsconfig.json', 'src/routes/x/+page.svelte']) {
    assert.ok(matchAny(p, adapter.capabilities.files), p);
  }
  assert.equal(typeof adapter.extract, 'function');
  assert.equal(typeof adapter.link, 'function');
});

test('every fact carries provenance with the extractor id and a path:line source_ref', () => {
  const facts = extractOne('src/a.ts', 'export function f() { return 1; }\nexport class C {}');
  for (const f of facts) {
    assert.equal(f.provenance.extractor, 'javascript@0.1.8');
    assert.match(f.provenance.source_ref, /^src\/a\.ts:\d+$/);
    assert.equal(f.provenance.source_type, 'ast');
  }
  assert.equal(facts.find((f) => f.id === 'class:src/a.ts#C').provenance.source_ref, 'src/a.ts:2');
});

test('imports of every kind are stored raw on the module', () => {
  const src = [
    "import a, { b as c, type D } from './one';",
    "import * as ns from './two';",
    "import './side';",
    "import type { T } from './types';",
    "export * from './star';",
    "export { x, y as z } from './named';",
    "export type { U } from './u';",
    "const lazy = () => import('./lazy');",
    "const { p, q: r } = require('./cjs');",
    "const whole = require('plain');",
    "import eq = require('legacy');",
  ].join('\n');
  const imports = moduleAttrs(extractOne('i.ts', src), 'i.ts').imports.map((i) => [i.specifier, i.kind, i.names, i.line]);
  assert.deepEqual(imports, [
    ['./one', 'static', ['D', 'b', 'default'], 1],
    ['./two', 'static', ['*'], 2],
    ['./side', 'static', [], 3],
    ['./types', 'type', ['T'], 4],
    ['./star', 'reexport', ['*'], 5],
    ['./named', 'reexport', ['x', 'y'], 6],
    ['./u', 'type', ['U'], 7],
    ['./lazy', 'dynamic', [], 8],
    ['./cjs', 'require', ['p', 'q'], 9],
    ['plain', 'require', ['*'], 10],
    ['legacy', 'require', ['*'], 11],
  ]);
  const bindings = moduleAttrs(extractOne('i.ts', src), 'i.ts').imports[0].bindings;
  assert.deepEqual(bindings.map((b) => `${b.imported}>${b.local}`), ['default>a', 'b>c', 'D>D']);
});

test('exports list names, kinds and lines', () => {
  const src = [
    'export function f() {}',
    'export const g = () => 1, h = 2;',
    'export class K {}',
    'export default class Main {}',
    'const loc = 1;',
    'export { loc as renamed };',
    'export interface I {}',
    'export type T = string;',
    'export enum E { A }',
  ].join('\n');
  const ex = moduleAttrs(extractOne('e.ts', src), 'e.ts').exports.map((e) => `${e.name}:${e.kind}@${e.line}`);
  assert.deepEqual(ex, [
    'f:function@1', 'g:function@2', 'h:variable@2', 'K:class@3', 'default:class@4', 'renamed:value@6', 'I:interface@7', 'T:type@8', 'E:enum@9',
  ]);
});

test('CommonJS exports and module.exports objects', () => {
  const src = 'function a() {}\nexports.b = function () {};\nmodule.exports.c = () => 1;\n';
  const facts = extractOne('cjs.js', src);
  assert.deepEqual(moduleAttrs(facts, 'cjs.js').exports.map((e) => e.name), ['b', 'c']);
  assert.deepEqual(nodes(facts, 'function'), ['function:cjs.js#a', 'function:cjs.js#b', 'function:cjs.js#c']);
});

test('classes record extends, implements, decorators and method containment', () => {
  const src = '@Injectable()\nexport class A extends B.C<T> implements I, J<K> {\n  m() {}\n}\nclass Inner { static s() {} }';
  const facts = extractOne('cl.ts', src);
  const a = fnAttrs(facts, 'class:cl.ts#A');
  assert.equal(a.extends, 'B.C');
  assert.deepEqual(a.implements, ['I', 'J']);
  assert.deepEqual(a.decorators, ['Injectable']);
  assert.equal(a.exported, true);
  assert.deepEqual(edges(facts, 'CONTAINS'), [
    'class:cl.ts#A -> method:cl.ts#A.m', 'class:cl.ts#Inner -> method:cl.ts#Inner.s', 'module:cl.ts -> class:cl.ts#A', 'module:cl.ts -> class:cl.ts#Inner',
  ]);
});

test('nested functions are contained by their parent function', () => {
  const facts = extractOne('n.js', 'function outer() { function inner() {} }');
  assert.deepEqual(edges(facts, 'CONTAINS'), ['function:n.js#outer -> function:n.js#outer.inner', 'module:n.js -> function:n.js#outer']);
});

test('calls are recorded per function: identifiers, member calls and new', () => {
  const src = 'function f() { a(); b.c(); this.d(); new E(); x.y.z(); }';
  const calls = fnAttrs(extractOne('c.js', src), 'function:c.js#f').calls;
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b.c', 'this.d', 'E', 'x.y.z']);
  assert.equal(calls[3].new, true);
});

test('calls are bounded to 500 per function', () => {
  const body = Array.from({ length: 700 }, (_, i) => `f${i}();`).join('\n');
  const calls = fnAttrs(extractOne('big.js', `function f() {\n${body}\n}`), 'function:big.js#f').calls;
  assert.equal(calls.length, 500);
});

test('env reads, SQL and directives', () => {
  const src = [
    "'use client';",
    'const a = process.env.API_URL;',
    "const b = process.env['TOKEN'];",
    'const { HOST, PORT } = process.env;',
    'const c = import.meta.env.VITE_X;',
    "const q = 'SELECT id, name FROM users WHERE id = 1';",
    'const long = `UPDATE users SET name = ${n} WHERE id = 1`;',
    "const prose = 'Select the items from the list';",
  ].join('\n');
  const m = moduleAttrs(extractOne('env.ts', src), 'env.ts');
  assert.deepEqual(m.env_reads, ['API_URL', 'HOST', 'PORT', 'TOKEN', 'VITE_X']);
  assert.deepEqual(m.sql.map((s) => [s.line, s.text]), [
    [6, 'SELECT id, name FROM users WHERE id = 1'],
    [7, 'UPDATE users SET name = ${n} WHERE id = 1'],
  ]);
  assert.deepEqual(m.directives, ['use client']);
});

test('SQL text is capped at 500 characters', () => {
  const m = moduleAttrs(extractOne('s.js', `const q = 'SELECT ${'a, '.repeat(400)}b FROM t';`), 's.js');
  assert.equal(m.sql[0].text.length, 500);
});

test('security signals', () => {
  const m = moduleAttrs(extractOne('frameworks/security.jsx', fixture('frameworks', 'security.jsx')), 'frameworks/security.jsx');
  assert.deepEqual(m.security_signals.map((s) => `${s.kind}@${s.line}`), [
    'exec-nonliteral@5', 'spawn-shell@7', 'eval@8', 'new-function@9', 'vm-run@10', 'inner-html@11', 'document-write@12',
    'sql-interpolation@13', 'dangerously-set-inner-html@15',
  ].sort((a, b) => Number(a.split('@')[1]) - Number(b.split('@')[1])));
});

test('exec is only flagged when child_process is imported and the command is not a literal', () => {
  const noImport = moduleAttrs(extractOne('r.js', 'function f(re, s) { return re.exec(s); }'), 'r.js');
  assert.deepEqual(noImport.security_signals, []);
  const literal = moduleAttrs(extractOne('l.js', "const { exec } = require('node:child_process');\nexec('ls -la');\nexec(`pwd`);"), 'l.js');
  assert.deepEqual(literal.security_signals, []);
  const dynamic = moduleAttrs(extractOne('d.js', "import { execSync } from 'child_process';\nexecSync(cmd);"), 'd.js');
  assert.deepEqual(dynamic.security_signals.map((s) => s.kind), ['exec-nonliteral']);
});

test('express style endpoints, router.route chains and non-routes', () => {
  const facts = extractOne('src/server.js', fixture('express-api', 'src', 'server.js'));
  assert.deepEqual(nodes(facts, 'endpoint'), [
    'endpoint:GET /health', 'endpoint:GET /items', 'endpoint:GET /orders/:id', 'endpoint:POST /items', 'endpoint:POST /orders',
  ]);
  assert.deepEqual(edges(facts, 'EXPOSES').length, 5);
  const post = facts.find((f) => f.id === 'endpoint:POST /orders');
  assert.equal(post.attrs.handler, 'createOrder');
  assert.equal(post.provenance.confidence, 'medium');
  const plain = extractOne('client.js', "axios.get('/users');\napi.get('/x', { params: {} });\nmap.get('/k');");
  assert.deepEqual(nodes(plain, 'endpoint'), []);
});

test('fastify route objects and shorthand methods', () => {
  const facts = extractOne('f.js', fixture('frameworks', 'fastify.js'));
  assert.deepEqual(nodes(facts, 'endpoint'), ['endpoint:GET /ping', 'endpoint:GET /status', 'endpoint:POST /things', 'endpoint:PUT /things']);
});

test('NestJS controllers', () => {
  const facts = extractOne('u.controller.ts', fixture('frameworks', 'nest.ts'));
  assert.deepEqual(nodes(facts, 'endpoint'), ['endpoint:GET /users', 'endpoint:GET /users/:id', 'endpoint:POST /users/bulk']);
  assert.equal(facts.find((f) => f.id === 'endpoint:GET /users/:id').attrs.handler, 'UsersController.one');
});

test('Next.js route handlers and pages by path convention', () => {
  const route = extractOne('app/api/users/[id]/route.ts', fixture('nextjs-app', 'app', 'api', 'users', '[id]', 'route.ts'));
  assert.deepEqual(nodes(route, 'endpoint'), ['endpoint:GET /api/users/:id', 'endpoint:POST /api/users/:id']);
  const api = extractOne('pages/api/hello.ts', fixture('nextjs-app', 'pages', 'api', 'hello.ts'));
  assert.deepEqual(nodes(api, 'endpoint'), ['endpoint:ALL /api/hello']);
  assert.deepEqual(api.find((f) => f.id === 'endpoint:ALL /api/hello').attrs.methods, ['POST']);
  const page = (path, body = 'export default function P() { return null; }') => nodes(extractOne(path, body), 'route');
  assert.deepEqual(page('app/(shop)/cart/page.tsx'), ['route:/cart']);
  assert.deepEqual(page('src/app/[slug]/edit/page.js'), ['route:/[slug]/edit']);
  assert.deepEqual(page('app/page.tsx'), ['route:/']);
  assert.deepEqual(page('pages/index.tsx'), ['route:/']);
  assert.deepEqual(page('pages/blog/[id].tsx'), ['route:/blog/[id]']);
  assert.deepEqual(page('pages/_app.tsx'), []);
  assert.deepEqual(page('pages/_document.tsx'), []);
  assert.deepEqual(page('app/page.tsx', 'export const x = 1;'), []);
});

test('SvelteKit routes derive from the path only', () => {
  const facts = extractOne('src/routes/(app)/blog/[slug]/+page.svelte', '<script>let x = 1;</script>\n<h1>hi</h1>\n');
  assert.deepEqual(nodes(facts, 'route'), ['route:/blog/[slug]']);
  assert.deepEqual(edges(facts, 'RENDERS'), ['route:/blog/[slug] -> module:src/routes/(app)/blog/[slug]/+page.svelte']);
  assert.equal(moduleAttrs(facts, 'src/routes/(app)/blog/[slug]/+page.svelte').language, 'svelte');
  assert.deepEqual(nodes(extractOne('src/routes/api/x/+server.ts', 'export const GET = () => new Response();'), 'endpoint'), ['endpoint:GET /api/x']);
});

test('React Router: JSX routes nest, createBrowserRouter children join paths', () => {
  const app = extractOne('src/App.tsx', fixture('react-spa', 'src', 'App.tsx'));
  assert.deepEqual(nodes(app, 'route'), ['route:/app', 'route:/app/profile']);
  assert.deepEqual(app.find((f) => f.id === 'route:/app').attrs.components.map((c) => [c.name, c.layout]), [['Layout', true], ['Home', false]]);
  const main = extractOne('src/main.tsx', fixture('react-spa', 'src', 'main.tsx'));
  assert.deepEqual(nodes(main, 'route'), ['route:/', 'route:/cart', 'route:/cart/checkout']);
  assert.equal(main.find((f) => f.id === 'route:/cart/checkout').attrs.component, 'Checkout');
});

test('Vue Router and Angular route tables', () => {
  const vue = extractOne('r.ts', fixture('frameworks', 'vue-routes.ts'));
  assert.deepEqual(nodes(vue, 'route'), ['route:/', 'route:/about']);
  assert.equal(vue.find((f) => f.id === 'route:/about').attrs.import_spec, './About.vue');
  const ng = extractOne('a.ts', fixture('frameworks', 'angular-routes.ts'));
  assert.deepEqual(nodes(ng, 'route'), ['route:/', 'route:/admin', 'route:/admin/users']);
  assert.equal(ng.find((f) => f.id === 'route:/').attrs.component, 'HomeComponent');
  const notRoutes = extractOne('x.ts', "const routes = [{ path: '/a', handler }];");
  assert.deepEqual(nodes(notRoutes, 'route'), []);
});

test('messaging facts are inference with medium confidence', () => {
  const facts = extractOne('m.ts', fixture('frameworks', 'messaging.ts'));
  assert.deepEqual(nodes(facts, 'topic'), ['topic:events', 'topic:orders.created', 'topic:payments', 'topic:refunds']);
  assert.deepEqual(nodes(facts, 'queue'), ['queue:emails', 'queue:reports']);
  assert.deepEqual(edges(facts, 'PUBLISHES'), ['module:m.ts -> queue:emails', 'module:m.ts -> queue:reports', 'module:m.ts -> topic:events', 'module:m.ts -> topic:orders.created']);
  assert.deepEqual(edges(facts, 'SUBSCRIBES'), ['module:m.ts -> queue:emails', 'module:m.ts -> queue:reports', 'module:m.ts -> topic:payments', 'module:m.ts -> topic:refunds']);
  for (const f of facts.filter((x) => ['PUBLISHES', 'SUBSCRIBES'].includes(x.type) || x.type === 'topic' || x.type === 'queue')) {
    assert.equal(f.provenance.source_type, 'inference');
    assert.equal(f.provenance.confidence, 'medium');
  }
  const web = extractOne('w.js', "new Worker('./worker.js'); new Queue('x');");
  assert.deepEqual(nodes(web, 'queue'), []);
});

test('stores: redux slice and store, zustand, pinia, context', () => {
  const facts = extractOne('s.ts', fixture('frameworks', 'stores.ts'));
  assert.deepEqual(nodes(facts, 'store'), ['store:s.ts#ThemeContext', 'store:s.ts#counter', 'store:s.ts#useBear']);
  const slice = extractOne('src/cartSlice.ts', fixture('react-spa', 'src', 'features', 'cart', 'cartSlice.ts'));
  assert.deepEqual(nodes(slice, 'store'), ['store:src/cartSlice.ts#cart']);
  assert.equal(slice.find((f) => f.type === 'store').attrs.kind, 'redux-slice');
  const store = extractOne('src/store.ts', fixture('react-spa', 'src', 'store.ts'));
  assert.deepEqual(nodes(store, 'store'), ['store:src/store.ts#store']);
});

test('package.json becomes a package node with dependency edges', () => {
  const facts = extractOne('packages/checkout/package.json', fixture('monorepo', 'packages', 'checkout', 'package.json'));
  const pkg = facts.find((f) => f.type === 'package');
  assert.equal(pkg.id, 'package:@acme/checkout');
  assert.equal(pkg.attrs.version, '0.4.0');
  assert.deepEqual(pkg.attrs.dependencies.dependencies, { '@acme/pricing': 'workspace:*', 'left-pad': '^1.3.0' });
  assert.deepEqual(edges(facts, 'DEPENDS_ON'), [
    'package:@acme/checkout -> dependency:@acme/pricing', 'package:@acme/checkout -> dependency:@types/node', 'package:@acme/checkout -> dependency:left-pad',
  ]);
  const left = facts.find((f) => f.kind === 'edge' && f.to === 'dependency:left-pad');
  assert.deepEqual([left.attrs.range, left.attrs.group], ['^1.3.0', 'dependencies']);
  const root = extractOne('package.json', fixture('monorepo', 'package.json')).find((f) => f.type === 'package');
  assert.deepEqual(root.attrs.workspaces, ['packages/*']);
  assert.deepEqual(root.attrs.scripts, ['build', 'test']);
  const pricing = extractOne('packages/pricing/package.json', fixture('monorepo', 'packages', 'pricing', 'package.json')).find((f) => f.type === 'package');
  assert.deepEqual([pricing.attrs.main, pricing.attrs.types], ['dist/index.js', 'dist/index.d.ts']);
  assert.throws(() => extractOne('package.json', '{ not json'));
});

test('tsconfig is parsed as JSONC into a build_target', () => {
  const facts = extractOne('packages/checkout/tsconfig.json', fixture('monorepo', 'packages', 'checkout', 'tsconfig.json'));
  assert.deepEqual(facts.map((f) => f.id), ['build_target:packages/checkout/tsconfig.json']);
  assert.deepEqual(facts[0].attrs.paths, { '@app/*': ['src/*'] });
  assert.equal(facts[0].attrs.baseUrl, '.');
  assert.equal(facts[0].attrs.extends, '../../tsconfig.base.json');
  const base = extractOne('tsconfig.base.json', fixture('monorepo', 'tsconfig.base.json'))[0];
  assert.equal(base.attrs.rootDir, '.');
  const tricky = extractOne('jsconfig.json', '{ /* c */ "compilerOptions": { "baseUrl": "src", "x": "a // not a comment, ] }", }, }');
  assert.equal(tricky[0].attrs.baseUrl, 'src');
});

test('output is deterministic and files the adapter does not own yield nothing', () => {
  const src = fixture('react-spa', 'src', 'App.tsx');
  assert.deepEqual(extractOne('src/App.tsx', src), extractOne('src/App.tsx', src));
  assert.deepEqual(extractOne('README.md', '# hi'), []);
  assert.deepEqual(extractOne('data.json', '{}'), []);
});
