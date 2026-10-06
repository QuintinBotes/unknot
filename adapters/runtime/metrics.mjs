// Metrics parsers (Prometheus text exposition, JSON and CSV time series) and the
// per-service resource aggregates that feed decomposition drivers (§15A.2): p95 cpu,
// memory and request rate, error ratio, replicas and the request-rate coefficient of
// variation (a high value argues for independent scaling).

import { nodeFact } from '../../runtime/graph/facts.mjs';
import {
  ascending, codeRootOf, percentile, round, safeName, sortFacts, stamper, toIso,
} from './util.mjs';

const MAX_SAMPLES = 2_000_000;

const CANON = new Map();
for (const [canon, names] of Object.entries({
  cpu_cores: ['cpu_cores', 'container_cpu_usage_cores', 'cpu_usage_cores', 'process_cpu_cores', 'cpu_cores_used'],
  memory_bytes: ['memory_bytes', 'container_memory_working_set_bytes', 'process_resident_memory_bytes', 'memory_usage_bytes'],
  request_rate: ['request_rate', 'requests_per_second', 'http_requests_per_second', 'http_server_request_rate', 'rps'],
  requests_total: ['http_requests_total', 'requests_total', 'http_server_requests_total'],
  errors_total: ['http_requests_errors_total', 'http_server_errors_total', 'errors_total', 'http_5xx_total'],
  error_ratio: ['error_ratio', 'error_rate', 'http_error_ratio'],
  replicas: ['replicas', 'kube_deployment_status_replicas', 'kube_deployment_spec_replicas'],
})) for (const n of names) CANON.set(n, canon);

const SERVICE_LABELS = ['service', 'service_name', 'app', 'application', 'deployment', 'job'];

function serviceOf(labels, direct) {
  if (direct) return safeName(direct);
  for (const k of SERVICE_LABELS) if (labels?.[k]) return safeName(labels[k]);
  return null;
}

/** Prometheus text exposition -> samples. Histogram buckets and unknown metrics are ignored. */
export function parsePrometheus(text) {
  const samples = [];
  const re = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+(-?\d+))?$/;
  const lre = /([a-zA-Z_]\w*)="((?:[^"\\]|\\.)*)"/g;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = re.exec(line);
    if (!m || !CANON.has(m[1])) continue;
    const labels = {};
    if (m[2]) for (const lm of m[2].matchAll(lre)) labels[lm[1]] = lm[2];
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    samples.push({ service: serviceOf(labels), metric: m[1], ts: m[4] ? Number(m[4]) : null, value, labels });
    if (samples.length >= MAX_SAMPLES) break;
  }
  return samples;
}

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n); // seconds vs milliseconds
  }
  const d = Date.parse(String(v));
  return Number.isFinite(d) ? d : null;
}

function rowsToSamples(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const metric = String(r.metric ?? '').toLowerCase();
    const value = Number(r.value);
    if (!CANON.has(metric) || !Number.isFinite(value)) continue;
    let labels = r.labels;
    if (typeof labels === 'string') labels = parseLabelString(labels);
    if (!labels || typeof labels !== 'object') labels = {};
    out.push({ service: serviceOf(labels, r.service), metric, ts: toMs(r.timestamp), value, labels });
    if (out.length >= MAX_SAMPLES) break;
  }
  return out;
}

function parseLabelString(s) {
  const t = s.trim();
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return {}; } }
  const out = {};
  for (const part of t.split(/[;,]/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function csvRecords(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export function parseCsv(text) {
  const recs = csvRecords(text);
  if (recs.length < 2) return [];
  const head = recs[0].map((h) => h.trim().toLowerCase());
  const rows = recs.slice(1, MAX_SAMPLES + 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  return rowsToSamples(rows);
}

/**
 * Prometheus HTTP API response (`/api/v1/query` vector or `/api/v1/query_range` matrix) ->
 * rows. The metric name is the series' `__name__` label, else its `metric` label, else a
 * top-level `metric` key added to the saved file (aggregations such as `sum by (service)`
 * drop `__name__`).
 */
function promApiRows(doc) {
  const data = doc.data;
  if (!data || !Array.isArray(data.result)) return [];
  const rows = [];
  for (const r of data.result) {
    if (!r || typeof r !== 'object') continue;
    const labels = r.metric && typeof r.metric === 'object' ? r.metric : {};
    const metric = labels.__name__ ?? labels.metric ?? doc.metric;
    const points = Array.isArray(r.values) ? r.values : (Array.isArray(r.value) ? [r.value] : []);
    for (const p of points) {
      if (Array.isArray(p)) rows.push({ metric, value: p[1], timestamp: p[0], labels });
      if (rows.length >= MAX_SAMPLES) return rows;
    }
  }
  return rows;
}

/** Detect the format: JSON document, CSV with a header, else Prometheus text. */
export function parseMetrics(text) {
  const first = text.trimStart()[0];
  if (first === '[' || first === '{') {
    const doc = JSON.parse(text);
    if (!Array.isArray(doc) && doc.status === 'success' && doc.data && 'resultType' in doc.data) {
      return { format: 'prometheus-api', samples: rowsToSamples(promApiRows(doc)) };
    }
    const rows = Array.isArray(doc) ? doc : (doc.samples ?? doc.series ?? doc.metrics ?? []);
    return { format: 'json', samples: rowsToSamples(rows) };
  }
  const head = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length).toLowerCase();
  if (head.includes(',') && head.includes('metric') && head.includes('value')) return { format: 'csv', samples: parseCsv(text) };
  return { format: 'prometheus', samples: parsePrometheus(text) };
}

const GAUGE_SUM = new Set(['cpu_cores', 'memory_bytes', 'request_rate', 'replicas']);

/** Per-service aggregates; every attribute is omitted when its inputs are absent. */
export function aggregateMetrics(samples) {
  const by = new Map();
  const get = (s) => {
    let a = by.get(s);
    if (!a) { a = { buckets: new Map(), counters: new Map(), ratio: [] }; by.set(s, a); }
    return a;
  };
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const s of samples) {
    if (!s.service) continue;
    const canon = CANON.get(s.metric);
    const a = get(s.service);
    if (s.ts !== null) { minTs = Math.min(minTs, s.ts); maxTs = Math.max(maxTs, s.ts); }
    if (GAUGE_SUM.has(canon)) {
      // Pods of one service at the same instant add up to the service's total.
      let m = a.buckets.get(canon);
      if (!m) { m = new Map(); a.buckets.set(canon, m); }
      m.set(s.ts, (m.get(s.ts) ?? 0) + s.value);
    } else if (canon === 'error_ratio') {
      a.ratio.push(s.value);
    } else {
      const sk = `${canon}|${JSON.stringify(s.labels)}`;
      let m = a.counters.get(sk);
      if (!m) { m = { canon, points: [] }; a.counters.set(sk, m); }
      m.points.push([s.ts, s.value]);
      // A requests_total series split by status code also feeds the 5xx error counter.
      const code = String(s.labels?.code ?? s.labels?.status ?? '');
      if (canon === 'requests_total' && /^5\d\d$/.test(code)) {
        const ek = `errors_total|${JSON.stringify(s.labels)}`;
        let e = a.counters.get(ek);
        if (!e) { e = { canon: 'errors_total', points: [] }; a.counters.set(ek, e); }
        e.points.push([s.ts, s.value]);
      }
    }
  }

  const out = new Map();
  for (const [service, a] of by) {
    const attrs = {};
    const series = (canon) => {
      const m = a.buckets.get(canon);
      return m ? [...m.entries()].sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0)).map((e) => e[1]) : [];
    };
    // Counters become rates when timestamps allow; resets (negative deltas) are skipped.
    const rates = new Map();
    const finals = { requests_total: 0, errors_total: 0 };
    const seen = { requests_total: false, errors_total: false };
    for (const c of a.counters.values()) {
      const pts = c.points.filter((p) => p[1] >= 0).sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
      if (c.canon in finals && pts.length) {
        finals[c.canon] += Math.max(...pts.map((p) => p[1]));
        seen[c.canon] = true;
      }
      if (c.canon === 'requests_total') {
        for (let i = 1; i < pts.length; i += 1) {
          const dt = ((pts[i][0] ?? 0) - (pts[i - 1][0] ?? 0)) / 1000;
          const dv = pts[i][1] - pts[i - 1][1];
          if (pts[i][0] !== null && dt > 0 && dv >= 0) rates.set(pts[i][0], (rates.get(pts[i][0]) ?? 0) + dv / dt);
        }
      }
    }
    const cpu = series('cpu_cores');
    const mem = series('memory_bytes');
    let rr = series('request_rate');
    if (rr.length === 0 && rates.size) rr = [...rates.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1]);
    const rep = series('replicas');

    if (cpu.length) attrs.cpu_cores_p95 = round(percentile(ascending(cpu), 95), 4);
    if (mem.length) attrs.memory_bytes_p95 = Math.round(percentile(ascending(mem), 95));
    if (rr.length) attrs.request_rate_p95 = round(percentile(ascending(rr), 95), 4);
    if (rr.length >= 2) {
      const mean = rr.reduce((x, y) => x + y, 0) / rr.length;
      if (mean > 0) {
        const variance = rr.reduce((x, y) => x + (y - mean) ** 2, 0) / rr.length;
        attrs.request_rate_cv = round(Math.sqrt(variance) / mean, 4);
      }
    }
    if (a.ratio.length) attrs.error_ratio = round(a.ratio.reduce((x, y) => x + y, 0) / a.ratio.length, 5);
    else if (seen.requests_total && finals.requests_total > 0) attrs.error_ratio = round(finals.errors_total / finals.requests_total, 5);
    if (rep.length) attrs.replicas = Math.max(...rep);
    out.set(service, attrs);
  }
  const window = Number.isFinite(minTs) ? { start: toIso(minTs), end: toIso(maxTs) } : null;
  return { services: out, window };
}

export function deriveMetricFacts(text, { file, options, now, ttlDays }) {
  const { format, samples } = parseMetrics(text);
  const { services, window } = aggregateMetrics(samples);
  const st = stamper({ file, sourceType: 'trace', window: window ?? { start: now, end: now }, ttlDays });
  const facts = [];
  for (const [name, attrs] of [...services].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    facts.push(nodeFact('service', name, { name, attrs: st.attrs({ ...attrs, code_root: codeRootOf(options, name), metrics_format: format }) },
      st.prov(`service/${name}`, 'medium')));
  }
  return sortFacts(facts);
}
