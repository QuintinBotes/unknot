// Database query statistics as evidence: the shared SQL table extractor, the readers for
// each database's own view, `unknot import database-stats`, and decompose reading the
// written-together transaction facts as measured evidence (expired ones ignored and named).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyse } from '../golden/_harness.mjs';

const { run } = await import('../../runtime/cli/commands/import.mjs');
const { parseArgs } = await import('../../runtime/cli/util.mjs');
const { decompose } = await import('../../runtime/decompose/index.mjs');
const { Graph } = await import('../../runtime/graph/graph.mjs');
const { extractTables } = await import('../../adapters/database/stats/tables.mjs');
const { readStats } = await import('../../adapters/database/stats/format.mjs');

const NOW = '2026-10-06T00:00:00.000Z';

describe('shared SQL table extractor', () => {
  const cases = [
    ['SELECT * FROM orders', { reads: ['orders'], writes: [] }],
    ['SELECT o.id FROM public.orders o JOIN "Ledger".entries AS l ON l.id = o.id', { reads: ['Ledger.entries', 'public.orders'], writes: [] }],
    ['SELECT * FROM orders o, invoices i WHERE o.id = i.id', { reads: ['invoices', 'orders'], writes: [] }],
    ['WITH recent AS (SELECT * FROM orders), totals(x) AS (SELECT x FROM recent) SELECT * FROM totals JOIN invoices ON 1 = 1', { reads: ['invoices', 'orders'], writes: [] }],
    ['UPDATE [dbo].[orders] SET status = ? WHERE id = ?', { reads: [], writes: ['dbo.orders'] }],
    ['INSERT INTO `ledger` (a) SELECT a FROM orders', { reads: ['orders'], writes: ['ledger'] }],
    ['DELETE FROM invoices WHERE id = $1', { reads: [], writes: ['invoices'] }],
    ['MERGE INTO invoices t USING orders s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1', { reads: ['orders'], writes: ['invoices'] }],
    ['SELECT extract(year FROM created_at) FROM orders FOR UPDATE', { reads: ['orders'], writes: [] }],
    ['SELECT * FROM #scratch JOIN orders ON 1 = 1 /* FROM hidden */', { reads: ['orders'], writes: [] }],
    ['SELECT a INTO archive FROM orders', { reads: ['orders'], writes: ['archive'] }],
    ['TRUNCATE TABLE ledger', { reads: [], writes: ['ledger'] }],
  ];
  for (const [sql, want] of cases) {
    test(sql.slice(0, 60), () => {
      const got = extractTables(sql);
      assert.deepEqual([got.reads, got.writes, got.parsed], [want.reads, want.writes, true]);
    });
  }

  test('unparseable text is reported, not guessed', () => {
    for (const sql of ['BEGIN', 'SET search_path = x', "SELECT 'oops FROM orders", 'DELETE o FROM orders o JOIN x ON 1 = 1', '']) {
      assert.equal(extractTables(sql).parsed, false, sql);
    }
  });

  test('statements the extractor cannot read are counted by the reader', () => {
    const res = readStats('queryid,query,calls\n1,SELECT * FROM orders,5\n2,BEGIN,9\n', { strict: false });
    assert.deepEqual(res.rows.map((r) => r.parsed), [true, false]);
  });
});

describe('readers produce the normalised rows', () => {
  test('PostgreSQL pg_stat_statements', () => {
    const res = readStats('queryid,query,calls,total_exec_time,mean_exec_time,rows\n7,UPDATE orders SET a = $1 WHERE id = $2,10,50,5,10\n', { window: 'P1D', now: NOW });
    assert.equal(res.format, 'pg');
    const [r] = res.rows;
    assert.deepEqual([r.statement_id, r.calls, r.total_ms, r.mean_ms, r.rows, r.tables_written, r.tables_read], ['7', 10, 50, 5, 10, ['orders'], []]);
    assert.equal(r.window.end, NOW);
  });

  test('SQL Server Query Store (microseconds, joined export)', () => {
    const csv = 'query_id,query_sql_text,count_executions,avg_duration,avg_rowcount,start_time,end_time\n3,SELECT * FROM dbo.orders,200,2500,4,2026-09-01 00:00:00,2026-09-08 00:00:00\n';
    const res = readStats(csv, { now: NOW });
    assert.equal(res.format, 'sqlserver');
    const [r] = res.rows;
    assert.deepEqual([r.calls, r.mean_ms, r.total_ms, r.rows, r.tables_read], [200, 2.5, 500, 800, ['dbo.orders']]);
    assert.deepEqual(r.window, { start: '2026-09-01T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z' });
  });

  test('MySQL events_statements_summary_by_digest (picoseconds)', () => {
    const csv = 'DIGEST,DIGEST_TEXT,COUNT_STAR,SUM_TIMER_WAIT,AVG_TIMER_WAIT,SUM_ROWS_SENT,SUM_ROWS_AFFECTED,FIRST_SEEN,LAST_SEEN\nabc,"INSERT INTO `orders` (`a`) VALUES (?)",4,8000000000,2000000000,0,4,2026-09-01 00:00:00,2026-09-02 00:00:00\n';
    const res = readStats(csv, { now: NOW });
    assert.equal(res.format, 'mysql');
    const [r] = res.rows;
    assert.deepEqual([r.statement_id, r.total_ms, r.mean_ms, r.rows, r.tables_written], ['abc', 8, 2, 4, ['orders']]);
  });

  test('normalised CSV and JSON, with transaction grouping and bad rows named', () => {
    const csv = 'statement_id,text,calls,tables_read,tables_written,window,transaction_id\ns1,,5,,orders;ledger,P1D,t1\n';
    const res = readStats(csv, { now: NOW });
    assert.deepEqual(res.rows[0].tables_written, ['orders', 'ledger']);
    assert.equal(res.rows[0].transaction_id, 't1');
    const json = readStats(JSON.stringify({ rows: [{ statement_id: 'a', text: 'UPDATE orders SET x = 1', calls: 3, window: 'P1D' }], transactions: [['a', 'b']] }), { now: NOW });
    assert.deepEqual(json.transactions[0].statements, ['a', 'b']);
    const bad = readStats('statement_id,text,calls\na,SELECT 1 FROM orders,-1\n,SELECT 1 FROM orders,1\n', { now: NOW });
    assert.deepEqual(bad.invalid.map((x) => x.row), [1, 2]);
  });
});

// ---- import and decompose ------------------------------------------------------------

const group = (dir, names, extras = {}) => Object.fromEntries(names.map((n) => [`shop/${dir}/${n}.js`, `${names.filter((m) => m !== n).map((m) => `import { f_${m} } from './${m}.js';`).join('\n')}${extras[n] ?? ''}\nexport function f_${n}() { return 1; }\n`]));
const o = ['o0', 'o1', 'o2', 'o3', 'o4'];
const s = ['s0', 's1', 's2', 's3', 's4'];
const repo = () => analyse('modular-monolith', {
  extra: {
    'db/schema.sql': 'CREATE TABLE orders (id int);\nCREATE TABLE stock_items (id int);\n',
    ...group('orders', o, { o0: "\nimport { f_s0 } from '../stock/s0.js';\ndb.query('UPDATE orders SET a = 1 WHERE id = 2');" }),
    ...group('stock', s, { s0: "\ndb.query('UPDATE stock_items SET a = 1 WHERE id = 2');" }),
  },
  skipDiagnose: true,
});
const r = await repo();

async function importCli(...argv) {
  const { positional, flags } = parseArgs([...argv, '--cwd', r.dir]);
  let out = '';
  const w = process.stdout.write;
  process.stdout.write = (c) => { out += c; return true; };
  try {
    await run({ positional, flags });
  } finally {
    process.stdout.write = w;
  }
  return out;
}
const put = (name, text) => {
  mkdirSync(join(r.dir, 'exports'), { recursive: true });
  writeFileSync(join(r.dir, 'exports', name), text);
  return `exports/${name}`;
};

const EXPORT = [
  'statement_id,text,calls,total_ms,tables_written,window,transaction_id',
  'place,"UPDATE orders SET status = $1 WHERE id = $2",900,1800,,P7D,t1',
  'reserve,"UPDATE stock_items SET qty = qty - $1 WHERE id = $2",900,900,,P7D,t1',
  'audit,"INSERT INTO audit_log (a) VALUES ($1)",50,10,,P7D,',
  'report,"SELECT * FROM orders o JOIN billing.ledger l ON l.id = o.id",12,300,,P7D,',
  '',
].join('\n');

describe('unknot import database-stats', () => {
  test('attaches facts to existing tables, lists unmatched ones, and is idempotent', async () => {
    const file = put('stats.csv', EXPORT);
    const first = JSON.parse(await importCli('database-stats', file, '--source', 'stats', '--json'));
    assert.equal(first.status, 'imported');
    assert.deepEqual([first.statements, first.statements_matched, first.tables_matched], [4, 3, ['table:public.orders', 'table:public.stock_items']]);
    assert.deepEqual(first.tables_unmatched.map((u) => u.table).sort(), ['audit_log', 'billing.ledger']);
    assert.equal(first.transaction_table_pairs, 1);
    const g = Graph.fromStore(r.ctx.store);
    const w = g.edges('MUTATES').find((e) => e.from === 'query:stats:place');
    assert.deepEqual([w.to, w.attrs.calls, w.attrs.has_where, w.attrs.imported], ['table:public.orders', 900, true, true]);
    assert.ok(w.attrs.expires_at > w.attrs.observed_window.end);
    assert.ok(g.edges('QUERIES').some((e) => e.from === 'query:stats:report' && e.to === 'table:public.orders'));
    const tx = g.edges('SHARES_TRANSACTION_WITH');
    assert.equal(tx.length, 1);
    assert.deepEqual([tx[0].from, tx[0].to, tx[0].attrs.transactions, tx[0].attrs.calls, tx[0].attrs.sources], ['table:public.orders', 'table:public.stock_items', 1, 900, ['stats']]);

    const generation = r.ctx.store.meta('generation');
    const again = JSON.parse(await importCli('database-stats', file, '--source', 'stats', '--json'));
    assert.equal(again.status, 'unchanged');
    assert.equal(r.ctx.store.meta('generation'), generation);
    assert.equal(Graph.fromStore(r.ctx.store).edges('SHARES_TRANSACTION_WITH').length, 1);
  });

  test('refuses .unknot/, credential paths, rows without a window, and unknown formats', async () => {
    mkdirSync(join(r.dir, '.unknot/cache'), { recursive: true });
    writeFileSync(join(r.dir, '.unknot/cache/s.csv'), EXPORT);
    await assert.rejects(importCli('database-stats', '.unknot/cache/s.csv'), { code: 'UK_POLICY_DENIED' });
    writeFileSync(join(r.dir, '.env'), EXPORT);
    await assert.rejects(importCli('database-stats', '.env'), { code: 'UK_POLICY_DENIED' });
    const pg = put('pg.csv', 'queryid,query,calls\n1,SELECT * FROM orders,3\n');
    await assert.rejects(importCli('database-stats', pg, '--source', 'nowin'), { code: 'UK_SCHEMA_INVALID' });
    await assert.rejects(importCli('database-stats', pg, '--format', 'oracle'), { code: 'UK_CONFIG_INVALID' });
    const ok = JSON.parse(await importCli('database-stats', pg, '--source', 'withwin', '--window', 'P1D', '--json'));
    assert.equal(ok.format, 'pg');
  });
});

describe('decompose with imported transaction facts', () => {
  const orders = (res) => res.details.find((x) => x.candidate.name.includes('orders'));

  test('a transaction writing tables owned on both sides is measured, labelled observed, with its window', async () => {
    await importCli('database-stats', put('stats2.csv', EXPORT), '--source', 'stats');
    const rec = orders(await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true }));
    assert.equal(rec.candidate.metrics['boundary.cross_transactions'], 1);
    assert.equal(rec.transaction_evidence.label, 'observed');
    assert.ok(rec.transaction_evidence.window.start < rec.transaction_evidence.window.end);
    assert.deepEqual(rec.transaction_evidence.sources, ['import:stats']);
    assert.ok(!rec.evidence_gaps.some((g) => /transaction/.test(g)));
  });

  test('expired transaction evidence is ignored and named in the gaps', async () => {
    const old = EXPORT.replaceAll('P7D', '2020-01-01T00:00:00Z/2020-01-08T00:00:00Z');
    await importCli('database-stats', put('old.csv', old), '--source', 'stats');
    const rec = orders(await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true }));
    assert.equal(rec.candidate.metrics['boundary.cross_transactions'], undefined);
    assert.equal(rec.transaction_evidence, undefined);
    assert.ok(rec.evidence_gaps.some((g) => /transaction fact\(s\) are past their expiry|past its expiry/.test(g)), rec.evidence_gaps.join('|'));
  });
});
