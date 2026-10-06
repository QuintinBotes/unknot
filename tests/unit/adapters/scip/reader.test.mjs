// The SCIP protobuf reader: the field subset Unknot uses, unknown fields skipped by wire type,
// documents streamed one at a time (also across the read window), truncation reported.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { descriptors, classify } from '../../../../adapters/semantic/scip/symbols.mjs';
import { ROLE as R, scipRecords } from '../../../../adapters/semantic/scip/reader.mjs';
import * as S from '../../../helpers/scip.mjs';

const dir = mkdtempSync(join(tmpdir(), 'uk-scip-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, buf) => {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
};

const A = S.sym('Shop', 'Order', 'Total.');
const B = S.sym('Shop', 'IOrder');

test('reads the metadata, documents, occurrences, symbols and relationships of the subset', () => {
  const p = file('a.scip', S.index({
    projectRoot: 'file:///work/shop',
    external: [{ symbol: 'scip-dotnet nuget Lib 1.0 Lib/X#', kind: S.KIND.Class }],
    documents: [S.document({
      path: 'Shop/Order.cs',
      occurrences: [
        { range: [3, 8, 13], symbol: A, roles: S.ROLE.Definition, enclosing: [3, 4, 5, 6] },
        { range: [9, 1, 11, 2], symbol: A, roles: S.ROLE.ReadAccess | S.ROLE.WriteAccess },
        { range: [0, 0, 1], symbol: 'local 4' },
      ],
      symbols: [{ symbol: A, kind: S.KIND.Property, displayName: 'Total', enclosing: 'x', relationships: [{ symbol: B, implementation: true, reference: true }] }],
    })],
  }));
  const recs = [...scipRecords(p)];
  assert.deepEqual(recs.map((r) => r.type), ['metadata', 'document', 'external']);
  assert.equal(recs[0].value.project_root, 'file:///work/shop');
  assert.deepEqual(recs[0].value.tool, { name: 'scip-test', version: '0.0.1' });
  const d = recs[1].value;
  assert.equal(d.relative_path, 'Shop/Order.cs');
  assert.equal(d.language, 'csharp');
  assert.deepEqual(d.occurrences.map((o) => o.range), [[3, 8, 13], [9, 1, 11, 2], [0, 0, 1]]);
  assert.deepEqual(d.occurrences[0].enclosing, [3, 4, 5, 6]);
  assert.equal(d.occurrences[0].roles & R.Definition, R.Definition);
  assert.equal(d.occurrences[1].roles, R.ReadAccess | R.WriteAccess);
  assert.equal(d.occurrences[1].symbol, A);
  assert.deepEqual(d.symbols[0], {
    symbol: A, kind: S.KIND.Property, display_name: 'Total', enclosing_symbol: 'x',
    relationships: [{ symbol: B, is_reference: true, is_implementation: true, is_type_definition: false, is_definition: false }],
  });
  assert.equal(recs[2].value.symbol, 'scip-dotnet nuget Lib 1.0 Lib/X#');
});

test('unknown fields of every wire type are skipped at every level', () => {
  const doc = S.document({
    path: 'a.cs',
    unknown: true,
    occurrences: [{ range: [0, 1, 2], symbol: A, roles: S.ROLE.Definition, unknown: true }],
    symbols: [{ symbol: A, unknown: true, relationships: [{ symbol: B, implementation: true, unknown: true }] }],
  });
  const p = file('unknown.scip', S.index({ documents: [doc], unknown: true }));
  const recs = [...scipRecords(p)];
  assert.deepEqual(recs.map((r) => r.type), ['metadata', 'document']);
  const d = recs[1].value;
  assert.equal(d.relative_path, 'a.cs');
  assert.equal(d.occurrences.length, 1);
  assert.equal(d.occurrences[0].symbol, A);
  assert.equal(d.symbols[0].relationships[0].is_implementation, true);
});

test('a document larger than the read window, and many small ones, stream without loss', () => {
  const big = S.document({
    path: 'big.cs',
    occurrences: Array.from({ length: 60_000 }, (_, i) => ({ range: [i, 0, 5], symbol: A, roles: i % 2 ? 0 : S.ROLE.Definition })),
  });
  const small = Array.from({ length: 3000 }, (_, i) => S.document({ path: `s${i}.cs`, occurrences: [{ range: [0, 0, 1], symbol: B }] }));
  const buf = S.index({ documents: [small[0], big, ...small.slice(1)] });
  assert.ok(buf.length > 1 << 20, `the index is ${buf.length} bytes`);
  const docs = [...scipRecords(file('big.scip', buf))].filter((r) => r.type === 'document').map((r) => r.value);
  assert.equal(docs.length, 3001);
  assert.equal(docs[1].relative_path, 'big.cs');
  assert.equal(docs[1].occurrences.length, 60_000);
  assert.equal(docs[3000].relative_path, 's2999.cs');
});

test('pathsOnly yields document paths without decoding occurrences', () => {
  const p = file('paths.scip', S.index({ documents: [S.document({ path: 'x.cs', occurrences: [{ range: [0, 0, 1], symbol: A }] })] }));
  const d = [...scipRecords(p, { pathsOnly: true })].find((r) => r.type === 'document').value;
  assert.equal(d.relative_path, 'x.cs');
  assert.equal(d.occurrences.length, 0);
});

test('a truncated or malformed file is an error, not a silent partial read', () => {
  const full = S.index({ documents: [S.document({ path: 'x.cs', occurrences: [{ range: [0, 0, 1], symbol: A }] })] });
  assert.throws(() => [...scipRecords(file('cut.scip', full.subarray(0, full.length - 4)))], RangeError);
  // A group-start tag (wire type 3) cannot be skipped.
  assert.throws(() => [...scipRecords(file('group.scip', Buffer.from([0x0b, 0x00])))], /wire type 3/);
  assert.deepEqual([...scipRecords(file('empty.scip', Buffer.alloc(0)))], []);
});

test('symbol strings: descriptors, methods, backticks, locals', () => {
  assert.deepEqual(descriptors(A), [{ name: 'Shop', suffix: 'namespace' }, { name: 'Order', suffix: 'type' }, { name: 'Total', suffix: 'term' }]);
  assert.deepEqual(classify(A), { kind: 'member', name: 'Total', owner: 'Order' });
  assert.deepEqual(classify(S.sym('Shop', 'Order', 'Place().')), { kind: 'method', name: 'Place', owner: 'Order' });
  assert.deepEqual(classify(S.sym('Shop', 'Order', 'Place(+1).')), { kind: 'method', name: 'Place', owner: 'Order' });
  assert.deepEqual(classify(B), { kind: 'type', name: 'IOrder', owner: null });
  assert.equal(classify(S.sym('Shop', 'Order', 'Place().(count)')), null);
  assert.equal(classify('local 12'), null);
  assert.deepEqual(classify('scip-typescript npm pkg 1.0.0 src/`a-b.ts`/Foo#bar.'), { kind: 'member', name: 'bar', owner: 'Foo' });
});
