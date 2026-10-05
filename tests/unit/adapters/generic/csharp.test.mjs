// C# dependencies at type level: namespaces make types visible, only mentioned types link,
// and a link that merely declares an unused field or property is marked declared_only.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../../../../adapters/language/generic/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';

function build(sources) {
  const files = new Map();
  const factsByFile = new Map();
  for (const [path, text] of Object.entries(sources)) {
    const entry = { path, size: text.length, language: null, kind: 'source', blob: path };
    files.set(path, entry);
    const facts = adapter.extract(entry, text, { commit: 'test', options: {} });
    facts.forEach(assertFact);
    factsByFile.set(path, facts);
  }
  const linked = adapter.link({ files, factsByFile, options: {}, resolve: null });
  const all = [...[...factsByFile.values()].flat(), ...linked];
  const edges = (type, from) => all.filter((f) => f.kind === 'edge' && f.type === type && (from === undefined || f.from === `module:${from}`));
  const imports = (from) => edges('IMPORTS', from).filter((e) => e.to.startsWith('module:')).map((e) => e.to.slice(7)).sort();
  const edge = (from, to) => edges('IMPORTS', from).find((e) => e.to === `module:${to}`);
  return { all, factsByFile, edges, imports, edge };
}

const cls = (ns, name, body = '', head = '') => `${head}namespace ${ns}\n{\n    public class ${name}\n    {\n${body}\n    }\n}\n`;

test('same-namespace reference links; unreferenced neighbours and fan-out do not', () => {
  const g = build({
    'Orders/Order.cs': cls('Shop.Orders', 'Order'),
    'Orders/Invoice.cs': cls('Shop.Orders', 'Invoice', '        public Order Make() { return new Order(); }'),
    'Orders/Other.cs': cls('Shop.Orders', 'Other'),
    'Orders/Third.cs': cls('Shop.Orders', 'Third'),
  });
  assert.deepEqual(g.imports('Orders/Invoice.cs'), ['Orders/Order.cs']);
  assert.deepEqual(g.imports('Orders/Other.cs'), []);
  assert.equal(g.edge('Orders/Invoice.cs', 'Orders/Order.cs').attrs.via, 'type');
  assert.equal(g.edge('Orders/Invoice.cs', 'Orders/Order.cs').attrs.spec, 'Shop.Orders.Order');
  assert.equal(g.edge('Orders/Invoice.cs', 'Orders/Order.cs').provenance.confidence, 'medium');
});

test('using links only to the types the file mentions, an unused using links nothing', () => {
  const g = build({
    'A/Customer.cs': cls('Shop.Customers', 'Customer'),
    'A/Address.cs': cls('Shop.Customers', 'Address'),
    'B/Report.cs': cls('Shop.Reports', 'Report', '        Customer c;', 'using Shop.Customers;\n'),
    'B/Idle.cs': cls('Shop.Reports', 'Idle', '', 'using Shop.Customers;\n'),
  });
  assert.deepEqual(g.imports('B/Report.cs'), ['A/Customer.cs']);
  assert.deepEqual(g.imports('B/Idle.cs'), []);
  assert.equal(g.all.filter((f) => f.kind === 'edge' && f.type === 'IMPORTS').length, 1);
});

test('a type only resolves in a visible namespace', () => {
  const g = build({
    'A/Customer.cs': cls('Shop.Customers', 'Customer'),
    'B/Report.cs': cls('Shop.Reports', 'Report', '        Customer c;'),
  });
  assert.deepEqual(g.imports('B/Report.cs'), []);
});

test('aliases, using static, qualified names and global using', () => {
  const g = build({
    'A/Customer.cs': cls('Shop.Customers', 'Customer'),
    'A/Helpers.cs': cls('Shop.Util', 'Helpers'),
    'A/Money.cs': cls('Shop.Money', 'Money'),
    'Globals.cs': 'global using Shop.Money;\n',
    'B/Aliased.cs': cls('Other.Place', 'Aliased', '        Person p;', 'using Person = Shop.Customers.Customer;\n'),
    'B/Static.cs': cls('Other.Place', 'Static', '        void F() { }', 'using static Shop.Util.Helpers;\n'),
    'B/Qualified.cs': cls('Other.Place', 'Qualified', '        Shop.Customers.Customer c;'),
    'B/Global.cs': cls('Other.Place', 'Global', '        Money m;'),
    'B/Attr.cs': cls('Other.Place', 'Attr', '        [Marker] void F() { }', 'using Shop.Util;\n'),
    'A/MarkerAttribute.cs': cls('Shop.Util', 'MarkerAttribute'),
  });
  assert.deepEqual(g.imports('B/Aliased.cs'), ['A/Customer.cs']);
  assert.deepEqual(g.imports('B/Static.cs'), ['A/Helpers.cs']);
  assert.deepEqual(g.imports('B/Qualified.cs'), ['A/Customer.cs']);
  assert.deepEqual(g.imports('B/Global.cs'), ['A/Money.cs']);
  assert.deepEqual(g.imports('B/Attr.cs'), ['A/MarkerAttribute.cs']);
});

test('partial types link to every declaring file and never to self', () => {
  const g = build({
    'P/Basket1.cs': cls('Shop.Cart', 'Basket', '', '').replace('public class', 'public partial class'),
    'P/Basket2.cs': cls('Shop.Cart', 'Basket', '        void F() { }').replace('public class', 'public partial class'),
    'P/User.cs': cls('Shop.Cart', 'User', '        Basket b;'),
  });
  assert.deepEqual(g.imports('P/User.cs'), ['P/Basket1.cs', 'P/Basket2.cs']);
  assert.deepEqual(g.imports('P/Basket1.cs'), []);
});

test('namespace refs from ancestors are visible', () => {
  const g = build({
    'A/Root.cs': cls('Shop', 'Root'),
    'A/Leaf.cs': cls('Shop.Deep.Er', 'Leaf', '        Root r;'),
  });
  assert.deepEqual(g.imports('A/Leaf.cs'), ['A/Root.cs']);
});

test('declared-only: an unused injected property and a constructor-injected field that is only assigned', () => {
  const g = build({
    'S/Mailer.cs': cls('Shop.Svc', 'Mailer'),
    'S/Billing.cs': cls('Shop.Svc', 'Billing'),
    'S/Audit.cs': cls('Shop.Svc', 'Audit'),
    'S/Shipper.cs': cls('Shop.Svc', 'Shipper'),
    'S/Unused.cs': cls('Shop.Svc', 'Unused', '        [Dependency]\n        public Mailer Mailer { get; set; }\n        private readonly Billing _billing;\n        public Unused(Billing billing) { _billing = billing; }'),
    'S/Used.cs': cls('Shop.Svc', 'Used', '        [Dependency]\n        public Mailer Mailer { get; set; }\n        void Go() { Mailer.Send(); }'),
    'S/Mixed.cs': cls('Shop.Svc', 'Mixed', '        private readonly Audit _audit;\n        public Mixed(Audit audit) { _audit = audit; }\n        void Go() { _audit.Log(); }\n        void Make() { var s = new Shipper(); }\n        private readonly Shipper _s;'),
  });
  const a = g.edge('S/Unused.cs', 'S/Mailer.cs').attrs;
  assert.equal(a.declared_only, true);
  assert.equal(a.unused_member, 'Mailer');
  const b = g.edge('S/Unused.cs', 'S/Billing.cs').attrs;
  assert.equal(b.declared_only, true);
  assert.equal(b.unused_member, '_billing');
  assert.ok(!g.edge('S/Used.cs', 'S/Mailer.cs').attrs.declared_only);
  assert.ok(!g.edge('S/Mixed.cs', 'S/Audit.cs').attrs.declared_only, 'used member');
  assert.ok(!g.edge('S/Mixed.cs', 'S/Shipper.cs').attrs.declared_only, 'new T');
});

test('declared-only: a use inside an interpolated string counts', () => {
  const g = build({
    'S/Tool.cs': cls('Shop.Svc', 'Tool'),
    'S/Interp.cs': cls('Shop.Svc', 'Interp', '        private readonly Tool _tool;\n        public Interp(Tool tool) { _tool = tool; }\n        string F() { return $"x{_tool.Name}"; }'),
  });
  assert.ok(!g.edge('S/Interp.cs', 'S/Tool.cs').attrs.declared_only);
});

test('declared-only is not claimed for public contract members', () => {
  const g = build({
    'S/Tool.cs': cls('Shop.Svc', 'Tool'),
    'S/Pub.cs': cls('Shop.Svc', 'Pub', '        public Tool Tool { get; set; }'),
    'S/Iface.cs': 'namespace Shop.Svc\n{\n    public interface IHas\n    {\n        Tool Tool { get; set; }\n    }\n}\n',
  });
  assert.ok(!g.edge('S/Pub.cs', 'S/Tool.cs').attrs.declared_only);
  assert.ok(!g.edge('S/Iface.cs', 'S/Tool.cs').attrs.declared_only);
});

test('declared-only is not claimed for parameters, locals and static calls', () => {
  const g = build({
    'S/Tool.cs': cls('Shop.Svc', 'Tool'),
    'S/P.cs': cls('Shop.Svc', 'P', '        void F(Tool t) { }'),
    'S/L.cs': cls('Shop.Svc', 'L', '        void F() { Tool t = null; }'),
    'S/C.cs': cls('Shop.Svc', 'C', '        void F() { Tool.Run(); }'),
  });
  for (const f of ['P', 'L', 'C']) assert.ok(!g.edge(`S/${f}.cs`, 'S/Tool.cs').attrs.declared_only, f);
});

test('Entity Framework: fluent ToTable names the table, owned by the entity file', () => {
  const g = build({
    'D/Order.cs': cls('Shop.Data', 'Order'),
    'D/Line.cs': cls('Shop.Data', 'Line'),
    'D/Ctx.cs': 'namespace Shop.Data\n{\n    public class Ctx : DbContext\n    {\n        public DbSet<Order> Orders { get; set; }\n        protected void OnModelCreating(ModelBuilder modelBuilder)\n        {\n            modelBuilder.Entity<Order>().ToTable("tbl_orders");\n        }\n    }\n}\n',
    'D/LineMap.cs': 'namespace Shop.Data\n{\n    public class LineMap : IEntityTypeConfiguration<Line>\n    {\n        public void Configure(EntityTypeBuilder<Line> builder)\n        {\n            builder.ToTable("order_lines");\n        }\n    }\n}\n',
  });
  const owns = (to) => g.all.filter((f) => f.kind === 'edge' && f.type === 'OWNS_DATA' && f.to === `table:public.${to}`).map((f) => f.from);
  assert.deepEqual(owns('tbl_orders'), ['module:D/Order.cs']);
  assert.deepEqual(owns('order_lines'), ['module:D/Line.cs']);
  assert.deepEqual(owns('orders'), [], 'explicit mapping replaces the DbSet name guess');
});

test('link-only name sets are not left in persisted module attrs', () => {
  const g = build({ 'A/X.cs': cls('N', 'X'), 'A/Y.cs': cls('N', 'Y', '        X x;') });
  for (const facts of g.factsByFile.values()) {
    const m = facts.find((f) => f.type === 'module');
    assert.equal(m.attrs.refs, undefined);
    assert.equal(m.attrs.decl_only, undefined);
  }
});

// An injected member nobody uses, in the shapes it takes in practice, and the uses that must stay normal.
const unusedForms = {
  attrOwnLine: '        [Dependency]\n        public Tool Tool { get; set; }',
  attrArgs: '        [Dependency(Required = true)]\n        public Tool Tool { get; set; }',
  attrName: '        [Dependency("main")]\n        public Tool Tool { get; set; }',
  twoBrackets: '        [Obsolete]\n        [Dependency]\n        public Tool Tool { get; set; }',
  oneBracket: '        [Obsolete, Dependency(Required = true)]\n        public Tool Tool { get; set; }',
  virtualProp: '        [Dependency]\n        public virtual Tool Tool { get; set; }',
  protectedProp: '        [Inject]\n        protected Tool Tool { get; set; }',
  internalProp: '        [Inject]\n        internal Tool Tool { get; set; }',
  splitBody: '        [Dependency]\n        public Tool Tool\n        {\n            get;\n            set;\n        }',
  splitAccessors: '        [Dependency]\n        public Tool Tool\n        {\n            get;\n            private set;\n        }',
  fieldInject: '        [Inject] private Tool _tool;',
  fieldInjectOwnLine: '        [Inject]\n        private Tool _tool;',
  ctorField: '        private readonly Tool _tool;\n        public Host(Tool tool) { _tool = tool; }',
  ctorThis: '        private readonly Tool _tool;\n        public Host(Tool tool) { this._tool = tool; }',
  ctorGuard: '        private readonly Tool _tool;\n        public Host(Tool tool)\n        {\n            _tool = tool ?? throw new ArgumentNullException(nameof(tool));\n        }',
  ctorSplit: '        private readonly Tool _tool;\n        public Host(\n            Tool tool)\n        {\n            _tool = tool;\n        }',
  nameofType: '        [Dependency]\n        public Tool Tool { get; set; }\n        string N() { return nameof(Tool); }',
  nameofMember: '        private readonly Tool _tool;\n        public Host(Tool tool) { _tool = tool; }\n        string N() { return nameof(_tool); }',
};
const usedForms = {
  call: '        [Dependency]\n        public Tool Tool { get; set; }\n        void Go() { Tool.Run(); }',
  access: '        [Dependency]\n        public Tool Tool { get; set; }\n        int Go() { return Tool.Count; }',
  passedOn: '        [Dependency]\n        public Tool Tool { get; set; }\n        void Go() { Other(Tool); }',
  nullCond: '        [Inject] private Tool _tool;\n        void Go() { _tool?.Run(); }',
  ctorUsed: '        private readonly Tool _tool;\n        public Host(Tool tool) { _tool = tool ?? throw new ArgumentNullException(nameof(tool)); }\n        void Go() { _tool.Run(); }',
  ctorParamUsed: '        private readonly Tool _tool;\n        public Host(Tool tool) { _tool = tool; tool.Init(); }',
  arrow: '        [Dependency]\n        public virtual Tool Tool { get; set; }\n        int Go() => Tool.Count;',
};

test('declared-only: the forms an injected-but-unused member takes', () => {
  const missed = [];
  for (const [name, body] of Object.entries(unusedForms)) {
    const g = build({ 'S/Tool.cs': cls('Shop.Svc', 'Tool'), 'S/Host.cs': cls('Shop.Svc', 'Host', body) });
    const e = g.edge('S/Host.cs', 'S/Tool.cs');
    assert.ok(e, `${name}: edge`);
    if (!e.attrs.declared_only || !e.attrs.unused_member) missed.push(name);
  }
  assert.deepEqual(missed, []);
});

test('declared-only: a member that is used stays a normal edge', () => {
  const wrong = [];
  for (const [name, body] of Object.entries(usedForms)) {
    const g = build({ 'S/Tool.cs': cls('Shop.Svc', 'Tool'), 'S/Host.cs': cls('Shop.Svc', 'Host', body) });
    const e = g.edge('S/Host.cs', 'S/Tool.cs');
    assert.ok(e, `${name}: edge`);
    if (e.attrs.declared_only) wrong.push(name);
  }
  assert.deepEqual(wrong, []);
});

test('declared-only: a using alias of the type does not make an unused member used', () => {
  const g = build({
    'S/Tool.cs': cls('Shop.Svc', 'Tool'),
    'S/Host.cs': cls('Shop.Svc', 'Host', '        [Dependency]\n        public Tool Tool { get; set; }', 'using ToolAlias = Shop.Svc.Tool;\n'),
  });
  assert.equal(g.edge('S/Host.cs', 'S/Tool.cs').attrs.declared_only, true);
});
