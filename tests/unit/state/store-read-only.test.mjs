// A read-only open leaves no SQLite side files and works on a read-only state directory (#176),
// and still sees the commits a live writer holds in its WAL.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../../runtime/state/store.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';

const dir = mkTmp(join(tmpdir(), 'unknot-ro-'));
const file = join(dir, 'unknot.db');

test('a read-only open creates no file and succeeds on a read-only directory', () => {
  const w = new Store(file);
  w.run('CREATE TABLE t(n INTEGER)');
  w.run('INSERT INTO t(n) VALUES (1)');
  w.close();
  assert.deepEqual(readdirSync(dir), ['unknot.db']);

  const r = new Store(file, { readOnly: true });
  assert.equal(r.get('SELECT n FROM t').n, 1);
  r.close();
  assert.deepEqual(readdirSync(dir), ['unknot.db']);

  chmodSync(dir, 0o500);
  const r2 = new Store(file, { readOnly: true });
  assert.equal(r2.get('SELECT n FROM t').n, 1);
  r2.close();
  chmodSync(dir, 0o700);
});

test('a read-only open beside a live writer reads its WAL commits', () => {
  const w = new Store(file);
  w.run('INSERT INTO t(n) VALUES (2)');
  assert.ok(existsSync(`${file}-wal`));
  const r = new Store(file, { readOnly: true });
  assert.equal(r.get('SELECT count(*) AS c FROM t').c, 2);
  r.close();
  w.close();
});
