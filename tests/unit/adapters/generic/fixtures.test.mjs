import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../../../adapters/language/generic/index.mjs';
import { lineOf, loadFixture } from './helpers.mjs';

const EXTRACTOR = 'generic@0.1.4';

test('adapter contract', () => {
  assert.equal(adapter.id, 'generic');
  assert.equal(adapter.version, '0.1.4');
  assert.equal(adapter.kind, 'language');
  assert.deepEqual(adapter.capabilities.executes, []);
  assert.equal(adapter.capabilities.network, false);
  for (const g of ['**/*.go', '**/*.kt', '**/*.kts', '**/*.hh', '**/go.mod', '**/Cargo.toml', '**/pom.xml', '**/build.gradle.kts', '**/settings.gradle', '**/*.csproj', '**/*.sln', '**/Gemfile', '**/composer.json', '**/Package.swift', '**/CMakeLists.txt']) {
    assert.ok(adapter.capabilities.files.includes(g), g);
  }
  assert.equal(adapter.extract({ path: 'README.md' }, '# hi', {}).length, 0);
});

test('every fact is lexical, ast-sourced and honestly labelled', () => {
  for (const name of ['go', 'java', 'dotnet', 'rust', 'rails', 'laravel', 'cpp']) {
    const fx = loadFixture(name);
    for (const f of fx.all) {
      assert.equal(f.provenance.extractor, EXTRACTOR);
      assert.match(f.provenance.source_ref, /^[^:]+:\d+$/);
      if (f.kind === 'node' && f.type === 'module') {
        assert.equal(f.attrs.parse_quality, 'lexical');
        assert.equal(f.provenance.confidence, 'medium');
      }
      if (f.kind === 'node' && (f.type === 'function' || f.type === 'method')) assert.equal(f.provenance.confidence, 'low');
      if (f.provenance.source_type === 'inference') assert.notEqual(f.provenance.confidence, 'high');
      else assert.equal(f.provenance.source_type, 'ast');
    }
  }
});

test('Go: module, package, gin routes, SQL, shell-out, metrics', () => {
  const fx = loadFixture('go');
  const store = 'internal/store/store.go';
  const text = fx.text(store);
  const pkg = fx.node('package:example.com/shop');
  assert.equal(pkg.attrs.go_module, 'example.com/shop');
  assert.deepEqual(pkg.attrs.deps, ['github.com/gin-gonic/gin', 'github.com/lib/pq']);
  assert.ok(fx.hasEdge('DEPENDS_ON', 'package:example.com/shop', 'dependency:github.com/gin-gonic/gin'));

  const mod = fx.node(`module:${store}`);
  assert.equal(mod.attrs.language, 'go');
  assert.equal(mod.attrs.package, 'store');
  assert.equal(mod.attrs.is_test, false);
  assert.equal(fx.node('module:internal/store/store_test.go').attrs.is_test, true);
  assert.deepEqual(mod.attrs.imports.map((i) => i.spec), ['database/sql', 'os/exec']);
  assert.equal(mod.attrs.sql.length, 1);
  assert.match(mod.attrs.sql[0].text, /^SELECT id, total FROM orders/);
  assert.equal(mod.attrs.sql[0].line, lineOf(text, 'SELECT id'));
  assert.deepEqual(mod.attrs.security_signals, [{ kind: 'command_exec', line: lineOf(text, 'exec.Command') }]);

  // Hand-computed: 2 params; decisions: if, for, if, ||  => 1 + 4 = 5; deepest control stack for > if = 2.
  // The raw string `if (x) { ... }` at file level must not leak into anything.
  const m = fx.node(`method:${store}#Store.FindOrders`);
  assert.equal(m.attrs.params, 2);
  assert.equal(m.attrs.cyclomatic, 5);
  assert.equal(m.attrs.max_nesting, 2);
  assert.equal(m.attrs.start_line, lineOf(text, 'func (s *Store) FindOrders'));
  assert.equal(m.attrs.end_line, lineOf(text, 'return out, nil') + 1);
  assert.equal(m.attrs.lines, m.attrs.end_line - m.attrs.start_line + 1);
  assert.equal(m.attrs.exported, true);
  assert.equal(fx.node(`function:${store}#unexported`).attrs.exported, false);
  assert.ok(fx.hasEdge('CONTAINS', `class:${store}#Store`, m.id));
  assert.ok(fx.hasEdge('CONTAINS', `module:${store}`, `function:${store}#Backup`));

  for (const [id, handler] of [['endpoint:GET /orders/:id', 'getOrder'], ['endpoint:POST /orders', 'createOrder'], ['endpoint:ANY /health', 'health']]) {
    assert.ok(fx.node(id), id);
    assert.equal(fx.node(id).provenance.source_type, 'inference');
    assert.equal(fx.node(id).provenance.confidence, 'medium');
    assert.ok(fx.hasEdge('EXPOSES', `function:main.go#${handler}`, id), id);
  }

  assert.ok(fx.hasEdge('IMPORTS', 'module:main.go', `module:${store}`), 'in-repo import via go.mod module path');
  assert.ok(fx.hasEdge('IMPORTS', 'module:main.go', 'dependency:github.com/gin-gonic/gin'));
  assert.ok(!fx.all.some((f) => f.kind === 'edge' && f.type === 'IMPORTS' && f.to === 'dependency:net/http'), 'stdlib is not a dependency');
  assert.ok(fx.hasEdge('TESTS', 'module:internal/store/store_test.go', `module:${store}`));
  assert.ok(fx.hasEdge('CONTAINS', 'package:example.com/shop', 'module:main.go'));
});

test('Java: Spring controller, JPA entity, pom.xml, resolution by package', () => {
  const fx = loadFixture('java');
  const ctl = 'src/main/java/com/acme/shop/OrderController.java';
  const text = fx.text(ctl);
  const pom = fx.node('package:com.acme:shop');
  assert.deepEqual(pom.attrs.deps, ['org.springframework.boot:spring-boot-starter-web']);
  assert.deepEqual(pom.attrs.dev_deps, ['org.junit.jupiter:junit-jupiter']);
  assert.ok(!fx.node('dependency:commented-out'));

  const mod = fx.node(`module:${ctl}`);
  assert.equal(mod.attrs.package, 'com.acme.shop');
  assert.deepEqual(mod.attrs.types, ['OrderController']);
  assert.equal(mod.attrs.security_signals[0].kind, 'command_exec');
  const cls = fx.node(`class:${ctl}#OrderController`);
  assert.deepEqual(cls.attrs.extends, ['BaseController']);
  assert.deepEqual(cls.attrs.implements, ['Auditable']);

  // Hand-computed: if, ||, for, if, &&, ?: => 1 + 6 = 7; nesting for > if = 2; 2 params.
  const get = fx.node(`method:${ctl}#OrderController.get`);
  assert.equal(get.attrs.cyclomatic, 7);
  assert.equal(get.attrs.max_nesting, 2);
  assert.equal(get.attrs.params, 2);
  assert.equal(get.attrs.start_line, lineOf(text, 'public Order get('), 'annotation line is not part of the method');
  assert.equal(get.attrs.exported, true);
  assert.equal(fx.node(`method:${ctl}#OrderController.OrderController`).attrs.params, 1);

  assert.ok(fx.hasEdge('EXPOSES', get.id, 'endpoint:GET /api/orders/:id'), 'class prefix + method path, {id} -> :id');
  assert.ok(fx.hasEdge('EXPOSES', `method:${ctl}#OrderController.create`, 'endpoint:POST /api/orders'));

  const order = 'src/main/java/com/acme/shop/Order.java';
  assert.ok(fx.hasEdge('OWNS_DATA', `module:${order}`, 'table:public.orders'));
  assert.equal(fx.node('table:public.orders').provenance.confidence, 'medium', 'explicit @Table(name=...)');

  const svc = 'src/main/java/com/acme/shop/service/OrderService.java';
  assert.ok(fx.hasEdge('IMPORTS', `module:${ctl}`, `module:${svc}`));
  assert.ok(fx.hasEdge('IMPORTS', `module:${svc}`, `module:${order}`));
  assert.ok(fx.hasEdge('IMPORTS', `module:${svc}`, `module:${ctl}`), 'wildcard import fans out to the package');
  assert.ok(fx.hasEdge('IMPORTS', `module:${ctl}`, 'dependency:org.springframework'));
  assert.equal(fx.node(`module:${svc}`).attrs.sql[0].text.startsWith('INSERT INTO orders'), true);
  assert.deepEqual(fx.node(`module:${svc}`).attrs.security_signals ?? [], []);
  const test = 'src/test/java/com/acme/shop/service/OrderServiceTest.java';
  assert.equal(fx.node(`module:${test}`).attrs.is_test, true);
  assert.ok(fx.hasEdge('TESTS', `module:${test}`, `module:${svc}`), 'mirrored src/test -> src/main by name');
});

test('C#: ASP.NET controller, EF DbSet, csproj, type-level imports', () => {
  const fx = loadFixture('dotnet');
  const ctl = 'Controllers/OrdersController.cs';
  const text = fx.text(ctl);
  const proj = fx.node('package:Shop');
  assert.deepEqual(proj.attrs.deps, ['Microsoft.EntityFrameworkCore']);
  assert.deepEqual(proj.attrs.local_deps, ['Common/Common.csproj']);

  const mod = fx.node(`module:${ctl}`);
  assert.deepEqual(mod.attrs.namespaces, ['Shop.Controllers']);
  assert.equal(mod.attrs.security_signals[0].kind, 'command_exec');
  assert.equal(mod.attrs.security_signals[0].line, lineOf(text, 'Process.Start'));
  const cls = fx.node(`class:${ctl}#OrdersController`);
  assert.deepEqual(cls.attrs.bases, ['ControllerBase', 'IAuditable']);
  assert.ok(fx.hasEdge('IMPLEMENTS', cls.id, cls.id) === false);

  // Hand-computed: if, ||, &&, ?: => 1 + 4 = 5; nesting 1; params `int id, bool includeItems = false` = 2.
  const get = fx.node(`method:${ctl}#OrdersController.Get`);
  assert.equal(get.attrs.cyclomatic, 5);
  assert.equal(get.attrs.max_nesting, 1);
  assert.equal(get.attrs.params, 2);
  assert.ok(fx.hasEdge('EXPOSES', get.id, 'endpoint:GET /api/orders/:id'), '[controller] token expanded');
  assert.ok(fx.hasEdge('EXPOSES', `method:${ctl}#OrdersController.Create`, 'endpoint:POST /api/orders'));

  assert.ok(fx.hasEdge('OWNS_DATA', 'module:Data/ShopContext.cs', 'table:public.orders'));
  assert.equal(fx.node('table:public.orders').provenance.confidence, 'low');
  const imp = fx.edges('IMPORTS', `module:${ctl}`, 'module:Models/Order.cs')[0];
  assert.equal(imp.attrs.via, 'type');
  assert.equal(imp.attrs.spec, 'Shop.Models.Order');
  assert.equal(imp.provenance.confidence, 'medium');
  assert.ok(!imp.attrs.declared_only);
  assert.ok(fx.hasEdge('TESTS', 'module:Tests/OrdersTests.cs', 'module:Models/Order.cs'));
  assert.equal(fx.node('module:Tests/OrdersTests.cs').attrs.is_test, true);
});

test('Rust: crate, mod tree, axum routes, impl Trait for Type', () => {
  const fx = loadFixture('rust');
  const crate = fx.node('package:shop');
  assert.deepEqual(crate.attrs.deps, ['axum', 'serde', 'shop-core']);
  assert.deepEqual(crate.attrs.dev_deps, ['tokio']);
  assert.deepEqual(crate.attrs.members, ['core']);
  assert.ok(fx.hasEdge('CONTAINS', 'package:shop', 'package:shop-core'));
  assert.ok(fx.hasEdge('DEPENDS_ON', 'package:shop', 'package:shop-core'), 'path dependency resolves to the in-repo crate');

  // Hand-computed: 4 match arms (=>) + `&&` + guard `if` => 1 + 6 = 7; one control block (match); 2 params.
  const classify = fx.node('function:src/routes/orders.rs#classify');
  assert.equal(classify.attrs.cyclomatic, 7);
  assert.equal(classify.attrs.max_nesting, 1);
  assert.equal(classify.attrs.params, 2);
  assert.equal(classify.attrs.exported, true);
  assert.equal(fx.node('function:src/main.rs#app').attrs.exported, false);

  // string and char literals containing braces and `fn` must not create functions or unbalance nesting
  assert.ok(!fx.node('function:src/main.rs#fake'));
  assert.equal(fx.node('function:src/main.rs#get_order').attrs.end_line, 18);
  assert.equal(fx.node('module:src/main.rs').attrs.security_signals[0].kind, 'command_exec');

  assert.ok(fx.node('endpoint:GET /orders'));
  assert.ok(fx.hasEdge('EXPOSES', 'function:src/main.rs#get_order', 'endpoint:GET /orders/:id'));
  assert.ok(fx.hasEdge('EXPOSES', 'function:src/main.rs#create_order', 'endpoint:POST /orders/:id'));

  assert.ok(fx.hasEdge('IMPORTS', 'module:src/main.rs', 'module:src/models.rs'), '`mod models;` -> models.rs');
  assert.ok(fx.hasEdge('IMPORTS', 'module:src/main.rs', 'module:src/routes/mod.rs'), '`mod routes;` -> routes/mod.rs');
  assert.ok(fx.hasEdge('IMPORTS', 'module:src/routes/mod.rs', 'module:src/routes/orders.rs'), '`pub mod orders;` inside mod.rs');
  assert.ok(fx.hasEdge('IMPORTS', 'module:src/main.rs', 'module:src/routes/orders.rs'), 'use crate::routes::orders::{..}');
  assert.ok(fx.hasEdge('IMPORTS', 'module:src/routes/orders.rs', 'module:src/models.rs'));
  assert.ok(fx.hasEdge('IMPORTS', 'module:src/main.rs', 'dependency:axum'));
  assert.ok(fx.hasEdge('TESTS', 'module:tests/api.rs', 'module:src/routes/orders.rs'), 'integration test imports via the crate name');
  assert.ok(fx.hasEdge('IMPLEMENTS', 'class:src/models.rs#Order', 'interface:src/models.rs#Priced'));
  assert.ok(fx.hasEdge('CALLS', 'function:src/main.rs#main', 'function:src/main.rs#app'));
});

test('Ruby/Rails: resources expands to 7 endpoints, ActiveRecord table is a low-confidence guess', () => {
  const fx = loadFixture('rails');
  const routes = fx.all.filter((f) => f.kind === 'edge' && f.type === 'EXPOSES' && f.from === 'module:config/routes.rb').map((f) => f.to);
  const orders = routes.filter((t) => /endpoint:\w+ \/orders/.test(t)).sort();
  assert.deepEqual(orders, [
    'endpoint:DELETE /orders/:id', 'endpoint:GET /orders', 'endpoint:GET /orders/:id', 'endpoint:GET /orders/:id/edit',
    'endpoint:GET /orders/new', 'endpoint:PATCH /orders/:id', 'endpoint:POST /orders',
  ]);
  assert.ok(routes.includes('endpoint:GET /health'));
  assert.ok(routes.includes('endpoint:GET /admin/users'), 'namespace prefix');
  assert.ok(routes.includes('endpoint:GET /admin/users/:id'));
  assert.ok(!routes.includes('endpoint:POST /admin/users'), 'only: [:index, :show]');

  const model = 'app/models/order.rb';
  const text = fx.text(model);
  assert.ok(fx.hasEdge('OWNS_DATA', `module:${model}`, 'table:public.orders'));
  assert.equal(fx.node('table:public.orders').provenance.confidence, 'low');
  assert.deepEqual(fx.node(`class:${model}#Order`).attrs.extends, ['ApplicationRecord']);

  // Hand-computed: if, &&, elsif, `unless` modifier => 1 + 4 = 5; `if` is the only block opener
  // (each-do and the modifier don't count) => nesting 1; params `discount = 0, tax = nil` = 2.
  const total = fx.node(`method:${model}#Order.total_cents`);
  assert.equal(total.attrs.cyclomatic, 5);
  assert.equal(total.attrs.max_nesting, 1);
  assert.equal(total.attrs.params, 2);
  assert.equal(total.attrs.start_line, lineOf(text, 'def total_cents'));
  assert.equal(total.attrs.end_line, lineOf(text, 'def self.recent') - 2);
  assert.ok(fx.node(`method:${model}#Order.recent`), 'def self.x');

  const mod = fx.node(`module:${model}`);
  assert.deepEqual(mod.attrs.sql.map((s) => s.text), ['SELECT id FROM orders WHERE end = 1 def nothing(a, b)']);
  assert.ok(!fx.node(`class:${model}#Fake`), '=begin/=end block is ignored');
  assert.deepEqual(mod.attrs.security_signals, [{ kind: 'command_exec', line: lineOf(text, 'system(') }]);

  assert.ok(fx.hasEdge('IMPORTS', `module:${model}`, 'module:lib/shipping.rb'), 'require_relative');
  assert.ok(fx.hasEdge('TESTS', 'module:spec/models/order_spec.rb', `module:${model}`));
  assert.equal(fx.node('module:spec/models/order_spec.rb').attrs.is_test, true);
  assert.ok(fx.hasEdge('DEPENDS_ON', 'package:root', 'dependency:rails'));
});

test('PHP/Laravel: routes, Eloquent $table, PSR-4 resolution, injection signals', () => {
  const fx = loadFixture('laravel');
  assert.ok(fx.node('endpoint:GET /orders'));
  assert.ok(fx.node('endpoint:POST /orders'));
  assert.ok(fx.hasEdge('OWNS_DATA', 'module:app/Models/Order.php', 'table:public.shop_orders'));
  assert.equal(fx.node('table:public.shop_orders').provenance.confidence, 'medium');

  // Hand-computed: foreach, if, `and` => 1 + 3 = 4; nesting foreach > if = 2; params 2.
  const total = fx.node('method:app/Models/Order.php#Order.total');
  assert.equal(total.attrs.cyclomatic, 4);
  assert.equal(total.attrs.max_nesting, 2);
  assert.equal(total.attrs.params, 2);
  assert.equal(fx.node('method:app/Models/Order.php#Order.secret').attrs.exported, false);
  // heredoc body `if (x) { not code }` and the `# ... {` comment must not disturb braces
  assert.equal(fx.node('class:app/Models/Order.php#Order').attrs.end_line, 29);

  const ctl = fx.node('module:app/Http/Controllers/OrderController.php');
  const kinds = ctl.attrs.security_signals.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ['code_eval', 'sql_injection_input', 'sql_string_building']);
  assert.equal(ctl.attrs.namespace, 'App\\Http\\Controllers');

  assert.ok(fx.hasEdge('IMPORTS', 'module:routes/web.php', 'module:app/Http/Controllers/OrderController.php'), 'PSR-4');
  assert.ok(fx.hasEdge('IMPORTS', 'module:app/Http/Controllers/OrderController.php', 'module:app/Models/Order.php'));
  assert.ok(fx.hasEdge('TESTS', 'module:tests/OrderTest.php', 'module:app/Models/Order.php'));
  assert.ok(fx.hasEdge('DEPENDS_ON', 'package:acme/shop', 'dependency:laravel/framework'));
  assert.ok(fx.hasEdge('IMPORTS', 'module:app/Models/Order.php', 'dependency:Illuminate'));
});

test('C++: CMake targets, include resolution through include_directories, raw strings', () => {
  const fx = loadFixture('cpp');
  const pkg = fx.node('package:shop');
  assert.deepEqual(pkg.attrs.include_dirs, ['include']);
  assert.equal(fx.node('build_target:cart').attrs.kind, 'library');
  assert.equal(fx.node('build_target:shop_app').attrs.kind, 'executable');
  assert.ok(fx.hasEdge('DEPENDS_ON', 'build_target:shop_app', 'build_target:cart'));
  assert.ok(fx.hasEdge('DEPENDS_ON', 'build_target:shop_app', 'dependency:fmt'));
  assert.ok(fx.hasEdge('CONTAINS', 'package:shop', 'build_target:cart_test'));

  assert.equal(fx.node('module:include/shop/cart.hpp').attrs.language, 'cpp');
  assert.deepEqual(fx.node('module:include/shop/cart.hpp').attrs.namespaces, ['shop']);
  assert.deepEqual(fx.node('class:include/shop/cart.hpp#Cart').attrs.bases, ['Base']);

  // Hand-computed `Cart::add`: if, for => 1 + 2 = 3; nesting 1; params `const std::string& sku, int qty` = 2.
  const add = fx.node('method:src/cart.cpp#Cart.add');
  assert.equal(add.attrs.cyclomatic, 3);
  assert.equal(add.attrs.max_nesting, 1);
  assert.equal(add.attrs.params, 2);
  // `Cart::total`: for, if, && => 4; nesting 2; the C++ raw string with `{` must not unbalance anything.
  const total = fx.node('method:src/cart.cpp#Cart.total');
  assert.equal(total.attrs.cyclomatic, 4);
  assert.equal(total.attrs.max_nesting, 2);
  assert.equal(total.attrs.end_line, 24);
  assert.equal(fx.node('function:src/main.cpp#main').attrs.cyclomatic, 2);

  assert.ok(fx.hasEdge('IMPORTS', 'module:src/cart.cpp', 'module:include/shop/cart.hpp'));
  assert.ok(fx.hasEdge('IMPORTS', 'module:src/main.cpp', 'dependency:fmt'));
  assert.ok(!fx.all.some((f) => f.kind === 'edge' && f.type === 'IMPORTS' && /vector|iostream|string$/.test(f.to)), 'standard headers are not dependencies');
  assert.ok(fx.hasEdge('TESTS', 'module:tests/cart_test.cpp', 'module:include/shop/cart.hpp'));
  assert.ok(fx.hasEdge('CONTAINS', 'package:shop', 'module:src/cart.cpp'));
});

test('output is deterministic', () => {
  const a = loadFixture('java').all.map((f) => JSON.stringify(f));
  const b = loadFixture('java').all.map((f) => JSON.stringify(f));
  assert.deepEqual(a, b);
});
