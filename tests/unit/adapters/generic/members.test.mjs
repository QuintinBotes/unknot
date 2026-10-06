// The unused-member analysis for every language: a field, property or constructor-injected
// parameter whose type lives in another module and that nothing reads makes a declared-only
// IMPORTS edge. Per language, the same three scenarios: an injected member never read; a read
// through the member; and a same-named member read on an unrelated typed receiver, which is no
// use. Java, Kotlin and Go are read by the generic adapter, TypeScript by the JavaScript adapter
// and Python by the Python adapter; all of them run the one engine of members.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import generic from '../../../../adapters/language/generic/index.mjs';
import javascript from '../../../../adapters/language/javascript/index.mjs';
import python from '../../../../adapters/language/python/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';

const ADAPTERS = [javascript, python, generic];

/** Extract and link an in-memory project with every language adapter, as the builder would. */
function build(sources) {
  const files = new Map();
  const factsByFile = new Map();
  for (const [path, text] of Object.entries(sources)) {
    const entry = { path, size: text.length, language: null, kind: 'source', blob: path };
    files.set(path, entry);
    const facts = ADAPTERS.flatMap((a) => a.extract(entry, text, { commit: 'test', options: {} }));
    facts.forEach(assertFact);
    if (facts.length) factsByFile.set(path, facts);
  }
  const linked = ADAPTERS.flatMap((a) => a.link({ files, factsByFile, options: {}, resolve: null, notes: [], stats: {} }));
  linked.forEach(assertFact);
  const all = [...[...factsByFile.values()].flat(), ...linked];
  const merged = (from, to) => {
    const es = all.filter((f) => f.kind === 'edge' && f.type === 'IMPORTS' && f.from === `module:${from}` && f.to === `module:${to}`);
    return es.length ? Object.assign({}, ...es.map((e) => e.attrs)) : undefined;
  };
  return { all, factsByFile, edge: (from, to) => merged(from, to), attrsOf: (path) => factsByFile.get(path).find((f) => f.kind === 'node' && f.type === 'module').attrs };
}

const declared = (g, from, to) => g.edge(from, to)?.declared_only === true;

// ---------------------------------------------------------------------------------------
// Java

const J_REPO = 'package shop.core;\n\npublic class OrderRepo {\n    public void save() { }\n}\n';
const J_UNRELATED = 'package shop.other;\n\npublic class Ledger {\n    public Object repo;\n}\n';
const jService = (body, fields = '    private final OrderRepo repo;') => `package shop.orders;\n\nimport shop.core.OrderRepo;\n\npublic class OrderService {\n${fields}\n    public OrderService(OrderRepo repo) { this.repo = repo; }\n    public void place() { ${body} }\n}\n`;
const J = { 'src/main/java/shop/core/OrderRepo.java': J_REPO, 'src/main/java/shop/other/Ledger.java': J_UNRELATED };

test('Java: a constructor-injected field that is never read is declared-only', () => {
  const g = build({ ...J, 'src/main/java/shop/orders/OrderService.java': jService('') });
  const e = g.edge('src/main/java/shop/orders/OrderService.java', 'src/main/java/shop/core/OrderRepo.java');
  assert.equal(e.declared_only, true);
  assert.equal(e.unused_member, 'repo');
  assert.equal(e.member_visibility, 'private');
  assert.equal(e.spec, 'shop.core.OrderRepo', 'the import edge is the one marked');
});

test('Java: a read through the member, or a use of the type anywhere, is not declared-only', () => {
  for (const body of ['repo.save();', 'this.repo.save();', 'OrderRepo local = null;']) {
    const g = build({ ...J, 'src/main/java/shop/orders/OrderService.java': jService(body) });
    assert.ok(!declared(g, 'src/main/java/shop/orders/OrderService.java', 'src/main/java/shop/core/OrderRepo.java'), body);
  }
});

test('Java: a same-package type is found without an import, and an injected annotation makes a public member count', () => {
  const same = 'package shop.core;\n\npublic class Billing {\n    private OrderRepo repo;\n}\n';
  const g = build({ ...J, 'src/main/java/shop/core/Billing.java': same });
  const e = g.edge('src/main/java/shop/core/Billing.java', 'src/main/java/shop/core/OrderRepo.java');
  assert.equal(e.declared_only, true);
  assert.equal(e.via, 'type');
  const host = 'package shop.orders;\n\nimport shop.core.OrderRepo;\n\npublic class Host {\n    @Autowired OrderRepo repo;\n}\n';
  const h = build({ ...J, 'src/main/java/shop/orders/Host.java': host });
  const he = h.edge('src/main/java/shop/orders/Host.java', 'src/main/java/shop/core/OrderRepo.java');
  assert.equal(he.declared_only, true);
  assert.equal(he.member_visibility, 'public');
});

test('Java: a same-named member read on an unrelated typed receiver is no use; on the declaring type it is', () => {
  const host = 'package shop.orders;\n\nimport shop.core.OrderRepo;\n\npublic class Host {\n    @Autowired OrderRepo repo;\n}\n';
  const audit = (type) => `package shop.audit;\n\npublic class Audit {\n    void run(${type} x) { x.repo.save(); }\n}\n`;
  const other = build({ ...J, 'src/main/java/shop/orders/Host.java': host, 'src/main/java/shop/audit/Audit.java': audit('Ledger') });
  assert.equal(declared(other, 'src/main/java/shop/orders/Host.java', 'src/main/java/shop/core/OrderRepo.java'), true);
  const same = build({ ...J, 'src/main/java/shop/orders/Host.java': host, 'src/main/java/shop/audit/Audit.java': audit('Host') });
  assert.ok(!declared(same, 'src/main/java/shop/orders/Host.java', 'src/main/java/shop/core/OrderRepo.java'));
});

// ---------------------------------------------------------------------------------------
// Kotlin

const K_REPO = 'package shop.core\n\nclass OrderRepo {\n    fun save() { }\n}\n';
const K_UNRELATED = 'package shop.other\n\nclass Ledger {\n    var repo: Any? = null\n}\n';
const kService = (body, head = 'private val repo: OrderRepo') => `package shop.orders\n\nimport shop.core.OrderRepo\n\nclass OrderService(${head}) {\n    fun place() { ${body} }\n}\n`;
const K = { 'src/main/kotlin/shop/core/OrderRepo.kt': K_REPO, 'src/main/kotlin/shop/other/Ledger.kt': K_UNRELATED };
const KS = 'src/main/kotlin/shop/orders/OrderService.kt';

test('Kotlin: a private constructor property that is never read is declared-only', () => {
  const g = build({ ...K, [KS]: kService('') });
  const e = g.edge(KS, 'src/main/kotlin/shop/core/OrderRepo.kt');
  assert.equal(e.declared_only, true);
  assert.equal(e.unused_member, 'repo');
  assert.equal(e.member_visibility, 'private');
  const plain = build({ ...K, [KS]: kService('', 'repo: OrderRepo') });
  assert.ok(!declared(plain, KS, 'src/main/kotlin/shop/core/OrderRepo.kt'), 'a plain parameter is not a member');
});

test('Kotlin: a read through the member is not declared-only', () => {
  for (const body of ['repo.save()', 'this.repo.save()', 'val r: OrderRepo? = null']) {
    const g = build({ ...K, [KS]: kService(body) });
    assert.ok(!declared(g, KS, 'src/main/kotlin/shop/core/OrderRepo.kt'), body);
  }
});

test('Kotlin: a same-named member read on an unrelated typed receiver is no use; on the declaring type it is', () => {
  const host = 'package shop.orders\n\nimport shop.core.OrderRepo\n\nclass Host {\n    @Inject lateinit var repo: OrderRepo\n}\n';
  const audit = (type) => `package shop.audit\n\nfun run(x: ${type}) {\n    x.repo.save()\n}\n`;
  const other = build({ ...K, 'src/main/kotlin/shop/orders/Host.kt': host, 'src/main/kotlin/shop/audit/Audit.kt': audit('Ledger') });
  const e = other.edge('src/main/kotlin/shop/orders/Host.kt', 'src/main/kotlin/shop/core/OrderRepo.kt');
  assert.equal(e.declared_only, true);
  assert.equal(e.member_visibility, 'public');
  const same = build({ ...K, 'src/main/kotlin/shop/orders/Host.kt': host, 'src/main/kotlin/shop/audit/Audit.kt': audit('Host') });
  assert.ok(!declared(same, 'src/main/kotlin/shop/orders/Host.kt', 'src/main/kotlin/shop/core/OrderRepo.kt'));
});

// ---------------------------------------------------------------------------------------
// Go

const G_REPO = 'package orders\n\ntype OrderRepo interface {\n\tSave() error\n}\n';
const G_OTHER = 'package orders\n\ntype Ledger struct {\n\trepo string\n}\n';
const goService = (body) => `package orders\n\ntype service struct {\n\trepo OrderRepo\n}\n\nfunc NewService(repo OrderRepo) *service {\n\treturn &service{repo: repo}\n}\n\nfunc (s *service) Place() error {\n${body}\n\treturn nil\n}\n`;
const G = { 'orders/repo.go': G_REPO, 'orders/ledger.go': G_OTHER };

test('Go: a struct field that is only assigned from the constructor is declared-only', () => {
  const g = build({ ...G, 'orders/service.go': goService('') });
  const e = g.edge('orders/service.go', 'orders/repo.go');
  assert.equal(e.declared_only, true);
  assert.equal(e.unused_member, 'repo');
  assert.equal(e.member_visibility, 'package', 'an unexported field is reachable from the whole package, never file-private');
});

test('Go: a read through s.repo is not declared-only', () => {
  for (const body of ['\treturn s.repo.Save()', '\tr := s.repo\n\t_ = r', '\tvar x OrderRepo\n\t_ = x']) {
    const g = build({ ...G, 'orders/service.go': goService(body) });
    assert.ok(!declared(g, 'orders/service.go', 'orders/repo.go'), body);
  }
});

test('Go: a same-named field read on an unrelated typed receiver is no use; on the declaring type it is', () => {
  const read = (recv, type) => `package orders\n\nfunc (${recv} *${type}) Audit() string {\n\treturn ${recv}.repo\n}\n`;
  const other = build({ ...G, 'orders/service.go': goService(''), 'orders/audit.go': read('l', 'Ledger') });
  assert.equal(declared(other, 'orders/service.go', 'orders/repo.go'), true);
  const same = build({ ...G, 'orders/service.go': goService(''), 'orders/audit.go': read('s', 'service') });
  assert.ok(!declared(same, 'orders/service.go', 'orders/repo.go'));
});

test('Go: types resolve within one directory (the package), not across directories', () => {
  const g = build({ ...G, 'orders/service.go': goService(''), 'billing/service.go': goService('').replace('package orders', 'package billing') });
  assert.equal(declared(g, 'orders/service.go', 'orders/repo.go'), true);
  assert.equal(g.edge('billing/service.go', 'orders/repo.go'), undefined, 'a different directory is a different package');
});

// ---------------------------------------------------------------------------------------
// TypeScript

const T_REPO = 'export class OrderRepo {\n  save(): void {}\n}\n';
const T_LEDGER = 'export class Ledger {\n  repo: unknown;\n}\n';
const tService = (body, head = 'private readonly repo: OrderRepo') => `import { OrderRepo } from './repo';\n\nexport class OrderService {\n  constructor(${head}) {}\n\n  place(): void {\n    ${body}\n  }\n}\n`;
const T = { 'src/repo.ts': T_REPO, 'src/ledger.ts': T_LEDGER };

test('TypeScript: a constructor parameter property that is never read is declared-only', () => {
  const g = build({ ...T, 'src/orders.ts': tService('') });
  const e = g.edge('src/orders.ts', 'src/repo.ts');
  assert.equal(e.declared_only, true);
  assert.equal(e.unused_member, 'repo');
  assert.equal(e.member_visibility, 'private');
  assert.deepEqual(e.names, ['OrderRepo'], 'the import edge keeps its own facts');
  const field = 'import { OrderRepo } from \'./repo\';\n\nexport class Billing {\n  private repo: OrderRepo;\n  constructor(repo: OrderRepo) {\n    this.repo = repo;\n  }\n}\n';
  assert.equal(declared(build({ ...T, 'src/billing.ts': field }), 'src/billing.ts', 'src/repo.ts'), true, 'a field assigned from the constructor');
});

test('TypeScript: a read through the member, or any other use of the type, is not declared-only', () => {
  for (const body of ['this.repo.save();', 'const { repo } = this;', 'let r: OrderRepo | undefined;']) {
    const g = build({ ...T, 'src/orders.ts': tService(body) });
    assert.ok(!declared(g, 'src/orders.ts', 'src/repo.ts'), body);
  }
  const plain = build({ ...T, 'src/orders.ts': tService('', 'repo: OrderRepo') });
  assert.ok(!declared(plain, 'src/orders.ts', 'src/repo.ts'), 'a plain parameter is not a member');
  const other = build({ ...T, 'src/orders.ts': tService('').replace("import { OrderRepo } from './repo';", "import { OrderRepo, helper } from './repo';") });
  assert.ok(!declared(other, 'src/orders.ts', 'src/repo.ts'), 'another imported name is a use of the module');
});

test('TypeScript: a same-named member read on an unrelated typed receiver is no use; on the declaring type it is', () => {
  const host = 'import { OrderRepo } from \'./repo\';\n\nexport class Host {\n  @Inject() repo: OrderRepo;\n}\n';
  const audit = (type) => `import { ${type} } from './${type === 'Host' ? 'host' : 'ledger'}';\n\nexport function run(x: ${type}) {\n  return x.repo;\n}\n`;
  const other = build({ ...T, 'src/host.ts': host, 'src/audit.ts': audit('Ledger') });
  const e = other.edge('src/host.ts', 'src/repo.ts');
  assert.equal(e.declared_only, true);
  assert.equal(e.member_visibility, 'public');
  const same = build({ ...T, 'src/host.ts': host, 'src/audit.ts': audit('Host') });
  assert.ok(!declared(same, 'src/host.ts', 'src/repo.ts'));
});

// ---------------------------------------------------------------------------------------
// Python

const P_REPO = 'class OrderRepo:\n    def save(self):\n        pass\n';
const P_LEDGER = 'class Ledger:\n    def __init__(self):\n        self.repo = None\n';
const pService = (body, attr = 'self.repo = repo') => `from shop.repo import OrderRepo\n\n\nclass OrderService:\n    def __init__(self, repo: OrderRepo) -> None:\n        ${attr}\n\n    def place(self) -> None:\n        ${body}\n`;
const P = { 'shop/repo.py': P_REPO, 'shop/ledger.py': P_LEDGER };

test('Python: an annotated __init__ parameter stored on self and never read is declared-only', () => {
  const g = build({ ...P, 'shop/orders.py': pService('pass') });
  const e = g.edge('shop/orders.py', 'shop/repo.py');
  assert.equal(e.declared_only, true);
  assert.equal(e.unused_member, 'repo');
  assert.equal(e.member_visibility, 'public');
  const priv = build({ ...P, 'shop/orders.py': pService('pass', 'self._repo = repo') });
  assert.equal(priv.edge('shop/orders.py', 'shop/repo.py').member_visibility, 'private');
  const klass = build({ ...P, 'shop/orders.py': 'from shop.repo import OrderRepo\n\n\nclass OrderService:\n    _repo: OrderRepo\n\n    def place(self) -> None:\n        pass\n' });
  assert.equal(klass.edge('shop/orders.py', 'shop/repo.py').declared_only, true, 'a class-level annotation');
});

test('Python: a read through self is not declared-only', () => {
  for (const body of ['self.repo.save()', 'r = self.repo', 'print(f"{self.repo}")', 'x: OrderRepo = None']) {
    const g = build({ ...P, 'shop/orders.py': pService(body) });
    assert.ok(!declared(g, 'shop/orders.py', 'shop/repo.py'), body);
  }
  const used = build({ ...P, 'shop/orders.py': pService('pass', 'self.repo = repo\n        repo.warm()') });
  assert.ok(!declared(used, 'shop/orders.py', 'shop/repo.py'), 'the parameter is used as well');
});

test('Python: a same-named attribute read on an unrelated typed receiver is no use; on the declaring type it is', () => {
  const audit = (module, type) => `from shop.${module} import ${type}\n\n\ndef run(x: ${type}):\n    return x.repo\n`;
  const other = build({ ...P, 'shop/orders.py': pService('pass'), 'shop/audit.py': audit('ledger', 'Ledger') });
  assert.equal(declared(other, 'shop/orders.py', 'shop/repo.py'), true);
  const same = build({ ...P, 'shop/orders.py': pService('pass'), 'shop/audit.py': audit('orders', 'OrderService') });
  assert.ok(!declared(same, 'shop/orders.py', 'shop/repo.py'));
});
