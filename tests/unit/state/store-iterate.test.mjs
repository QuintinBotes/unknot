// Store.iterate streams rows in order and keeps its statement alive for the whole loop,
// which Node 22.13 needs (it finalizes an unreferenced statement mid-iteration).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';

after(() => K.cleanup());

test('iterate yields every row in order, with parameters', () => {
  const p = K.makeProject();
  const { store } = p.ctx;
  store.run('CREATE TABLE IF NOT EXISTS t_iter(n INTEGER)');
  for (let i = 0; i < 500; i++) store.run('INSERT INTO t_iter(n) VALUES (?)', i);
  let expect = 100;
  for (const r of store.iterate('SELECT n FROM t_iter WHERE n >= ? ORDER BY n', 100)) {
    if (expect % 50 === 0) globalThis.gc?.();
    assert.equal(r.n, expect++);
  }
  assert.equal(expect, 500);
});
