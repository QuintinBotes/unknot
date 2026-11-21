// A C# partial type declared across several files is one logical type (#75).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../../../../adapters/language/generic/index.mjs';
import module_ from '../../../../runtime/diagnose/detectors/module.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';

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
  const linked = adapter.link({ files, factsByFile, options: {}, notes: [], stats: {} });
  linked.forEach(assertFact);
  return [...[...factsByFile.values()].flat(), ...linked];
}

const proj = '<Project Sdk="Microsoft.NET.Sdk"></Project>\n';
const part = (ns, method, mod = 'public partial ') => `namespace ${ns}\n{\n    ${mod}class Order\n    {\n        public void ${method}() { }\n    }\n}\n`;
const user = (i) => `using Shop.Orders;\nnamespace Shop.Web\n{\n    public class Page${i}\n    {\n        public void Show(Order o) { o.Ship(); }\n    }\n}\n`;
const shop = (extra = {}) => ({
  'A/A.csproj': proj,
  'A/Orders/Order.cs': part('Shop.Orders', 'Ship'),
  'A/Orders/Order.Billing.cs': part('Shop.Orders', 'Bill', 'partial '),
  'A/Orders/Order.Audit.cs': part('Shop.Orders', 'Audit'),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`A/Web/Page${i}.cs`, user(i)])),
  ...extra,
});
const logical = (facts) => facts.filter((f) => f.kind === 'node' && f.type === 'class' && f.attrs.partial && f.attrs.files);
const hubs = (facts) => module_.find((d) => d.id === 'module.hub-module').detect({ graph: Graph.fromFacts(facts), options: { fan_in: 10, fan_out: 0 } });

test('scenario 1: one hub finding for a partial type, with its fan-in of distinct files and its three declaration files', () => {
  const found = hubs(build(shop()));
  assert.equal(found.length, 1, JSON.stringify(found.map((f) => f.title)));
  assert.equal(found[0].measurements['module.fan_in'], 10);
  assert.deepEqual(found[0].scope, ['A/Orders/Order.Audit.cs', 'A/Orders/Order.Billing.cs', 'A/Orders/Order.cs']);
  assert.match(found[0].title, /Order/);
});

test('scenario 2: classes named Order in different namespaces stay two types', () => {
  const facts = build({ 'A/A.csproj': proj, 'A/One.cs': part('Shop.Orders', 'Ship'), 'A/Two.cs': part('Shop.Archive', 'Keep') });
  assert.deepEqual(logical(facts), []);
});

test('scenario 3: partial parts in two projects stay separate', () => {
  const facts = build({ 'A/A.csproj': proj, 'A/Order.cs': part('Shop.Orders', 'Ship'), 'B/B.csproj': proj, 'B/Order.cs': part('Shop.Orders', 'Bill') });
  assert.deepEqual(logical(facts), []);
});

test('scenario 4: the merged type lists the members of every part and every declaration file', () => {
  const [t] = logical(build(shop()));
  assert.ok(t, 'one logical type');
  assert.deepEqual(t.attrs.files, ['A/Orders/Order.Audit.cs', 'A/Orders/Order.Billing.cs', 'A/Orders/Order.cs']);
  assert.deepEqual(t.attrs.members, ['Audit', 'Bill', 'Ship']);
  // Each part keeps its module as its only container, so walking up from a method still reaches the file.
  assert.ok(!build(shop()).some((f) => f.kind === 'edge' && f.type === 'CONTAINS' && f.from === t.id));
});

test('a use from inside one of its own parts does not count towards fan-in', () => {
  // Order.Billing.cs uses a type only Order.cs declares: an edge between two parts of one type.
  const facts = build(shop({
    'A/Orders/Order.cs': part('Shop.Orders', 'Ship').replace('namespace Shop.Orders\n{', 'namespace Shop.Orders\n{\n    public enum OrderState { Open }'),
    'A/Orders/Order.Billing.cs': part('Shop.Orders', 'Bill', 'partial ').replace('public void Bill() { }', 'public void Bill() { }\n        OrderState state;'),
  }));
  assert.ok(facts.some((f) => f.kind === 'edge' && f.type === 'IMPORTS' && f.from === 'module:A/Orders/Order.Billing.cs' && f.to === 'module:A/Orders/Order.cs'), 'the part-to-part edge exists');
  const found = hubs(facts);
  assert.equal(found.length, 1);
  assert.equal(found[0].measurements['module.fan_in'], 10);
});

test('a nested partial type is merged under its containing type, not with every type of its name', () => {
  const nested = (outer, method) => `namespace Shop\n{\n    public partial class ${outer}\n    {\n        public partial class Builder\n        {\n            public void ${method}() { }\n        }\n    }\n}\n`;
  const facts = build({ 'A/A.csproj': proj, 'A/Order1.cs': nested('Order', 'One'), 'A/Order2.cs': nested('Order', 'Two'), 'A/Invoice1.cs': nested('Invoice', 'Three') });
  const keys = logical(facts).map((t) => t.id).sort();
  assert.deepEqual(keys, ['class:Shop.Order.Builder@A', 'class:Shop.Order@A']);
});

test('a nested partial type and its outer type are one hub, named after the outer type', () => {
  const nested = (method) => `namespace Shop\n{\n    public partial class Order\n    {\n        public partial class Builder\n        {\n            public void ${method}() { }\n        }\n    }\n}\n`;
  const users = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`A/Web/U${i}.cs`, `namespace Shop\n{\n    public class U${i}\n    {\n        public void F(Order o) { }\n    }\n}\n`]));
  const found = hubs(build({ 'A/A.csproj': proj, 'A/Order1.cs': nested('One'), 'A/Order2.cs': nested('Two'), ...users }));
  assert.equal(found.length, 1);
  assert.match(found[0].title, /^Order, a partial type in 2 files/);
});

test('two projects with the same name keep their partial types apart', () => {
  const facts = build({ 'v1/Api/Api.csproj': proj, 'v1/Api/Order.cs': part('Shop.Orders', 'Ship'), 'v2/Api/Api.csproj': proj, 'v2/Api/Order.cs': part('Shop.Orders', 'Bill') });
  assert.deepEqual(logical(facts), []);
});
