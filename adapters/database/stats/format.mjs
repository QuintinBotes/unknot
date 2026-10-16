// Database query statistics as evidence (docs/runtime-evidence.md, "Database query
// statistics"). One normalised row format, one validator, and small readers that turn a
// database's own statistics view into it. Tables come from the statement text through the
// one shared extractor (tables.mjs) unless the row names them. This module reads no file,
// touches no store and never connects to a database.

import { csvRecords } from '../../runtime/metrics.mjs';
import { parseWindow } from '../../runtime/imports.mjs';
import { safeName, toIso } from '../../runtime/util.mjs';
import { extractTables } from './tables.mjs';

export const STATS_COLUMNS = Object.freeze([
  'statement_id', 'text', 'calls', 'total_ms', 'mean_ms', 'rows', 'tables_read', 'tables_written', 'window', 'source', 'transaction_id',
]);
export const STATS_FORMATS = Object.freeze(['pg', 'sqlserver', 'mysql', 'normalised']);
export const MAX_STATS_ROWS = 100_000;
const MAX_TEXT = 500;
const MAX_TABLES = 50;

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const lc = (raw) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).trim().toLowerCase(), v]));

// ---- readers: one small mapping per database ----------------------------------------
// Each maps one exported record (keys lower-cased) onto the normalised column names. The
// source views are the databases' own; the export queries are in docs/runtime-evidence.md.

const times = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a * b : null);
const div = (a, d) => (Number.isFinite(a) ? a / d : null);
const sqlTime = (v) => {
  let s = String(v ?? '').trim().replace(' ', 'T');
  if (!s) return null;
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) s += 'Z';
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const interval = (a, b) => {
  const start = sqlTime(a);
  const end = sqlTime(b);
  return start !== null && end !== null && end > start ? { start: toIso(start), end: toIso(end) } : null;
};

export const READERS = Object.freeze({
  // PostgreSQL pg_stat_statements (CSV or JSON of the view's columns; older and newer column names).
  pg: (r) => ({
    statement_id: r.queryid ?? r.query_id,
    text: r.query,
    calls: r.calls,
    total_ms: r.total_exec_time ?? r.total_time,
    mean_ms: r.mean_exec_time ?? r.mean_time,
    rows: r.rows,
    window: interval(r.stats_since, r.stats_until),
  }),
  // SQL Server Query Store: query text joined to runtime stats (durations are microseconds).
  sqlserver: (r) => {
    const count = num(r.count_executions);
    const mean = div(num(r.avg_duration), 1000);
    return {
      statement_id: r.query_id,
      text: r.query_sql_text,
      calls: r.count_executions,
      mean_ms: mean,
      total_ms: times(mean, count),
      rows: times(num(r.avg_rowcount), count),
      window: interval(r.start_time ?? r.first_execution_time, r.end_time ?? r.last_execution_time),
    };
  },
  // MySQL performance_schema.events_statements_summary_by_digest (timers are picoseconds).
  mysql: (r) => ({
    statement_id: r.digest,
    text: r.digest_text,
    calls: r.count_star,
    total_ms: div(num(r.sum_timer_wait), 1e9),
    mean_ms: div(num(r.avg_timer_wait), 1e9),
    rows: (Number.isFinite(num(r.sum_rows_sent)) || Number.isFinite(num(r.sum_rows_affected))) ? (num(r.sum_rows_sent) || 0) + (num(r.sum_rows_affected) || 0) : null,
    window: interval(r.first_seen, r.last_seen),
  }),
  normalised: (r) => r,
});

/** Which reader fits these column names, or null. */
export function detectFormat(keys) {
  const k = new Set(keys.map((x) => String(x).trim().toLowerCase()));
  if (k.has('statement_id') && k.has('calls')) return 'normalised';
  if (k.has('query_sql_text') || k.has('count_executions')) return 'sqlserver';
  if (k.has('digest_text') || k.has('count_star')) return 'mysql';
  if (k.has('query') && k.has('calls')) return 'pg';
  return null;
}

// ---- parsing ------------------------------------------------------------------------

function listOf(v) {
  if (blank(v)) return [];
  const items = Array.isArray(v) ? v : String(v).split(';');
  return items.map((x) => safeName(x, 200)).filter(Boolean);
}

function windowOf(v, now) {
  if (blank(v)) return null;
  if (typeof v === 'object') {
    const start = Date.parse(v.start);
    const end = Date.parse(v.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('window needs a start before its end');
    return { start: toIso(start), end: toIso(end) };
  }
  return parseWindow(v, now);
}

/** One reader output to a normalised row, or throws a sentence naming what is wrong. */
function normaliseRow(raw, { now, strict, index, fallbackWindow, idFallback }) {
  const id = blank(raw.statement_id) ? (strict ? '' : idFallback(index)) : safeName(raw.statement_id, 200);
  if (!id) throw new Error('statement_id is empty');
  let calls = null;
  if (!blank(raw.calls)) {
    calls = num(raw.calls);
    if (!Number.isInteger(calls) && Number.isFinite(calls)) calls = Math.round(calls);
    if (!Number.isFinite(calls) || calls < 0) throw new Error(`calls "${raw.calls}" is not a non-negative integer`);
  } else if (strict) throw new Error('calls is empty');
  const measure = (name) => {
    if (blank(raw[name])) return null;
    const v = num(raw[name]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} "${raw[name]}" is not a non-negative number`);
    return v;
  };
  const text = blank(raw.text) ? null : String(raw.text);
  let read = listOf(raw.tables_read);
  let written = listOf(raw.tables_written);
  let kind = null;
  let hasWhere = null;
  let parsed = true;
  let note = null;
  if (!read.length && !written.length) {
    if (!text) throw new Error('the row has neither text nor tables_read / tables_written');
    const ex = extractTables(text);
    read = ex.reads;
    written = ex.writes;
    kind = ex.kind;
    hasWhere = ex.has_where;
    parsed = ex.parsed;
    note = ex.note;
  }
  const window = windowOf(raw.window, now) ?? fallbackWindow ?? null;
  return {
    statement_id: id,
    text: text === null ? null : text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
    calls,
    total_ms: measure('total_ms'),
    mean_ms: measure('mean_ms'),
    rows: measure('rows'),
    tables_read: read.slice(0, MAX_TABLES),
    tables_written: written.slice(0, MAX_TABLES),
    window,
    source: blank(raw.source) ? null : safeName(raw.source, 64),
    transaction_id: blank(raw.transaction_id) ? null : safeName(raw.transaction_id, 200),
    kind,
    has_where: hasWhere,
    parsed,
    ...(note ? { note } : {}),
  };
}

function transactionGroups(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('"transactions" must be an array');
  return list.map((t, i) => {
    const ids = Array.isArray(t) ? t : t?.statements;
    if (!Array.isArray(ids) || !ids.length) throw new Error(`transactions[${i}] needs a list of statement ids`);
    const count = Array.isArray(t) || blank(t.count) ? null : num(t.count);
    if (count !== null && (!Number.isInteger(count) || count < 0)) throw new Error(`transactions[${i}].count is not a non-negative integer`);
    return { id: Array.isArray(t) || blank(t.transaction_id) ? `tx-${i + 1}` : safeName(t.transaction_id, 200), statements: ids.map((x) => safeName(x, 200)), count };
  });
}

/**
 * Read a statistics export.
 * @param {string} text CSV with a header, a JSON array of row objects, or `{"rows": [...], "transactions": [...]}`
 * @param {{format?: string, now?: string, strict?: boolean, window?: string|null}} [opts]
 *   `strict` (the import command) refuses rows without `calls`; otherwise statements with
 *   no usable text are skipped as the PostgreSQL adapter always did. `window` fills rows that carry none.
 * @returns {{format: string, rows: object[], invalid: {row: number, error: string}[], total: number, transactions: object[]}}
 */
export function readStats(text, { format = 'auto', now = new Date().toISOString(), strict = true, window = null, idFallback = (i) => `row-${i + 1}` } = {}) {
  const body = String(text ?? '').replace(/^﻿/, '');
  let raws;
  let groups = [];
  if (/^\s*[[{]/.test(body)) {
    let doc;
    try {
      doc = JSON.parse(body);
    } catch (err) {
      throw new Error(`not valid JSON: ${err.message}`);
    }
    raws = Array.isArray(doc) ? doc : (doc?.rows ?? doc?.pg_stat_statements);
    if (!Array.isArray(raws)) throw new Error('JSON must be an array of rows or an object with a "rows" array');
    groups = transactionGroups(doc?.transactions);
  } else {
    const recs = csvRecords(body);
    if (!recs.length) throw new Error('the file has no header row');
    const head = recs[0].map((h) => h.trim().toLowerCase());
    raws = recs.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
  if (raws.length > MAX_STATS_ROWS) throw new Error(`${raws.length} rows is over the limit of ${MAX_STATS_ROWS}`);
  const objects = raws.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? lc(r) : null));
  const chosen = format === 'auto' ? detectFormat(Object.keys(objects.find(Boolean) ?? {})) : format;
  if (!chosen) throw new Error(`the columns fit no known format; expected ${STATS_FORMATS.join(', ')} (see docs/runtime-evidence.md)`);
  if (!READERS[chosen]) throw new Error(`unknown format "${format}"; expected ${STATS_FORMATS.join(', ')}`);
  const fallbackWindow = blank(window) ? null : parseWindow(window, now);
  const rows = [];
  const invalid = [];
  objects.forEach((raw, i) => {
    try {
      if (!raw) throw new Error('row is not an object');
      const mapped = READERS[chosen](raw);
      if (!strict && blank(mapped.text) && blank(mapped.tables_read) && blank(mapped.tables_written)) return; // nothing to read
      rows.push({ ...normaliseRow({ source: raw.source, transaction_id: raw.transaction_id, ...mapped }, { now, strict, index: i, fallbackWindow, idFallback }), line: i + 1 });
    } catch (err) {
      invalid.push({ row: i + 1, error: err.message });
    }
  });
  return { format: chosen, rows, invalid, total: raws.length, transactions: groups };
}
