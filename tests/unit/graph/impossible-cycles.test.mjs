// A file cycle across build units the build cannot have in a cycle is flagged, not trusted (#72).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as K from '../../helpers/kernel.mjs';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
after(() => K.cleanup());

const cls = (ns, name, body, using) => `using ${using};\nnamespace ${ns}\n{\n    public class ${name}\n    {\n        ${body}\n    }\n}\n`;
// B references A. A's references cannot be read (a `$(...)` path), so its file may still name B's
// type lexically: the edge from A to B goes against the declared direction.
const dotnet = {
  'A/A.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="$(RepoRoot)Other/Other.csproj" /></ItemGroup></Project>\n',
  'A/Ledger.cs': cls('Shop.A', 'Ledger', 'Invoice i;', 'Shop.B'),
  'B/B.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../A/A.csproj" /></ItemGroup></Project>\n',
  'B/Invoice.cs': cls('Shop.B', 'Invoice', 'Ledger l;', 'Shop.A'),
};

function cli(dir, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--cwd', dir], { encoding: 'utf8', env: { ...process.env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function repo(files) {
  const p = K.makeProject({ files, config: 'version: 1\nmode: plan\n' });
  return p.dir;
}

const csDir = repo(dotnet);
const mapped = cli(csDir, 'map', '--no-history');

test('scenario 1: map warns on stderr, naming both projects and the edge against the declared reference', () => {
  assert.equal(mapped.code, 0, mapped.err);
  assert.match(mapped.err, /cycle across build units A and B cannot be built/);
  assert.match(mapped.err, /A\/Ledger\.cs → B\/Invoice\.cs \(A does not reference B\)/);
  assert.doesNotMatch(mapped.err, /B\/Invoice\.cs → A\/Ledger\.cs/);
});

test('scenario 2: graph cycles marks the cycle impossible_by_build with the same closing edges', () => {
  const r = cli(csDir, 'graph', 'cycles', '--json');
  const [c] = JSON.parse(r.out);
  assert.equal(c.impossible_by_build, true);
  assert.deepEqual(c.build_units, ['A', 'B']);
  assert.deepEqual(c.closing_edges, [{ from: 'module:A/Ledger.cs', to: 'module:B/Invoice.cs', from_unit: 'A', to_unit: 'B' }]);
  assert.match(cli(csDir, 'graph', 'cycles').err, /cycle across build units A and B cannot be built/);
});

test('scenario 3: a cycle wholly inside one project prints no warning', () => {
  const dir = repo({
    'A/A.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'A/Ledger.cs': cls('Shop.A', 'Ledger', 'Invoice i;', 'System'),
    'A/Invoice.cs': cls('Shop.A', 'Invoice', 'Ledger l;', 'System'),
  });
  const r = cli(dir, 'map', '--no-history');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /cannot be built/);
  const [c] = JSON.parse(cli(dir, 'graph', 'cycles', '--json').out);
  assert.equal(c.impossible_by_build, undefined);
});

test('scenario 4: a JavaScript cycle across two packages prints no warning', () => {
  const dir = repo({
    'packages/a/package.json': '{"name":"a"}\n',
    'packages/a/index.js': "import { b } from '../b/index.js';\nexport const a = () => b;\n",
    'packages/b/package.json': '{"name":"b"}\n',
    'packages/b/index.js': "import { a } from '../a/index.js';\nexport const b = () => a;\n",
  });
  const r = cli(dir, 'map', '--no-history');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /cannot be built/);
});

test('scenario 5: explain names the mark in the uncertainty of a finding built on the cycle', () => {
  const d = cli(csDir, 'diagnose', '--json');
  const f = JSON.parse(d.out).findings.find((x) => x.kind === 'module.dependency-cycle');
  assert.ok(f, d.out.slice(0, 400));
  const e = cli(csDir, 'explain', f.id);
  assert.match(e.out, /impossible_by_build/);
});

test('a Go cycle across two packages is impossible: Go refuses import cycles', () => {
  const dir = repo({
    'go.mod': 'module example.com/shop\n',
    'a/a.go': 'package a\nimport "example.com/shop/b"\nfunc A() int { return b.B() }\n',
    'b/b.go': 'package b\nimport "example.com/shop/a"\nfunc B() int { return a.A() }\n',
  });
  const r = cli(dir, 'map', '--no-history');
  assert.match(r.err, /cycle across build units a and b cannot be built/);
});

test('a unit whose project file cannot be read raises no warning on its account', () => {
  const dir = repo({ ...dotnet, 'A/A.csproj': 'not a project\n' });
  const r = cli(dir, 'map', '--no-history');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /cannot be built/);
});

test('facts an older version stored for the same generation are recomputed with the mark', async () => {
  const { openProject } = await import('../../../runtime/context.mjs');
  const ctx = openProject(csDir);
  ctx.store.run("UPDATE derived SET body = json_remove(body, '$.impossible_by_build', '$.build_units', '$.closing_edges') WHERE kind = 'scc'");
  ctx.store.run("UPDATE derived SET body = '{}' WHERE kind = '_done'");
  ctx.store.close();
  const [c] = JSON.parse(cli(csDir, 'graph', 'cycles', '--json').out);
  assert.equal(c.impossible_by_build, true);
});
