import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../../../adapters/language/generic/index.mjs';
import { countParams, cyclomatic } from '../../../../adapters/language/generic/structure.mjs';
import { rng } from './helpers.mjs';

/** Extract an in-memory project and link it, returning lookup helpers. */
function project(files) {
  const entries = new Map();
  const factsByFile = new Map();
  for (const [path, text] of Object.entries(files)) {
    const entry = { path, size: text.length, language: null, kind: 'source', blob: path };
    entries.set(path, entry);
    factsByFile.set(path, adapter.extract(entry, text, {}));
  }
  const linked = adapter.link({ files: entries, factsByFile, options: {}, resolve: null });
  const all = [...[...factsByFile.values()].flat(), ...linked];
  return {
    all,
    node: (id) => all.find((f) => f.kind === 'node' && f.id === id),
    nodes: (type) => all.filter((f) => f.kind === 'node' && f.type === type),
    hasEdge: (type, from, to) => all.some((f) => f.kind === 'edge' && f.type === type && f.from === from && f.to === to),
  };
}

test('countParams counts top-level commas only', () => {
  assert.equal(countParams('', 'java'), 0);
  assert.equal(countParams('  ', 'java'), 0);
  assert.equal(countParams('int a', 'java'), 1);
  assert.equal(countParams('Map<String, List<Integer>> m, int b', 'java'), 2);
  assert.equal(countParams('f func(a, b int) error, x int', 'go'), 2);
  assert.equal(countParams('a: Int = foo(1, 2), b: Int,', 'kotlin'), 2);
  assert.equal(countParams('&self, a: i32, cb: impl Fn(i32) -> i32', 'rust'), 2);
  assert.equal(countParams('a, b = {x: 1, y: 2}, *rest', 'ruby'), 3);
});

test('cyclomatic counts the documented constructs', () => {
  assert.equal(cyclomatic('', 'java'), 1);
  assert.equal(cyclomatic('if (a) {} else if (b) {} else {}', 'java'), 3);
  assert.equal(cyclomatic('switch (x) { case 1: case 2: break; default: }', 'java'), 3);
  assert.equal(cyclomatic('try {} catch (A e) {} catch (B e) {}', 'java'), 3);
  assert.equal(cyclomatic('a && b || c', 'c'), 3);
  assert.equal(cyclomatic('x = a ? b : c;', 'csharp'), 2);
  assert.equal(cyclomatic('String? x = y ?: z; foo?.bar()', 'kotlin'), 1, 'nullable types and elvis are not ternaries');
  assert.equal(cyclomatic('guard let x = y else { return }', 'swift'), 2);
  assert.equal(cyclomatic('unless a or b\n until c\n rescue => e', 'ruby'), 5);
  assert.equal(cyclomatic('match x { 1 => a, 2 => b, _ => c }', 'rust'), 4);
  assert.equal(cyclomatic('foo.if(1); $for = 2;', 'php'), 1, 'member and variable names are not keywords');
});

test('Kotlin: classes, interfaces, expression-bodied functions, Spring mapping', () => {
  const src = `package demo.api

import demo.core.Greeter
import demo.util.*

interface Named { val name: String }

open class Base

@RestController
@RequestMapping("/greet")
class GreetController(private val g: Greeter) : Base(), Named {
    override val name = "x"

    @GetMapping("/{who}")
    fun greet(who: String, loud: Boolean = false): String {
        if (loud) { return who.uppercase() }
        return g.hello(who)
    }

    private fun short(a: Int) = a + 1
    abstract fun nothing(): Int
}

fun String.shout(times: Int) = this.repeat(times)
`;
  const p = project({
    'src/main/kotlin/demo/api/GreetController.kt': src,
    'src/main/kotlin/demo/core/Greeter.kt': 'package demo.core\nclass Greeter { fun hello(n: String) = "hi $n" }\n',
    'src/main/kotlin/demo/util/Strings.kt': 'package demo.util\nfun trim(s: String): String { return s.trim() }\n',
  });
  const f = 'src/main/kotlin/demo/api/GreetController.kt';
  assert.ok(p.node(`interface:${f}#Named`));
  const ctl = p.node(`class:${f}#GreetController`);
  assert.deepEqual(ctl.attrs.bases, ['Base', 'Named']);
  assert.ok(p.hasEdge('EXTENDS', ctl.id, `class:${f}#Base`));
  assert.ok(p.hasEdge('IMPLEMENTS', ctl.id, `interface:${f}#Named`), 'colon list: interface targets become IMPLEMENTS');
  const greet = p.node(`method:${f}#GreetController.greet`);
  assert.equal(greet.attrs.params, 2);
  assert.equal(greet.attrs.cyclomatic, 2);
  assert.equal(greet.attrs.max_nesting, 1);
  assert.equal(greet.attrs.exported, true);
  assert.equal(p.node(`method:${f}#GreetController.short`).attrs.exported, false);
  assert.equal(p.node(`method:${f}#GreetController.short`).attrs.lines, 1, 'expression body ends on its own line');
  assert.ok(!p.node(`method:${f}#GreetController.nothing`), 'no body, no function node');
  assert.ok(p.node(`function:${f}#shout`), 'extension function');
  assert.ok(p.hasEdge('EXPOSES', greet.id, 'endpoint:GET /greet/:who'));
  assert.ok(p.hasEdge('IMPORTS', `module:${f}`, 'module:src/main/kotlin/demo/core/Greeter.kt'));
  assert.ok(p.hasEdge('IMPORTS', `module:${f}`, 'module:src/main/kotlin/demo/util/Strings.kt'), 'wildcard import');
});

test('Scala: traits, objects, brace imports, def with and without parameter lists', () => {
  const p = project({
    'src/main/scala/a/Shop.scala': `package a

import b.model.{Item, Cart => C}
import scala.collection.mutable

trait Priced { def price: Double }
class Item(val n: String) extends Base with Priced {
  def price = 1.0
  def total(xs: List[Int], k: Int): Int = {
    if (k > 0) xs.sum else 0
  }
}
object Shop { def main(args: Array[String]): Unit = println("x") }
`,
    'src/main/scala/b/model/Item.scala': 'package b.model\nclass Item\nclass Cart\n',
  });
  const f = 'src/main/scala/a/Shop.scala';
  assert.ok(p.node(`interface:${f}#Priced`));
  assert.deepEqual(p.node(`class:${f}#Item`).attrs.extends, ['Base']);
  assert.deepEqual(p.node(`class:${f}#Item`).attrs.implements, ['Priced']);
  assert.ok(p.hasEdge('IMPLEMENTS', `class:${f}#Item`, `interface:${f}#Priced`));
  assert.equal(p.node(`method:${f}#Item.total`).attrs.params, 2);
  assert.equal(p.node(`method:${f}#Item.total`).attrs.cyclomatic, 2);
  assert.equal(p.node(`method:${f}#Item.price`).attrs.params, 0);
  assert.ok(p.node(`class:${f}#Shop`), 'object');
  assert.ok(p.hasEdge('IMPORTS', `module:${f}`, 'module:src/main/scala/b/model/Item.scala'));
  assert.ok(!p.nodes('dependency').some((d) => d.name.startsWith('scala')));
});

test('Swift: protocols, extensions, guard, init, Package.swift', () => {
  const p = project({
    'Package.swift': `// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "Shop",
  dependencies: [
    .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),
    .package(path: "../Local"),
  ],
  targets: [
    .target(name: "ShopCore", dependencies: [.product(name: "Vapor", package: "vapor")]),
    .executableTarget(name: "ShopApp", dependencies: ["ShopCore"]),
    .testTarget(name: "ShopTests", dependencies: ["ShopCore"]),
  ]
)
`,
    'Sources/ShopCore/Cart.swift': `import Foundation
public protocol Priced { func price() -> Int }
public class Cart: Base, Priced {
  public init(n: Int) { self.n = n }
  public func price() -> Int {
    guard n > 0 else { return 0 }
    return n
  }
}
extension Cart {
  func extra(a: Int, b: Int) -> Int { if a > b { return a }; return b }
}
`,
    'Sources/ShopApp/main.swift': 'import ShopCore\nprint(1)\n',
  });
  const pkg = p.node('package:Shop');
  assert.deepEqual(pkg.attrs.deps, ['vapor']);
  assert.deepEqual(pkg.attrs.local_deps, ['Local'], 'path dependency, resolved against the manifest directory');
  assert.ok(p.node('build_target:ShopCore'));
  assert.ok(p.hasEdge('DEPENDS_ON', 'build_target:ShopApp', 'build_target:ShopCore'));
  assert.ok(p.hasEdge('DEPENDS_ON', 'build_target:ShopCore', 'dependency:Vapor'));
  const f = 'Sources/ShopCore/Cart.swift';
  assert.ok(p.node(`interface:${f}#Priced`));
  assert.ok(p.hasEdge('IMPLEMENTS', `class:${f}#Cart`, `interface:${f}#Priced`));
  assert.equal(p.node(`method:${f}#Cart.price`).attrs.cyclomatic, 2);
  assert.ok(p.node(`method:${f}#Cart.init`));
  assert.equal(p.node(`method:${f}#Cart.extra`).attrs.params, 2, 'extension members belong to the extended type');
  assert.ok(p.hasEdge('IMPORTS', 'module:Sources/ShopApp/main.swift', `module:${f}`), 'import of an in-repo target');
  assert.ok(p.hasEdge('IMPORTS', `module:${f}`, 'dependency:Foundation'));
});

test('JAX-RS and servlet-style Java: @Path + verb, enums, records, interfaces', () => {
  const p = project({
    'src/main/java/x/Api.java': `package x;
@Path("/v1/items")
public interface Api extends Base, Other {
  @GET @Path("/{id}") Item one(long id);
}
`,
    'src/main/java/x/Impl.java': `package x;
import javax.ws.rs.*;
@Path("/v1/items")
public class Impl implements Api {
  @GET
  @Path("/{id}")
  public Item one(long id) { return null; }
  @POST
  public Item add(Item i) { return i; }
}
enum Color { RED(1) { int v() { return 1; } }, BLUE(2); Color(int x) {} }
record Point(int x, int y) implements Comparable<Point> { public int sum() { return x + y; } }
`,
  });
  const f = 'src/main/java/x/Impl.java';
  assert.ok(p.hasEdge('EXPOSES', `method:${f}#Impl.one`, 'endpoint:GET /v1/items/:id'));
  assert.ok(p.hasEdge('EXPOSES', `method:${f}#Impl.add`, 'endpoint:POST /v1/items'));
  assert.ok(p.hasEdge('IMPLEMENTS', `class:${f}#Impl`, 'interface:src/main/java/x/Api.java#Api'), 'cross-file implements by unique name');
  assert.ok(p.node(`class:${f}#Color`));
  assert.deepEqual(p.node(`class:${f}#Point`).attrs.implements, ['Comparable']);
  assert.ok(p.node(`method:${f}#Point.sum`));
  assert.ok(!p.node(`method:${f}#Color.RED`), 'enum constants with bodies are not methods');
  assert.equal(p.node('interface:src/main/java/x/Api.java#Api').attrs.type_kind, 'interface');
});

test('Go: grouped type declarations, method receivers, routers', () => {
  const p = project({
    'go.mod': 'module m\n\ngo 1.22\n',
    'api/api.go': `package api

import (
	"net/http"
	"github.com/go-chi/chi/v5"
)

type (
	Handler struct{ n int }
	Doer interface {
		Do() error
	}
)

func (h *Handler) Serve(w http.ResponseWriter, r *http.Request) {}

func Routes() {
	r := chi.NewRouter()
	r.Get("/items/{id}", get)
	r.Post("/items", create)
	mux.Handle("GET /v2/ping", pong)
	client.Get("http://example.com")
}
`,
  });
  assert.ok(p.node('class:api/api.go#Handler'));
  assert.equal(p.node('interface:api/api.go#Doer').type, 'interface');
  assert.ok(p.node('method:api/api.go#Handler.Serve'));
  assert.equal(p.node('method:api/api.go#Handler.Serve').attrs.params, 2);
  assert.ok(p.node('endpoint:GET /items/:id'));
  assert.ok(p.node('endpoint:POST /items'));
  assert.ok(p.node('endpoint:GET /v2/ping'));
  assert.equal(p.nodes('endpoint').length, 3, 'an HTTP client call is not a route');
  assert.ok(p.hasEdge('IMPORTS', 'module:api/api.go', 'dependency:github.com/go-chi/chi'), 'host + two path segments');
});

test('Ruby: Sinatra routes and pluralised ActiveRecord tables', () => {
  const p = project({
    'app.rb': `require 'sinatra'
get '/hello' do
  'hi'
end
post "/items/:id" do
  halt 400 if params[:id].nil?
  x = `+'`ls`'+`
end
`,
    'app/models/category.rb': 'class Category < ApplicationRecord\nend\nclass Box < ActiveRecord::Base\n  self.table_name = "crates"\nend\nclass Bus < ApplicationRecord; end\n',
  });
  assert.ok(p.node('endpoint:GET /hello'));
  assert.ok(p.node('endpoint:POST /items/:id'));
  assert.ok(p.hasEdge('OWNS_DATA', 'module:app/models/category.rb', 'table:public.categories'));
  assert.ok(p.hasEdge('OWNS_DATA', 'module:app/models/category.rb', 'table:public.crates'));
  assert.equal(p.node('table:public.crates').provenance.confidence, 'medium');
  assert.equal(p.node('table:public.categories').provenance.confidence, 'low');
  assert.deepEqual(p.node('module:app.rb').attrs.security_signals, [{ kind: 'command_exec', line: 7 }], 'backtick command');
});

test('Actix attributes, C typedef struct, Rust trait inheritance', () => {
  const rs = project({
    'src/handlers.rs': `use actix_web::{get, post};
#[get("/ping")]
async fn ping() -> &'static str { "pong" }
#[post("/items/{id}")]
async fn add(id: u32) {}
pub trait A: B + C { fn x(&self); }
`,
  });
  assert.ok(rs.hasEdge('EXPOSES', 'function:src/handlers.rs#ping', 'endpoint:GET /ping'));
  assert.ok(rs.hasEdge('EXPOSES', 'function:src/handlers.rs#add', 'endpoint:POST /items/:id'));
  assert.deepEqual(rs.node('interface:src/handlers.rs#A').attrs.extends, ['B', 'C']);
  assert.ok(rs.hasEdge('IMPORTS', 'module:src/handlers.rs', 'dependency:actix_web'));

  const c = project({
    'src/list.c': `#include <stdio.h>
#include "list.h"
typedef struct { int n; } Pair;
struct node { struct node *next; };
static int count(struct node *n) {
  int c = 0;
  while (n) { c++; n = n->next; }
  return c;
}
`,
    'src/list.h': '#ifndef L\n#define L\nint count(void);\n#endif\n',
  });
  assert.ok(c.node('class:src/list.c#Pair'));
  assert.ok(c.node('class:src/list.c#node'));
  const count = c.node('function:src/list.c#count');
  assert.equal(count.attrs.cyclomatic, 2);
  assert.equal(count.attrs.exported, false, 'static');
  assert.ok(c.hasEdge('IMPORTS', 'module:src/list.c', 'module:src/list.h'));
  assert.ok(!c.nodes('dependency').some((d) => d.name === 'stdio.h'));
});

test('manifests: Gradle, settings.gradle, Maven modules, sln, Gemfile, composer errors', () => {
  const p = project({
    'settings.gradle': "rootProject.name = 'mono'\ninclude ':app', ':libs:core'\n",
    'app/build.gradle': "plugins { id 'java' }\ndependencies {\n  implementation 'org.slf4j:slf4j-api:2.0.9'\n  testImplementation(\"junit:junit:4.13\")\n  implementation project(':libs:core')\n}\n",
    'libs/core/build.gradle.kts': 'dependencies { api("com.google.guava:guava:32.0") }\n',
    'pom.xml': '<project><groupId>g</groupId><artifactId>parent</artifactId><modules><module>child</module></modules></project>',
    'child/pom.xml': '<project><parent><groupId>g</groupId></parent><artifactId>child</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>parent</artifactId></dependency></dependencies></project>',
    'Shop.sln': 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Web", "src\\Web\\Web.csproj", "{1}"\nEndProject\n',
    'src/Web/Web.csproj': '<Project><ItemGroup><PackageReference Include="Serilog" Version="3"/></ItemGroup></Project>',
    'composer.json': '{ not json',
  });
  const ws = p.node('workspace:mono');
  assert.deepEqual(ws.attrs.members, ['app', 'libs/core']);
  assert.ok(p.hasEdge('CONTAINS', 'workspace:mono', 'package:app'));
  assert.ok(p.hasEdge('CONTAINS', 'workspace:mono', 'package:core'));
  assert.deepEqual(p.node('package:app').attrs.deps, ['org.slf4j:slf4j-api']);
  assert.deepEqual(p.node('package:app').attrs.dev_deps, ['junit:junit']);
  assert.ok(p.hasEdge('DEPENDS_ON', 'package:app', 'package:core'), "project(':libs:core')");
  assert.ok(p.hasEdge('CONTAINS', 'package:g:parent', 'package:g:child'), '<modules>');
  assert.ok(p.hasEdge('DEPENDS_ON', 'package:g:child', 'package:g:parent'), 'in-repo maven dependency');
  assert.ok(p.hasEdge('CONTAINS', 'workspace:Shop', 'package:Web'), 'solution lists the project');
  assert.equal(p.nodes('package').filter((n) => n.attrs.ecosystem === 'composer')[0].attrs.parse_error, true);
});

test('manifest readers tolerate malformed input', () => {
  const rand = rng(42);
  const names = ['go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'a.csproj', 'a.sln', 'Gemfile', 'composer.json', 'Package.swift', 'CMakeLists.txt'];
  const bits = ['[', ']', '{', '}', '(', ')', '"', "'", '=', '<', '>', '\n', 'name', 'require', 'project', 'add_library(', 'target_link_libraries(', '<dependency>', '</dependency>', '[dependencies]', ' ', '#', '\\'];
  for (const n of names) {
    for (let k = 0; k < 200; k++) {
      let s = '';
      for (let j = 0, len = Math.floor(rand() * 80); j < len; j++) s += bits[Math.floor(rand() * bits.length)];
      assert.doesNotThrow(() => adapter.extract({ path: `sub/${n}`, kind: 'config' }, s, {}), `${n}: ${JSON.stringify(s)}`);
    }
  }
});

test('truncation and unknown files', () => {
  assert.deepEqual(adapter.extract({ path: 'notes.txt' }, 'class A {}', {}), []);
  const big = Array.from({ length: 3000 }, (_, i) => `fn f${i}() {}`).join('\n');
  const facts = adapter.extract({ path: 'src/big.rs', kind: 'source' }, big, {});
  assert.equal(facts.length, 5000);
  assert.deepEqual(facts[0].attrs.truncated, { facts: 6001, kept: 5000 });
});
