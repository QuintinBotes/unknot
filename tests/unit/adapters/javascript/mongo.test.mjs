import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../../../../adapters/language/javascript/index.mjs';

const project = (files) => {
  const factsByFile = new Map(Object.entries(files).map(([path, text]) => [path, adapter.extract({ path, language: 'javascript' }, text, { options: {} })]));
  const all = new Map([...Object.keys(files), '.meteor/release'].map((p) => [p, { path: p, language: 'javascript' }]));
  return adapter.link({ files: all, factsByFile, options: {} });
};

test('MongoDB collections: reads and writes resolve through imports and re-exports to the defining module', () => {
  const out = project({
    'imports/api/parcels/collection.js': "import { Mongo } from 'meteor/mongo';\nexport const Parcels = new Mongo.Collection('parcels');\n",
    'imports/api/parcels/index.js': "export { Parcels } from './collection';\n",
    'imports/api/delivery/methods.js': "import { Parcels } from '/imports/api/parcels';\nconst list = [1];\nexport function deliver(id) { list.find((x) => x); Parcels.update({ _id: id }, {}); return Parcels.findOne(id); }\nexport function audit(db) { return db.collection('audit').insertOne({}); }\n",
  });
  const tables = out.filter((f) => f.type === 'table').map((f) => [f.id, f.attrs.engine, f.attrs.orm]).sort();
  assert.deepEqual(tables, [['table:audit', 'mongodb', 'driver'], ['table:parcels', 'mongodb', 'meteor']]);
  const edges = out.filter((f) => f.kind === 'edge' && ['QUERIES', 'MUTATES'].includes(f.type)).map((e) => `${e.type} ${e.from} ${e.to}`).sort();
  assert.deepEqual(edges, [
    'MUTATES module:imports/api/delivery/methods.js table:audit',
    'MUTATES module:imports/api/delivery/methods.js table:parcels',
    'QUERIES module:imports/api/delivery/methods.js table:parcels',
  ]);
});

test('a named re-export resolves even when `export *` from the same module comes first (review regression)', () => {
  const out = project({
    'x.js': "import { Mongo } from 'meteor/mongo';\nconst T = new Mongo.Collection('t');\nexport default T;\n",
    'a.js': "export * from './x';\nexport Y from './x';\n",
    'b.js': "import { Y } from './a';\nexport const f = () => Y.find();\n",
  });
  assert.ok(out.some((e) => e.type === 'QUERIES' && e.from === 'module:b.js' && e.to === 'table:t'));
});

test('export default new Mongo.Collection resolves through a default import (review regression)', () => {
  const out = project({
    'c.js': "import { Mongo } from 'meteor/mongo';\nexport default new Mongo.Collection('tasks');\n",
    'u.js': "import Tasks from './c';\nexport const f = () => Tasks.insert({});\n",
  });
  assert.ok(out.some((e) => e.type === 'MUTATES' && e.from === 'module:u.js' && e.to === 'table:tasks'));
});

test('a file started by path from code is referenced, not dead (audit regression)', () => {
  const out = project({
    'src/adapters/commands.ts': "import { join } from 'node:path';\nconst here = import.meta.dirname;\nexport const cmd = [process.execPath, join(here, 'hook-main.ts')];\n",
    'src/adapters/hook-main.ts': "await run();\n",
  });
  assert.ok(out.some((e) => e.type === 'REFERENCES' && e.from === 'module:src/adapters/commands.ts' && e.to === 'module:src/adapters/hook-main.ts'));
});
