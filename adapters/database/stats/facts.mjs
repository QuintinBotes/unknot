// Facts from normalised statistics rows, shared by the PostgreSQL catalog adapter and
// `unknot import database-stats`: a query node per statement, QUERIES / MUTATES edges to
// the tables it reads and writes (with call counts), and SHARES_TRANSACTION_WITH edges
// between tables written in one transaction. Callers decide how a table name becomes a
// graph table id (`resolve`) and which attributes ride along (`nodeAttrs`, `edgeAttrs`).

import { edgeFact, nodeFact } from '../../../runtime/graph/facts.mjs';
import { EXTRACTOR, expiry, safeName, ttlOf } from '../../runtime/util.mjs';

export { ttlOf };
export const TX_EDGE = 'SHARES_TRANSACTION_WITH';

/** Transaction groups: the `transaction_id` column, plus any explicit groups, as `{id, statements, count}`. */
export function groupTransactions(rows, explicit = []) {
  const byId = new Map();
  for (const r of rows) {
    if (!r.transaction_id) continue;
    if (!byId.has(r.transaction_id)) byId.set(r.transaction_id, { id: r.transaction_id, statements: [], count: null });
    byId.get(r.transaction_id).statements.push(r.statement_id);
  }
  return [...byId.values(), ...explicit];
}

/**
 * @param {object[]} rows normalised rows
 * @param {object} env
 * @param {(name: string) => string|null} env.resolve table name to graph table id (`table:...`), or null
 * @param {(row: object) => object} env.nodeAttrs
 * @param {(row: object, kind: 'read'|'write') => object} env.edgeAttrs
 * @param {(row: object|null) => object} env.prov provenance for a row (null: transaction facts)
 * @param {string} env.idOf statement id to query node id (without the `query:` prefix)
 * @param {(id: string, name: string) => object[]} [env.tableNode] extra facts when a table is first seen
 * @param {object[]} [env.transactions] explicit transaction groups
 * @param {(pair: object) => object} [env.txAttrs]
 * @returns {{facts: object[], matched: Map<string, number>, unmatched: Map<string, number>, pairs: Map<string, object>}}
 */
export function statementFacts(rows, env) {
  const facts = [];
  const matched = new Map();
  const unmatched = new Map();
  const bump = (m, k, by) => m.set(k, (m.get(k) ?? 0) + by);
  const tableOf = new Map();
  const resolve = (name) => {
    if (!tableOf.has(name)) tableOf.set(name, env.resolve(name));
    return tableOf.get(name);
  };
  const seen = new Set();
  const writtenBy = new Map();
  for (const r of rows) {
    const reads = r.tables_read.map((n) => [n, resolve(n)]);
    const writes = r.tables_written.map((n) => [n, resolve(n)]);
    for (const [n, id] of [...reads, ...writes]) {
      if (id) bump(matched, id, 1);
      else bump(unmatched, n, 1);
    }
    const hit = [...reads, ...writes].filter(([, id]) => id);
    writtenBy.set(r.statement_id, writes.filter(([, id]) => id).map(([, id]) => id));
    if (!hit.length) continue;
    const qid = `query:${env.idOf(r)}`;
    facts.push(nodeFact('query', env.idOf(r), { name: (r.text ?? r.statement_id).slice(0, 80), path: env.path, attrs: env.nodeAttrs(r) }, env.prov(r)));
    for (const [kind, list] of [['read', reads], ['write', writes]]) {
      for (const [name, id] of list) {
        if (!id) continue;
        if (!seen.has(id)) { seen.add(id); facts.push(...(env.tableNode?.(id, name) ?? [])); }
        facts.push(edgeFact(kind === 'read' ? 'QUERIES' : 'MUTATES', qid, id, env.edgeAttrs(r, kind), env.prov(r)));
      }
    }
  }
  // Tables written together: every pair of distinct written tables within one transaction group.
  const pairs = new Map();
  const callsOf = new Map(rows.map((r) => [r.statement_id, r.calls]));
  const windowOf = new Map(rows.map((r) => [r.statement_id, r.window]));
  for (const g of groupTransactions(rows, env.transactions ?? [])) {
    const tables = [...new Set(g.statements.flatMap((s) => writtenBy.get(s) ?? []))].sort();
    if (tables.length < 2) continue;
    const known = g.statements.map((s) => callsOf.get(s)).filter(Number.isFinite);
    const runs = g.count ?? (known.length ? Math.min(...known) : null);
    const wins = g.statements.map((s) => windowOf.get(s)).filter(Boolean);
    for (let i = 0; i < tables.length; i++) {
      for (let j = i + 1; j < tables.length; j++) {
        const k = `${tables[i]}\0${tables[j]}`;
        let p = pairs.get(k);
        if (!p) pairs.set(k, (p = { from: tables[i], to: tables[j], transactions: 0, calls: 0, start: null, end: null, ids: [] }));
        p.transactions += 1;
        p.calls += runs ?? 0;
        p.ids.push(safeName(g.id, 80));
        for (const w of wins) {
          if (!p.start || w.start < p.start) p.start = w.start;
          if (!p.end || w.end > p.end) p.end = w.end;
        }
      }
    }
  }
  return { facts, matched, unmatched, pairs };
}

/** Freshness attributes for one window: observed_window and expires_at (window end plus ttl). */
export function freshness(window, ttlDays) {
  return window ? { observed_window: { start: window.start, end: window.end }, expires_at: expiry(window.end, ttlDays) } : {};
}

export { EXTRACTOR, edgeFact };
