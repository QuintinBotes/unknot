// Lexical references follow the declared build graph (#71): a file in project P links only to
// declarations in P or in a project P reaches through project references, and never to a type
// the language hides from P.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import adapter from '../../../../adapters/language/generic/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { mapRepository } from '../../../../runtime/graph/builder.mjs';
import * as K from '../../../helpers/kernel.mjs';

after(() => K.cleanup());

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
  const notes = [];
  const stats = {};
  const linked = adapter.link({ files, factsByFile, options: {}, resolve: null, notes, stats });
  linked.forEach(assertFact);
  const all = [...[...factsByFile.values()].flat(), ...linked];
  const targets = (type, from) => all.filter((f) => f.kind === 'edge' && f.type === type && f.from === `module:${from}` && f.to.startsWith('module:')).map((e) => e.to.slice(7)).sort();
  return { all, notes, stats, imports: (from) => targets('IMPORTS', from), calls: (from) => targets('CALLS', from) };
}

const cls = (ns, name, body = '', head = '', mod = 'public ') => `${head}namespace ${ns}\n{\n    ${mod}class ${name}\n    {\n${body}\n    }\n}\n`;
const proj = (...refs) => `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${refs.map((r) => `    <ProjectReference Include="${r}" />`).join('\n')}\n  </ItemGroup>\n</Project>\n`;

test('scenario 1: of two same-named types, only the one in the user\'s own project links', () => {
  const g = build({
    'A/A.csproj': proj(),
    'A/Order.cs': cls('Shared.Models', 'Order', '        public void Ship() { }'),
    'A/Use.cs': cls('Shared.Models', 'Use', '        void F() { Order o = new Order(); o.Ship(); }'),
    'B/B.csproj': proj(),
    'B/Order.cs': cls('Shared.Models', 'Order', '        public void Ship() { }'),
  });
  assert.deepEqual(g.imports('A/Use.cs'), ['A/Order.cs']);
  assert.deepEqual(g.calls('A/Use.cs'), ['A/Order.cs']);
});

test('scenario 2: a type declared only in a referenced project links to it', () => {
  const g = build({
    'A/A.csproj': proj('..\\B\\B.csproj'),
    'A/Use.cs': cls('Shop.App', 'Use', '        Invoice i;', 'using Shop.Billing;\n'),
    'B/B.csproj': proj(),
    'B/Invoice.cs': cls('Shop.Billing', 'Invoice'),
  });
  assert.deepEqual(g.imports('A/Use.cs'), ['B/Invoice.cs']);
});

test('scenario 3: an internal type of a referenced project is hidden unless InternalsVisibleTo names the user', () => {
  const sources = (extra = {}) => ({
    'A/A.csproj': proj('../B/B.csproj'),
    'A/Use.cs': cls('Shop.App', 'Use', '        Helper h; Quiet q;', 'using Shop.Core;\n'),
    'B/B.csproj': proj(),
    'B/Helper.cs': cls('Shop.Core', 'Helper', '', '', 'internal '),
    'B/Quiet.cs': cls('Shop.Core', 'Quiet', '', '', ''),
    ...extra,
  });
  assert.deepEqual(build(sources()).imports('A/Use.cs'), []);
  // A friend assembly, named in the project file or by an assembly attribute, sees them.
  const friendProj = '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <InternalsVisibleTo Include="A" />\n  </ItemGroup>\n</Project>\n';
  assert.deepEqual(build(sources({ 'B/B.csproj': friendProj })).imports('A/Use.cs'), ['B/Helper.cs', 'B/Quiet.cs']);
  const attr = '[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("A, PublicKey=0024")]\n';
  assert.deepEqual(build(sources({ 'B/Properties/AssemblyInfo.cs': attr })).imports('A/Use.cs'), ['B/Helper.cs', 'B/Quiet.cs']);
  // Another assembly named as a friend changes nothing for A.
  assert.deepEqual(build(sources({ 'B/Properties/AssemblyInfo.cs': attr.replace('"A,', '"A.Tests,') })).imports('A/Use.cs'), []);
});

test('scenario 3: a public partial declaration makes every part of the type visible', () => {
  const g = build({
    'A/A.csproj': proj('../B/B.csproj'),
    'A/Use.cs': cls('Shop.App', 'Use', '        Basket b;', 'using Shop.Core;\n'),
    'B/B.csproj': proj(),
    'B/Basket1.cs': cls('Shop.Core', 'Basket', '', '', 'public partial '),
    'B/Basket2.cs': cls('Shop.Core', 'Basket', '', '', 'partial '),
  });
  assert.deepEqual(g.imports('A/Use.cs'), ['B/Basket1.cs', 'B/Basket2.cs']);
});

test('scenario 4: a name after a member access is never a type reference', () => {
  for (const access of ['order.Status', 'order. Status', 'order.\n            Status', 'order?. Status']) {
    const g = build({
      'A/Use.cs': cls('Shop.App', 'Use', `        object F(Order order) { return ${access}; }`, 'using Shop.Models;\n'),
      'A/Order.cs': cls('Shop.Models', 'Order'),
      'A/Status.cs': cls('Shop.Models', 'Status'),
    });
    assert.deepEqual(g.imports('A/Use.cs'), ['A/Order.cs'], access);
  }
});

test('scenario 5: a namespace declared in two projects resolves through the referenced one', () => {
  const g = build({
    'A/A.csproj': proj('../B/B.csproj'),
    'A/Use.cs': cls('Shop.App', 'Use', '        Customer c;', 'using Shared.Models;\n'),
    'B/B.csproj': proj(),
    'B/Customer.cs': cls('Shared.Models', 'Customer'),
    'C/C.csproj': proj(),
    'C/Customer.cs': cls('Shared.Models', 'Customer'),
  });
  assert.deepEqual(g.imports('A/Use.cs'), ['B/Customer.cs']);
});

test('scenario 6: a public type of a transitively referenced project is reachable', () => {
  const g = build({
    'A/A.csproj': proj('../B/B.csproj'),
    'A/Use.cs': cls('Shop.App', 'Use', '        Ledger l;', 'using Shop.Data;\n'),
    'B/B.csproj': proj('../C/C.csproj'),
    'C/C.csproj': proj(),
    'C/Ledger.cs': cls('Shop.Data', 'Ledger'),
  });
  assert.deepEqual(g.imports('A/Use.cs'), ['C/Ledger.cs']);
});

test('the build graph never limits a file that belongs to no project', () => {
  const g = build({
    'scripts/Tool.cs': cls('Shared.Models', 'Tool', '        Order o;'),
    'A/A.csproj': proj(),
    'A/Order.cs': cls('Shared.Models', 'Order'),
    'B/B.csproj': proj(),
    'B/Order.cs': cls('Shared.Models', 'Order'),
  });
  assert.deepEqual(g.imports('scripts/Tool.cs'), ['A/Order.cs', 'B/Order.cs']);
});

test('a project file that cannot be read keeps name matching, and the map says so', () => {
  const g = build({
    'A/A.csproj': 'not a project file\n',
    'A/Use.cs': cls('Shared.Models', 'Use', '        Order o;'),
    'B/B.csproj': proj(),
    'B/Order.cs': cls('Shared.Models', 'Order'),
  });
  assert.deepEqual(g.imports('A/Use.cs'), ['B/Order.cs']);
  assert.ok(g.notes.some((n) => n.includes('A/A.csproj')), JSON.stringify(g.notes));
});

test('a reference through an MSBuild property leaves the project unrestricted; a reference spelled in another case still counts', () => {
  const g = build({
    'A/A.csproj': proj('$(SolutionDir)B\\B.csproj'),
    'A/Use.cs': cls('Shared.Models', 'Use', '        Order o;'),
    'B/B.csproj': proj(),
    'B/Order.cs': cls('Shared.Models', 'Order'),
    'C/C.csproj': proj('..\\b\\b.csproj'),
    'C/Use.cs': cls('Shared.Models', 'Other', '        Order o;'),
  });
  assert.deepEqual(g.imports('A/Use.cs'), ['B/Order.cs']);
  assert.deepEqual(g.imports('C/Use.cs'), ['B/Order.cs']);
  assert.ok(g.notes.some((n) => n.includes('A/A.csproj')), JSON.stringify(g.notes));
});

test('a linked source file belongs to every project that compiles it', () => {
  const linked = (projects) => build({
    'Shared/Link.cs': cls('Shop.Shared', 'Link', '        Widget w;', 'using Shop.Ui;\n'),
    'A/A.csproj': projects.includes('A') ? proj().replace('<ItemGroup>', '<ItemGroup>\n    <Compile Include="..\\Shared\\Link.cs" Link="Link.cs" />') : proj(),
    'B/B.csproj': projects.includes('B') ? proj().replace('<ItemGroup>', '<ItemGroup>\n    <Compile Include="../Shared/Link.cs" />') : proj(),
    'B/Widget.cs': cls('Shop.Ui', 'Widget'),
  });
  assert.deepEqual(linked(['A']).imports('Shared/Link.cs'), []);
  assert.deepEqual(linked(['A', 'B']).imports('Shared/Link.cs'), ['B/Widget.cs']);
});

test('Java: a package-private class is not linked from another package', () => {
  const g = build({
    'a/src/main/java/com/x/Use.java': 'package com.x;\nimport com.y.Helper;\nimport com.y.Open;\npublic class Use { Helper h; Open o; }\n',
    'b/src/main/java/com/y/Helper.java': 'package com.y;\nclass Helper { }\n',
    'b/src/main/java/com/y/Open.java': 'package com.y;\npublic class Open { }\n',
    'b/src/main/java/com/y/Near.java': 'package com.y;\npublic class Near { Helper h; }\n',
  });
  assert.deepEqual(g.imports('a/src/main/java/com/x/Use.java'), ['b/src/main/java/com/y/Open.java']);
  assert.deepEqual(g.imports('b/src/main/java/com/y/Near.java'), ['b/src/main/java/com/y/Helper.java']);
});

test('Kotlin: an internal class is not linked from another module', () => {
  const g = build({
    'app/build.gradle': "dependencies { implementation project(':core') }\n",
    'app/src/main/kotlin/com/x/Use.kt': 'package com.x\nimport com.y.Helper\nimport com.y.Open\nclass Use(val h: Helper, val o: Open)\n',
    'core/build.gradle': '\n',
    'core/src/main/kotlin/com/y/Helper.kt': 'package com.y\ninternal class Helper\n',
    'core/src/main/kotlin/com/y/Open.kt': 'package com.y\nclass Open\n',
  });
  assert.deepEqual(g.imports('app/src/main/kotlin/com/x/Use.kt'), ['core/src/main/kotlin/com/y/Open.kt']);
});

test('FR-005: the map summary counts the candidate edges the build graph rejected', async () => {
  const p = K.makeProject({ files: {
    'A/A.csproj': proj(),
    'A/Order.cs': cls('Shared.Models', 'Order'),
    'A/Use.cs': cls('Shared.Models', 'Use', '        Order o; Invoice i;'),
    'B/B.csproj': proj(),
    'B/Order.cs': cls('Shared.Models', 'Order'),
    'B/Invoice.cs': cls('Shared.Models', 'Invoice'),
  } });
  const r = await mapRepository(p.ctx, { config: K.cfg({ mode: 'plan' }), configDigest: 'd', scope: [], history: false });
  assert.deepEqual(r.build_graph, { rejected: 2 });
});
