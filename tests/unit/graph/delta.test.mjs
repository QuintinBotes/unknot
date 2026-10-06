import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';

after(() => K.cleanup());

const config = K.cfg({ mode: 'plan' });
const map = (p) => mapRepository(p.ctx, { config, configDigest: 'd', history: false });

/** The stored graph, minus what legitimately differs between maps (generation, time, commit). */
function dump(ctx) {
  const all = (sql) => ctx.store.all(sql);
  return {
    nodes: all('SELECT * FROM nodes ORDER BY id'),
    edges: all('SELECT * FROM edges ORDER BY id'),
    facts: all('SELECT id, kind, subject, predicate, object, attrs, source_type, source_ref, extractor, confidence, scope, contradicts, path, expires_at, digest FROM facts ORDER BY id'),
    derived: all("SELECT kind, key, body FROM derived WHERE kind != '_done' ORDER BY kind, key, body"),
  };
}

const initial = {
  'src/a.js': "import { b } from './b.js';\nexport const a = b + 1;\n",
  'src/b.js': 'export const b = 2;\n',
  'src/util.js': "import { a } from './a.js';\nexport function util() { return a; }\n",
  'src/old.js': "import { b } from './b.js';\nexport const old = b;\n",
  'src/shared.js': "import { util } from './util.js';\nexport const shared = util();\n",
  'app/svc.py': 'import os\nfrom app import helper\n\ndef run():\n    return helper.go()\n',
  'app/helper.py': 'def go():\n    if True:\n        return 1\n',
  'app/gone.py': 'import app.helper\n',
  'app/check.py': 'def test_it():\n    assert True\n',
  'svc/main.go': 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("x") }\n',
  'svc/dead.go': 'package main\n\nfunc dead() {}\n',
  'Lib/Orders.cs': 'namespace Lib { public class Orders { public int N() { return 1; } } }\n',
  'Lib/Gone.cs': 'namespace Lib { public class Gone { } }\n',
  'java/com/x/Svc.java': 'package com.x;\n\npublic class Svc { public int f() { return 1; } }\n',
  'tsrc/model.ts': "import { util } from '../src/util.js';\nexport const m = util;\n",
};

const final = {
  ...initial,
  'src/a.js': "import { b } from './b.js';\nimport { shared } from './shared.js';\nexport const a = b + shared;\nexport function more() { if (a) return 1; return 2; }\n", // changed
  'src/renamed.js': initial['src/old.js'], // renamed from src/old.js
  'app/svc.test.py': initial['app/check.py'], // becomes test code
  'tests/test_helper.py': 'from app import helper\n\ndef test_go():\n    assert helper.go() == 1\n', // added
  'Lib/Extra.cs': 'namespace Lib { public class Extra { } }\n', // added
  'svc/util.go': 'package main\n\nfunc util() int { return 1 }\n', // added
  'java/com/x/Svc.java': 'package com.x;\n\npublic class Svc { public int f() { return 2; } public int g() { return f(); } }\n', // changed
};
for (const gone of ['src/old.js', 'app/gone.py', 'app/check.py', 'Lib/Gone.cs', 'svc/dead.go']) delete final[gone];

const write = (dir, path, body) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
};

test('a delta re-map stores exactly the graph a cold map of the final tree stores', async () => {
  const p = K.makeProject({ files: initial });
  const first = await map(p);
  assert.equal(first.generation, 1);

  // Nothing changed: no rewrite, same generation, derived facts kept.
  const before = dump(p.ctx);
  const rowid = p.ctx.store.get('SELECT MAX(rowid) AS m FROM nodes').m;
  const same = await map(p);
  assert.equal(same.generation, 1);
  assert.deepEqual(dump(p.ctx), before);
  assert.equal(p.ctx.store.get('SELECT MAX(rowid) AS m FROM nodes').m, rowid);

  // Change, add, delete, rename, and a file that becomes test code.
  write(p.dir, 'src/a.js', final['src/a.js']);
  renameSync(join(p.dir, 'src/old.js'), join(p.dir, 'src/renamed.js'));
  renameSync(join(p.dir, 'app/check.py'), join(p.dir, 'app/svc.test.py'));
  for (const gone of ['app/gone.py', 'Lib/Gone.cs', 'svc/dead.go']) rmSync(join(p.dir, gone));
  for (const add of ['tests/test_helper.py', 'Lib/Extra.cs', 'svc/util.go', 'java/com/x/Svc.java']) write(p.dir, add, final[add]);
  K.git(p.dir, 'add', '-A');
  K.git(p.dir, 'commit', '-q', '-m', 'edit');
  const delta = await map(p);
  assert.equal(delta.generation, 2, 'the generation advances when the graph changed');
  assert.ok(delta.cache.hits > 0 && delta.cache.extracted > 0);

  const cold = K.makeProject({ files: final });
  const coldSummary = await map(cold);
  assert.equal(coldSummary.generation, 1);
  const a = dump(p.ctx);
  const b = dump(cold.ctx);
  assert.ok(a.nodes.length > 20 && a.edges.length > 20);
  for (const k of Object.keys(b)) assert.deepEqual(a[k], b[k], `${k} match a cold map`);
  assert.equal(delta.nodes, coldSummary.nodes);
  assert.equal(delta.edges, coldSummary.edges);
  assert.equal(p.ctx.store.meta('generation'), '2');
  assert.ok(p.ctx.store.get("SELECT 1 AS ok FROM derived WHERE kind = '_done' AND generation = 2"));
});
