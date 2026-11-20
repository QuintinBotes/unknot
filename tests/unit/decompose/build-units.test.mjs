// The build unit is the default module for compiled languages (#74): a .NET project, a Maven or
// Gradle module or a crate is one module of the decomposition, and its files are the drill-down.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { decompose } = await import('../../../runtime/decompose/index.mjs');
const { sizeBandFor } = await import('../../../runtime/decompose/candidates.mjs');
const { run: graphCli } = await import('../../../runtime/cli/commands/graph.mjs');
const { parseArgs } = await import('../../../runtime/cli/util.mjs');

async function run(name, { config = {}, extra = {} } = {}) {
  const r = await analyse(name, { config, extra, skipDiagnose: true });
  return { ...r, out: await decompose(r.ctx, { config: r.config, dryRun: true }) };
}

const UNITS = ['package:Shop.Catalog', 'package:Shop.Orders', 'package:Shop.Web'];
const shop = await run('dotnet-projects');

test('scenario 1: a C# repository of three projects has exactly three modules, one per project', () => {
  assert.equal(shop.out.analyses.backend.modules, 3);
  assert.deepEqual(shop.out.analyses.backend.units, UNITS);
  assert.equal(shop.out.analyses.backend.files, 12);
});

test('scenario 2: each candidate is named after the projects it contains', () => {
  assert.ok(shop.out.details.length >= 1);
  for (const d of shop.out.details) {
    assert.equal(d.candidate.name_basis, 'build_unit');
    const names = d.candidate.units.map((u) => u.name);
    assert.ok(names.every((n) => UNITS.includes(`package:${n}`)), JSON.stringify(d.candidate.units));
    assert.equal(d.candidate.name, names.join(' + '));
  }
});

test('scenario 3: a module lists its member files, in the record and in graph node', async () => {
  const d = shop.out.details[0];
  for (const u of d.candidate.units) {
    assert.equal(u.kind, 'build_unit');
    assert.ok(u.files.length === 4 && u.files.every((f) => f.startsWith(`module:src/${u.name}/`)), JSON.stringify(u));
    for (const f of u.files) assert.ok(d.candidate.modules.includes(f));
  }
  const { positional, flags } = parseArgs(['node', 'package:Shop.Orders', '--cwd', shop.dir]);
  let out = '';
  const w = process.stdout.write;
  process.stdout.write = (c) => { out += c; return true; };
  try { await graphCli({ positional, flags }); } finally { process.stdout.write = w; }
  const files = JSON.parse(out).out.filter((e) => e.type === 'CONTAINS').map((e) => e.dst).sort();
  assert.deepEqual(files, [0, 1, 2, 3].map((i) => `module:src/Shop.Orders/Order${i}.cs`));
});

test('scenario 4: without a configured size band the band is derived from the number of modules and printed', () => {
  assert.deepEqual(sizeBandFor(100), [5, 20]);
  assert.deepEqual(sizeBandFor(30000), [87, 346]);
  assert.ok(shop.out.details[0].heuristics_used.includes('size_band=2-3 (derived from 3 modules)'), JSON.stringify(shop.out.details[0].heuristics_used));
});

test('scenario 5: a configured size band is used unchanged', async () => {
  const r = await run('dotnet-projects', { config: { decomposition: { size_band: [3, 9] } } });
  assert.ok(r.out.details[0].heuristics_used.includes('size_band=3-9'), JSON.stringify(r.out.details[0].heuristics_used));
});

test('scenario 6: a JavaScript repository keeps one module per file', async () => {
  const r = await run('modular-monolith');
  assert.equal(r.out.analyses.backend.units, undefined);
  for (const d of r.out.details) {
    assert.equal(d.candidate.units, undefined);
    assert.notEqual(d.candidate.name_basis, 'build_unit');
  }
});

test('a repository of one or two projects keeps one module per file', async () => {
  const r = await run('equivalent-csharp');
  assert.equal(r.out.analyses.backend.units, undefined);
});

test('a file in no project stays its own module, and the record says which', async () => {
  const seed = 'using Shop.Orders;\nnamespace Shop.Tools\n{\n    public class Seed\n    {\n        Order0 o;\n    }\n}\n';
  const r = await run('dotnet-projects', { extra: { 'tools/Seed.cs': seed } });
  assert.deepEqual(r.out.analyses.backend.units, ['module:tools/Seed.cs', ...UNITS]);
  const loose = r.out.details.flatMap((d) => d.candidate.units).find((u) => u.id === 'module:tools/Seed.cs');
  assert.deepEqual(loose, { id: 'module:tools/Seed.cs', name: 'tools/Seed.cs', kind: 'file', files: ['module:tools/Seed.cs'] });
});
