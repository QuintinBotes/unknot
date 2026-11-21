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
  const parts = build(shop()).filter((f) => f.kind === 'edge' && f.type === 'CONTAINS' && f.from === t.id).map((e) => e.to).sort();
  assert.deepEqual(parts, ['class:A/Orders/Order.Audit.cs#Order', 'class:A/Orders/Order.Billing.cs#Order', 'class:A/Orders/Order.cs#Order']);
});

test('a use from inside one of its own parts does not count towards fan-in', () => {
  const facts = build(shop({ 'A/Orders/Order.Audit.cs': part('Shop.Orders', 'Audit').replace('public void Audit() { }', 'public void Audit() { }\n        Order Copy() { return null; }') }));
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
