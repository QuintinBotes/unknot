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
