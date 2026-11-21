// Build-unit package nodes are keyed by manifest path, so same-named projects stay separate (#109).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { decompose } = await import('../../../runtime/decompose/index.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { unitModel } = await import('../../../runtime/artifacts/model.mjs');
const { supersededBy } = await import('../../../runtime/decompose/records.mjs');

const csproj = (refs = '') => `<Project Sdk="Microsoft.NET.Sdk">${refs ? `<ItemGroup>${refs}</ItemGroup>` : ''}</Project>\n`;
const cs = (ns, name, body = '', using = '') => `${using ? `using ${using};\n` : ''}namespace ${ns}\n{\n    public class ${name}\n    {\n        ${body}\n    }\n}\n`;
const twoApis = {
  'services/billing/Api/Api.csproj': csproj(),
  'services/billing/Api/Invoice.cs': cs('Billing.Api', 'Invoice'),
  'services/billing/Api/Ledger.cs': cs('Billing.Api', 'Ledger', 'Invoice i;'),
  'services/shipping/Api/Api.csproj': csproj(),
  'services/shipping/Api/Parcel.cs': cs('Shipping.Api', 'Parcel'),
  'services/shipping/Api/Route.cs': cs('Shipping.Api', 'Route', 'Parcel p;'),
  'services/billing/Web/Web.csproj': csproj('<ProjectReference Include="../Api/Api.csproj" />'),
  'services/billing/Web/Page.cs': cs('Billing.Web', 'Page', 'Invoice i;', 'Billing.Api'),
};
const BILLING = 'package:services/billing/Api/Api.csproj';
const SHIPPING = 'package:services/shipping/Api/Api.csproj';

const net = await analyse('dotnet-projects', { extra: twoApis, skipDiagnose: true });
const netGraph = Graph.fromStore(net.ctx.store);
const netOut = await decompose(net.ctx, { config: net.config, dryRun: true });

test('scenario 1: two .NET projects named Api are two package nodes keyed by manifest path, each with only its own files', () => {
  assert.ok(!netGraph.node('package:Api'));
  for (const [id, dir] of [[BILLING, 'services/billing/Api'], [SHIPPING, 'services/shipping/Api']]) {
    assert.equal(netGraph.node(id)?.name, 'Api');
    const files = netGraph.out(id, 'CONTAINS').map((e) => e.to).sort();
    assert.ok(files.length === 2 && files.every((f) => f.startsWith(`module:${dir}/`)), `${id}: ${files}`);
  }
});

test('a ProjectReference resolves to the manifest at the referenced path, not to any project of that name', () => {
  const deps = netGraph.out('package:services/billing/Web/Web.csproj', 'DEPENDS_ON').map((e) => e.to);
  assert.deepEqual(deps, [BILLING]);
});

test('names stay short and add the shortest distinguishing path only when two units share one', () => {
  const units = netOut.details.flatMap((d) => d.candidate.units);
  const name = (id) => units.find((u) => u.id === id)?.name;
  assert.equal(name(BILLING), 'billing/Api');
  assert.equal(name(SHIPPING), 'shipping/Api');
  assert.equal(name('package:services/billing/Web/Web.csproj'), 'Web');
  assert.equal(name('package:src/Shop.Orders/Shop.Orders.csproj'), 'Shop.Orders');
});

test('the architecture model keeps two same-named packages as two units', () => {
  const { units } = unitModel(netGraph).pkg;
  const apis = units.filter((u) => u.type === 'package' && u.node?.name === 'Api');
  assert.deepEqual(apis.map((u) => u.name).sort(), ['billing/Api', 'shipping/Api']);
  assert.equal(new Set(units.map((u) => u.id)).size, units.length);
});

const java = (pkg, name, body = '') => `package ${pkg};\n\npublic class ${name} {\n    ${body}\n}\n`;
const gradle = await analyse('dotnet-projects', {
  skipDiagnose: true,
  extra: {
    'jvm/settings.gradle': "rootProject.name = 'jvm'\ninclude ':a:core', ':b:core', ':app'\n",
    'jvm/a/core/build.gradle': "plugins { id 'java' }\n",
    'jvm/a/core/src/main/java/a/core/Alpha.java': java('a.core', 'Alpha'),
    'jvm/a/core/src/main/java/a/core/Beta.java': java('a.core', 'Beta', 'Alpha a;'),
    'jvm/b/core/build.gradle': "plugins { id 'java' }\n",
    'jvm/b/core/src/main/java/b/core/Gamma.java': java('b.core', 'Gamma'),
    'jvm/b/core/src/main/java/b/core/Delta.java': java('b.core', 'Delta', 'Gamma g;'),
    'jvm/app/build.gradle': "plugins { id 'java' }\ndependencies { implementation project(':a:core') }\n",
    'jvm/app/src/main/java/app/Main.java': 'package app;\n\nimport a.core.Alpha;\n\npublic class Main {\n    Alpha a;\n}\n',
  },
});

test('scenario 2: two Gradle subprojects with the same leaf name are separate modules whose names include their path', async () => {
  const out = await decompose(gradle.ctx, { config: gradle.config, dryRun: true });
  const units = out.details.flatMap((d) => d.candidate.units);
  const core = units.filter((u) => u.id.endsWith('/core/build.gradle'));
  assert.deepEqual(core.map((u) => u.id).sort(), ['package:jvm/a/core/build.gradle', 'package:jvm/b/core/build.gradle']);
  assert.deepEqual(core.map((u) => u.name).sort(), ['a/core', 'b/core']);
  for (const u of core) assert.ok(u.files.length === 2 && u.files.every((f) => f.startsWith(`module:jvm/${u.name}/`)), JSON.stringify(u));
});

test('scenario 3: a record written when build units were keyed by name is reported as replaced', () => {
  const old = { id: 'DEC-0001', target: 'backend', fingerprint: 'f1', graph_generation: 2, candidate: { modules: ['module:a/A.cs'], units: [{ id: 'package:Api', name: 'Api', kind: 'build_unit', files: ['module:a/A.cs'] }] } };
  const now = { id: 'DEC-0002', target: 'backend', fingerprint: 'f2', graph_generation: 3, candidate: { modules: ['module:a/A.cs'], units: [{ id: 'package:a/Api.csproj', name: 'Api', kind: 'build_unit', manifest: 'a/Api.csproj', files: ['module:a/A.cs'] }] } };
  assert.match(supersededBy(old, [old, now], 3), /keyed by name.*now keyed by manifest path \(as in DEC-0002\)/);
  assert.equal(supersededBy(now, [old, now], 3), null);
});
