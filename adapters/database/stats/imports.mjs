// Imported database statistics (`unknot import database-stats`): rows kept in the store
// are matched onto the table nodes the graph already has and turned into facts on every
// map. A statement naming a table the graph does not know is reported, never invented.

import { edgeFact, prov } from '../../../runtime/graph/facts.mjs';
import { redactStatement } from '../../runtime/util.mjs';
import { statementFacts, freshness, ttlOf, TX_EDGE, EXTRACTOR } from './facts.mjs';

/** A resolver from a statement's table name to a graph table id, or `{why}`. */
export function tableResolver(graph) {
  const exact = new Map();
  const bare = new Map();
  for (const n of graph.nodes('table')) {
    const key = n.id.slice('table:'.length).toLowerCase();
    exact.set(key, n.id);
    const last = key.split('.').pop();
    (bare.get(last) ?? bare.set(last, []).get(last)).push(n.id);
  }
  return (name) => {
    const key = name.toLowerCase();
    if (exact.has(key)) return exact.get(key);
    if (!key.includes('.')) {
      const list = bare.get(key) ?? [];
      if (list.length === 1) return list[0];
    }
    return null;
  };
}

const idOf = (source) => (r) => `${source}:${r.statement_id}`;

/**
 * Facts for every stored import. Edges between the same pair of tables from several
 * imports combine (transactions and calls add, windows span).
 * @param {{source: string, imported_at: string, rows: object[], transactions?: object[]}[]} imports
 */
export function statsImportFacts(imports, graph, { options = {} } = {}) {
  const ttlDays = ttlOf(options);
  const resolve = tableResolver(graph);
  const facts = [];
  const pairs = new Map();
  for (const imp of [...imports].sort((a, b) => (a.source < b.source ? -1 : 1))) {
    const p = (r) => prov({ source_type: 'catalog', source_ref: `import:${imp.source}#${r ? r.statement_id : 'transactions'}`, extractor: EXTRACTOR, confidence: 'medium' });
    const common = (r) => ({ imported: true, source: imp.source, imported_at: imp.imported_at, ...freshness(r.window, ttlDays) });
    const out = statementFacts(imp.rows, {
      resolve,
      idOf: idOf(imp.source),
      prov: p,
      transactions: imp.transactions ?? [],
      nodeAttrs: (r) => ({
        ...(r.text ? { text: redactStatement(r.text, 500) } : {}),
        calls: r.calls, mean_exec_time_ms: r.mean_ms, total_exec_time_ms: r.total_ms, rows: r.rows,
        ...common(r),
      }),
      edgeAttrs: (r, kind) => ({
        calls: r.calls,
        ...(kind === 'write' ? { kind: r.kind ?? 'write', has_where: r.has_where } : { kind: 'select' }),
        ...common(r),
      }),
    });
    facts.push(...out.facts);
    for (const q of out.pairs.values()) {
      const k = `${q.from}\0${q.to}`;
      let t = pairs.get(k);
      if (!t) pairs.set(k, (t = { from: q.from, to: q.to, transactions: 0, calls: 0, start: null, end: null, sources: new Set(), at: imp.imported_at }));
      t.transactions += q.transactions;
      t.calls += q.calls;
      t.sources.add(imp.source);
      if (q.start && (!t.start || q.start < t.start)) t.start = q.start;
      if (q.end && (!t.end || q.end > t.end)) t.end = q.end;
      if (imp.imported_at > t.at) t.at = imp.imported_at;
    }
  }
  for (const t of [...pairs.values()].sort((a, b) => (`${a.from}\0${a.to}` < `${b.from}\0${b.to}` ? -1 : 1))) {
    const window = t.start && t.end ? { start: t.start, end: t.end } : null;
    const sources = [...t.sources].sort();
    facts.push(edgeFact(TX_EDGE, t.from, t.to, {
      transactions: t.transactions, calls: t.calls, imported: true, sources, imported_at: t.at, ...freshness(window, ttlDays),
    }, prov({ source_type: 'catalog', source_ref: `import:${sources.join('+')}#transactions`, extractor: EXTRACTOR, confidence: 'medium' })));
  }
  return facts;
}

/** What an import matched: statements with a matched table, matched and unmatched table names. */
export function matchReport(imp, graph) {
  const resolve = tableResolver(graph);
  const matchedTables = new Set();
  const unmatched = new Map();
  let statements = 0;
  for (const r of imp.rows) {
    let any = false;
    for (const n of new Set([...r.tables_read, ...r.tables_written])) {
      const id = resolve(n);
      if (id) { matchedTables.add(id); any = true; } else unmatched.set(n, (unmatched.get(n) ?? 0) + 1);
    }
    if (any) statements += 1;
  }
  const out = statementFacts(imp.rows, { resolve, idOf: idOf(imp.source), prov: () => prov({ source_type: 'catalog', source_ref: 'x', extractor: EXTRACTOR }), nodeAttrs: () => ({}), edgeAttrs: () => ({}), transactions: imp.transactions ?? [] });
  return {
    statements,
    tables_matched: [...matchedTables].sort(),
    tables_unmatched: [...unmatched].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([table, statements]) => ({ table, statements })),
    transaction_pairs: out.pairs.size,
  };
}
