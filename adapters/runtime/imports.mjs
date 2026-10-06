// Documented runtime import (docs/runtime-evidence.md, "Import table"): rows of
// caller, callee, operation, count, p95_ms, error_rate, window. This module validates the
// rows, resolves each caller and callee onto graph nodes, and turns the matches into
// RUNTIME_CALLS facts. It reads no file and touches no store; the command and the graph
// builder supply the text, the graph and the clock.

import { edgeFact, nodeFact, prov } from '../../runtime/graph/facts.mjs';
import { csvRecords } from './metrics.mjs';
import { EXTRACTOR, cleanCodeRoot, expiry, round, safeName, toIso, ttlOf } from './util.mjs';

export const IMPORT_COLUMNS = Object.freeze(['caller', 'callee', 'operation', 'count', 'p95_ms', 'error_rate', 'window']);
const REQUIRED = ['caller', 'callee', 'count', 'window'];
export const MAX_IMPORT_ROWS = 100_000;
const MAX_OPERATIONS = 10;
const DURATION_UNITS = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const ROUTE = /^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+)?\//i;
const SYMBOL_TYPES = new Set(['function', 'method', 'class', 'interface', 'type']);

export const SOURCE_LABEL = /^[A-Za-z0-9._@-]{1,64}$/;

/** A window as a start and end: an ISO interval `a/b`, or a duration (`P7D`, `PT24H`, `7d`) ending at `now`. */
export function parseWindow(text, now) {
  const s = String(text ?? '').trim();
  if (s === '') throw new Error('window is empty');
  if (s.includes('/')) {
    const [a, b, ...rest] = s.split('/');
    const start = Date.parse(a);
    const end = Date.parse(b);
    if (rest.length || !Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`window "${s}" is not an ISO interval (start/end)`);
    if (end <= start) throw new Error(`window "${s}" ends before it starts`);
    return { start: toIso(start), end: toIso(end) };
  }
  let ms = null;
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(s);
  if (iso && !/T$/i.test(s)) {
    ms = (+iso[1] || 0) * DURATION_UNITS.w + (+iso[2] || 0) * DURATION_UNITS.d + (+iso[3] || 0) * DURATION_UNITS.h + (+iso[4] || 0) * DURATION_UNITS.m + (+iso[5] || 0) * DURATION_UNITS.s;
  }
  const short = /^(\d+)([wdhms])$/i.exec(s);
  if (short) ms = +short[1] * DURATION_UNITS[short[2].toLowerCase()];
  if (!ms || ms <= 0) throw new Error(`window "${s}" is neither an ISO interval (start/end) nor a duration such as P7D, PT24H or 7d`);
  const end = Date.parse(now);
  return { start: toIso(end - ms), end: toIso(end) };
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** One raw row to a normalised one, or throws a sentence naming what is wrong. */
function normaliseRow(raw, now) {
  const caller = safeName(raw.caller, 300);
  const callee = safeName(raw.callee, 300);
  if (!caller) throw new Error('caller is empty');
  if (!callee) throw new Error('callee is empty');
  const count = num(raw.count);
  if (!Number.isInteger(count) || count < 0) throw new Error(`count "${raw.count}" is not a non-negative integer`);
  let p95 = null;
  if (!blank(raw.p95_ms)) {
    p95 = num(raw.p95_ms);
    if (!Number.isFinite(p95) || p95 < 0) throw new Error(`p95_ms "${raw.p95_ms}" is not a non-negative number`);
  }
  let rate = null;
  if (!blank(raw.error_rate)) {
    rate = num(raw.error_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`error_rate "${raw.error_rate}" is not a ratio between 0 and 1`);
  }
  return { caller, callee, operation: blank(raw.operation) ? null : safeName(raw.operation, 200), count, p95_ms: p95, error_rate: rate, window: parseWindow(raw.window, now) };
}

/**
 * @param {string} text CSV with a header, a JSON array of row objects, or `{"rows": [...]}`
 * @param {{now: string}} env the instant a duration window ends at
 * @returns {{rows: object[], invalid: {row: number, error: string}[], total: number}} row numbers are 1-based data rows
 */
export function parseImport(text, { now }) {
  const body = String(text ?? '').replace(/^﻿/, '');
  let raws;
  if (/^\s*[[{]/.test(body)) {
    let doc;
    try {
      doc = JSON.parse(body);
    } catch (err) {
      throw new Error(`not valid JSON: ${err.message}`);
    }
    raws = Array.isArray(doc) ? doc : doc?.rows;
    if (!Array.isArray(raws)) throw new Error('JSON must be an array of rows or an object with a "rows" array');
  } else {
    const recs = csvRecords(body);
    if (!recs.length) throw new Error('the file has no header row');
    const head = recs[0].map((h) => h.trim().toLowerCase());
    const missing = REQUIRED.filter((c) => !head.includes(c));
    if (missing.length) throw new Error(`header lacks column(s) ${missing.join(', ')}; expected ${IMPORT_COLUMNS.join(', ')}`);
    raws = recs.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
  if (raws.length > MAX_IMPORT_ROWS) throw new Error(`${raws.length} rows is over the limit of ${MAX_IMPORT_ROWS}`);
  const rows = [];
  const invalid = [];
  raws.forEach((raw, i) => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('row is not an object');
      rows.push({ ...normaliseRow(raw, now), line: i + 1 });
    } catch (err) {
      invalid.push({ row: i + 1, error: err.message });
    }
  });
  return { rows, invalid, total: raws.length };
}

// ---- matching -----------------------------------------------------------------------

/** `GET /v1/orders/{id}`, `/v1/orders/:orderId` and `/v1/orders/<int:id>` share one key. */
export function routeKey(text) {
  const m = /^(?:(\w+)\s+)?(\/\S*)$/.exec(String(text).trim());
  if (!m) return null;
  const path = m[2].split('?')[0].replace(/\{[^}]*\}|<[^>]*>|:[A-Za-z_][\w-]*/g, ':_').replace(/(.)\/+$/, '$1');
  return { method: m[1] ? m[1].toUpperCase() : null, path };
}

function indexGraph(graph) {
  const idx = { modules: new Map(), services: new Map(), endpoints: new Map(), symbols: new Map(), constants: new Map(), modulePaths: [] };
  const push = (map, key, node) => (map.get(key) ?? map.set(key, []).get(key)).push(node);
  for (const n of graph.nodes()) {
    if (n.type === 'module') {
      const p = n.path ?? n.id.slice(7);
      idx.modules.set(p, n);
      idx.modulePaths.push(p);
    } else if (n.type === 'service') idx.services.set(n.name, n);
    else if (n.type === 'endpoint' || n.type === 'route') {
      const k = routeKey(n.name ?? '');
      if (k) {
        push(idx.endpoints, `${k.method ?? ''} ${k.path}`, n);
        if (k.method) push(idx.endpoints, `* ${k.path}`, n);
      }
    } else if (n.type === 'constant') push(idx.constants, String(n.attrs?.value ?? n.name), n);
    else if (SYMBOL_TYPES.has(n.type)) {
      push(idx.symbols, n.name, n);
      const parent = graph.parent(n.id);
      if (parent && parent.type !== 'module' && parent.type !== 'file') push(idx.symbols, `${parent.name}.${n.name}`, n);
    }
  }
  return idx;
}

function resolveRoute(idx, text) {
  const k = routeKey(text);
  const keys = k ? (k.method ? [`${k.method} ${k.path}`, ` ${k.path}`] : [` ${k.path}`, `* ${k.path}`]) : [];
  const found = keys.map((key) => idx.endpoints.get(key) ?? []).find((list) => list.length) ?? [];
  if (found.length === 1) return { id: found[0].id };
  if (found.length > 1) return { why: `route ${text} matches ${found.length} endpoints (add the method)` };
  const consts = idx.constants.get(text) ?? [];
  if (consts.length === 1) return { id: consts[0].id };
  return { why: `no endpoint or route constant for ${text}` };
}

/** Resolve one caller or callee to `{id, synthesize?}` or `{why}`. */
function resolveRef(idx, ref, serviceMap) {
  const text = ref.replace(/\\/g, '/');
  if (ROUTE.test(text)) return resolveRoute(idx, text);
  const path = text.replace(/^\.\//, '');
  const hash = path.indexOf('#');
  if (hash > 0) {
    const file = path.slice(0, hash);
    const name = path.slice(hash + 1);
    const hits = (idx.symbols.get(name) ?? []).filter((n) => n.path === file);
    if (hits.length === 1) return { id: hits[0].id };
    return { why: hits.length ? `${name} in ${file} is ambiguous (${hits.length} symbols)` : `no symbol ${name} in ${file}` };
  }
  const mod = idx.modules.get(path);
  if (mod) return { id: mod.id };
  const root = serviceMap && Object.hasOwn(serviceMap, text) ? cleanCodeRoot(serviceMap[text]) : null;
  const mapped = root && idx.modulePaths.some((p) => p.startsWith(`${root}/`));
  if (mapped) return { id: `service:${text}`, synthesize: { name: text, code_root: root } };
  const svc = idx.services.get(text);
  if (svc) return { id: svc.id };
  const syms = idx.symbols.get(text) ?? [];
  if (syms.length === 1) return { id: syms[0].id };
  if (syms.length > 1) return { why: `symbol ${text} is ambiguous (${syms.length} definitions; qualify it as path#name)` };
  const consts = idx.constants.get(text) ?? [];
  if (consts.length === 1) return { id: consts[0].id };
  if (root) return { why: `service_map names ${root} for ${text} but no module lies under it` };
  return { why: `no module, symbol or service named ${text} (a service needs a trace-derived node or an adapters.runtime.service_map entry)` };
}

/**
 * @param {import('../../runtime/graph/graph.mjs').Graph} graph
 * @param {object[]} rows normalised rows
 * @returns {{matched: object[], unmatched: {row: object, why: string}[]}} matched rows carry `from` and `to` node ids
 */
export function matchRows(graph, rows, { serviceMap = null } = {}) {
  const idx = indexGraph(graph);
  const cache = new Map();
  const resolve = (ref) => {
    if (!cache.has(ref)) cache.set(ref, resolveRef(idx, ref, serviceMap));
    return cache.get(ref);
  };
  const matched = [];
  const unmatched = [];
  for (const row of rows) {
    const a = resolve(row.caller);
    const b = resolve(row.callee);
    if (a.id && b.id) matched.push({ ...row, from: a.id, to: b.id, synthesize: [a.synthesize, b.synthesize].filter(Boolean) });
    else unmatched.push({ row, why: [a.why && `caller: ${a.why}`, b.why && `callee: ${b.why}`].filter(Boolean).join('; ') });
  }
  return { matched, unmatched };
}

// ---- facts --------------------------------------------------------------------------

/**
 * One RUNTIME_CALLS edge per caller and callee pair across all imports (the graph keeps a
 * single edge per pair). Rows for a pair combine: calls add (sources are taken to cover
 * different traffic), p95 is the largest (a percentile cannot be summed), the error rate
 * is weighted by calls, and the window spans the rows' windows.
 * @param {{source: string, imported_at: string, rows: object[]}[]} imports stored imports
 */
export function importFacts(imports, graph, { options = {} } = {}) {
  const facts = [];
  const ttlDays = ttlOf(options);
  const pairs = new Map();
  const services = new Map();
  for (const imp of [...imports].sort((a, b) => (a.source < b.source ? -1 : 1))) {
    const { matched } = matchRows(graph, imp.rows, { serviceMap: options.service_map });
    for (const m of matched) {
      for (const s of m.synthesize) services.set(s.name, s);
      const k = `${m.from}\0${m.to}`;
      let p = pairs.get(k);
      if (!p) pairs.set(k, (p = { from: m.from, to: m.to, calls: 0, p95: null, errors: 0, rated: 0, start: m.window.start, end: m.window.end, ops: new Set(), rows: 0, sources: new Set(), at: imp.imported_at }));
      p.calls += m.count;
      if (m.p95_ms !== null && (p.p95 === null || m.p95_ms > p.p95)) p.p95 = m.p95_ms;
      if (m.error_rate !== null) {
        p.errors += m.error_rate * m.count;
        p.rated += m.count;
      }
      if (m.window.start < p.start) p.start = m.window.start;
      if (m.window.end > p.end) p.end = m.window.end;
      if (m.operation) p.ops.add(m.operation);
      p.rows += 1;
      p.sources.add(imp.source);
      if (imp.imported_at > p.at) p.at = imp.imported_at;
    }
  }
  // Same extractor as trace facts, so `runtime` summaries list imports and their windows.
  const prv = (sources, locator) => prov({ source_type: 'trace', source_ref: `import:${[...sources].sort().join('+')}#${locator}`, extractor: EXTRACTOR, confidence: 'medium' });
  const latest = [...pairs.values()].map((p) => p.end).sort().pop() ?? imports[0]?.imported_at;
  const all = new Set(imports.map((i) => i.source));
  for (const sv of [...services.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    facts.push(nodeFact('service', sv.name, { name: sv.name, attrs: { code_root: sv.code_root, observed_window: { start: latest, end: latest }, expires_at: expiry(latest, ttlDays) } }, prv(all, `service/${sv.name}`)));
  }
  for (const p of [...pairs.values()].sort((a, b) => (`${a.from}\0${a.to}` < `${b.from}\0${b.to}` ? -1 : 1))) {
    const attrs = {
      calls: p.calls,
      ...(p.p95 !== null ? { p95_ms: p.p95 } : {}),
      ...(p.rated > 0 ? { error_rate: round(p.errors / p.rated, 4) } : {}),
      ...(p.ops.size ? { operations: [...p.ops].sort().slice(0, MAX_OPERATIONS) } : {}),
      rows: p.rows,
      imported: true,
      sources: [...p.sources].sort(),
      imported_at: p.at,
      observed_window: { start: p.start, end: p.end },
      expires_at: expiry(p.end, ttlDays),
    };
    facts.push(edgeFact('RUNTIME_CALLS', p.from, p.to, attrs, prv(p.sources, `edge/${p.from}->${p.to}`)));
  }
  return facts;
}
