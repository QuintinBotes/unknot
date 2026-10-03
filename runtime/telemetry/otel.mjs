// A tiny OpenTelemetry-compatible tracer, meter and logger (spec §27). Zero dependencies:
// it emits OTLP/JSON by hand. Local-only by default (spec §16.5): nothing is recorded unless
// `telemetry.enabled` is true, and the `otlp` exporter additionally requires the endpoint
// host to be listed in `network.allowed_domains`.
//
// CONTENT SAFETY (spec §27): telemetry MUST NOT carry source, diffs, secrets, SQL values,
// state contents or customer data. That is enforced structurally rather than by caller
// discipline: span names and metric names come from closed sets, attribute keys must be on
// an allowlist, and every string value is length-capped, rejected if it looks like a path
// and run through `redact`. Anything else is silently dropped.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { redact } from '../core/redact.mjs';

export const SCOPE = { name: 'unknot', version: '0.1.0' };
export const MAX_STRING = 128;
export const EXPORT_TIMEOUT_MS = 5000;

/** The §27 trace hierarchy; any other span name is recorded as `unknot.span`. */
export const SPAN_NAMES = Object.freeze([
  'unknot.run', 'baseline', 'map', 'diagnose', 'plan', 'apply', 'verify',
  'adapter.language', 'adapter.database', 'adapter.infrastructure', 'hook',
]);

/** Attribute keys that may leave the process. Everything else is dropped. */
export const ATTRIBUTE_ALLOWLIST = Object.freeze(new Set([
  'unknot.command', 'unknot.mode', 'unknot.outcome', 'unknot.state', 'unknot.exit_code',
  'unknot.adapter', 'unknot.detector', 'unknot.finding_kind', 'unknot.risk_class',
  'unknot.finding_id', 'unknot.uncertainty_id', 'unknot.error_code', 'unknot.hook_event',
  'unknot.tool', 'unknot.result', 'unknot.token_type', 'unknot.decision',
  'unknot.files', 'unknot.facts', 'unknot.findings', 'unknot.uncertainties',
  'unknot.cache_hits', 'unknot.cache_misses', 'unknot.changed_files', 'unknot.diff_lines',
  'unknot.duration_ms', 'unknot.tokens', 'unknot.cost_usd', 'unknot.obligations',
  'unknot.denials', 'unknot.tool_calls', 'unknot.tool_failures',
]));

/** Metric registry (spec §27): name → kind and unit. */
export const METRICS = Object.freeze({
  'unknot.run.duration': { kind: 'histogram', unit: 'ms' },
  'unknot.run.count': { kind: 'counter', unit: '{run}' },
  'unknot.agent.calls': { kind: 'counter', unit: '{call}' },
  'unknot.tool.calls': { kind: 'counter', unit: '{call}' },
  'unknot.tool.failures': { kind: 'counter', unit: '{call}' },
  'unknot.cache.hits': { kind: 'counter', unit: '{file}' },
  'unknot.cache.misses': { kind: 'counter', unit: '{file}' },
  'unknot.facts': { kind: 'counter', unit: '{fact}' },
  'unknot.findings': { kind: 'counter', unit: '{finding}' },
  'unknot.uncertainties': { kind: 'counter', unit: '{uncertainty}' },
  'unknot.policy.denials': { kind: 'counter', unit: '{denial}' },
  'unknot.changed.files': { kind: 'histogram', unit: '{file}' },
  'unknot.diff.lines': { kind: 'histogram', unit: '{line}' },
  'unknot.proof.obligations': { kind: 'counter', unit: '{obligation}' }, // unknot.result = pass|fail|inconclusive
  'unknot.tokens': { kind: 'counter', unit: '{token}' }, // unknot.token_type = input|output|cache
  'unknot.cost': { kind: 'counter', unit: 'USD' },
});

const BOUNDS = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 60000];
const SEVERITY = { debug: 5, info: 9, warn: 13, error: 17 };

/** Keep only allowlisted keys and safe scalar values. Returns a plain object. */
export function sanitizeAttributes(attrs) {
  const out = {};
  if (!attrs || typeof attrs !== 'object') return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (!ATTRIBUTE_ALLOWLIST.has(k)) continue;
    const safe = sanitizeValue(v);
    if (safe !== undefined) out[k] = safe;
  }
  return out;
}

function sanitizeValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined; // arrays and objects could smuggle content
  // Redact before truncating so a secret cut in half is not left half-visible.
  const text = redact(v).text.slice(0, MAX_STRING);
  // A path-shaped value is user content by definition (spec §27): drop it.
  if (/[\\/]/.test(text)) return undefined;
  return text;
}

const toAnyValue = (v) => (typeof v === 'number'
  ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { boolValue: v } : { stringValue: v });

const toKeyValues = (attrs) => Object.entries(attrs).map(([key, v]) => ({ key, value: toAnyValue(v) }));
const nano = (ms) => String(BigInt(Math.round(ms * 1000)) * 1000n);
const hex = (bytes) => randomBytes(bytes).toString('hex');

const NOOP_SPAN = Object.freeze({
  traceId: '',
  spanId: '',
  end() {},
  setAttribute() { return NOOP_SPAN; },
  child() { return NOOP_SPAN; },
});

/**
 * Is the host of `endpoint` permitted by `network.allowed_domains`? A bare entry matches the
 * host and its subdomains; the check is on the parsed hostname, never a string prefix.
 */
export function hostAllowed(endpoint, allowedDomains = []) {
  let host;
  try {
    host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return allowedDomains.some((d) => {
    const dom = String(d).toLowerCase();
    return host === dom || host.endsWith(`.${dom}`);
  });
}

function post(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    const req = mod.request(u, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Create a telemetry instance. Disabled configs return an instance whose every method is a
 * no-op, so call sites never need to check.
 *
 * @param {{config?: object, root?: string, now?: () => number, stderr?: (s: string) => void}} opts
 */
export function createTelemetry({ config = {}, root = process.cwd(), now = Date.now, stderr = (s) => process.stderr.write(s) } = {}) {
  const t = config.telemetry ?? {};
  const enabled = t.enabled === true;
  const exporter = t.exporter === 'otlp' ? 'otlp' : 'file';
  const als = new AsyncLocalStorage();
  const resource = {
    attributes: [
      { key: 'service.name', value: { stringValue: 'unknot' } },
      { key: 'service.version', value: { stringValue: SCOPE.version } },
      ...toKeyValues(sanitizeAttributes({ 'unknot.mode': config.mode })),
    ],
  };

  let spans = [];
  let logs = [];
  const metrics = new Map();
  let warned = false;
  const warnOnce = (msg) => {
    if (warned) return;
    warned = true;
    stderr(`unknot: telemetry ${msg}\n`);
  };

  let otlpOk = true;
  if (enabled && exporter === 'otlp' && !(t.endpoint && hostAllowed(t.endpoint, config.network?.allowed_domains ?? []))) {
    otlpOk = false;
    warnOnce('otlp endpoint is not in network.allowed_domains; telemetry dropped');
  }
  const active = enabled && otlpOk;

  function makeSpan(name, attrs, parent) {
    const rec = {
      traceId: parent?.traceId || hex(16),
      spanId: hex(8),
      parentSpanId: parent?.spanId ?? '',
      name: SPAN_NAMES.includes(name) ? name : 'unknot.span',
      startMs: now(),
      attrs: sanitizeAttributes(attrs),
      status: 'ok',
      ended: false,
    };
    const span = {
      traceId: rec.traceId,
      spanId: rec.spanId,
      setAttribute(key, value) {
        Object.assign(rec.attrs, sanitizeAttributes({ [key]: value }));
        return span;
      },
      child: (childName, childAttrs) => makeSpan(childName, childAttrs, span),
      /** @param {'ok'|'error'|{code: 'ok'|'error', error_code?: string}} [status] */
      end(status = 'ok') {
        if (rec.ended) return;
        rec.ended = true;
        const code = typeof status === 'string' ? status : status?.code ?? 'ok';
        rec.status = code === 'error' ? 'error' : 'ok';
        if (typeof status === 'object' && status?.error_code) Object.assign(rec.attrs, sanitizeAttributes({ 'unknot.error_code': status.error_code }));
        rec.endMs = now();
        spans.push(rec);
      },
    };
    return span;
  }

  const api = {
    enabled: active,
    exporter,
    startSpan(name, attrs = {}) {
      if (!active) return NOOP_SPAN;
      return makeSpan(name, attrs, als.getStore());
    },
    /** Run `fn(span)` inside a span; nested withSpan calls become children automatically. */
    async withSpan(name, attrs, fn) {
      if (!active) return fn(NOOP_SPAN);
      const span = makeSpan(name, attrs, als.getStore());
      try {
        const result = await als.run(span, () => fn(span));
        span.end('ok');
        return result;
      } catch (err) {
        span.end({ code: 'error', error_code: typeof err?.code === 'string' ? err.code : undefined });
        throw err;
      }
    },
    /** Record a counter increment or histogram observation. Unknown metric names are dropped. */
    metric(name, value, attrs = {}) {
      const def = METRICS[name];
      if (!active || !def || typeof value !== 'number' || !Number.isFinite(value)) return;
      const safe = sanitizeAttributes(attrs);
      const key = `${name}|${JSON.stringify(Object.entries(safe).sort())}`;
      let m = metrics.get(key);
      if (!m) {
        m = { name, def, attrs: safe, startMs: now(), count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Array(BOUNDS.length + 1).fill(0) };
        metrics.set(key, m);
      }
      m.count += 1;
      m.sum += value;
      m.min = Math.min(m.min, value);
      m.max = Math.max(m.max, value);
      let i = BOUNDS.findIndex((b) => value <= b);
      if (i < 0) i = BOUNDS.length;
      m.buckets[i] += 1;
    },
    /** Structured log. `message` should be a static string; it is capped and redacted anyway. */
    log(severity, message, attrs = {}) {
      if (!active) return;
      const sev = SEVERITY[severity] ? severity : 'info';
      const cur = als.getStore();
      logs.push({
        timeMs: now(),
        sev,
        body: redact(String(message)).text.slice(0, MAX_STRING).replace(/[\\/]/g, '_'),
        attrs: sanitizeAttributes(attrs),
        ...(cur ? { traceId: cur.traceId, spanId: cur.spanId } : {}),
      });
    },

    /** Build the OTLP/JSON payloads from what has been buffered (does not clear). */
    payloads() {
      const scope = { name: SCOPE.name, version: SCOPE.version };
      const out = {};
      if (spans.length) {
        out.traces = {
          resourceSpans: [{
            resource,
            scopeSpans: [{
              scope,
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: 1,
                startTimeUnixNano: nano(s.startMs),
                endTimeUnixNano: nano(s.endMs),
                attributes: toKeyValues(s.attrs),
                status: { code: s.status === 'error' ? 2 : 1 },
              })),
            }],
          }],
        };
      }
      if (metrics.size) {
        const t1 = nano(now());
        out.metrics = {
          resourceMetrics: [{
            resource,
            scopeMetrics: [{
              scope,
              metrics: [...metrics.values()].map((m) => {
                const base = { startTimeUnixNano: nano(m.startMs), timeUnixNano: t1, attributes: toKeyValues(m.attrs) };
                if (m.def.kind === 'counter') {
                  return { name: m.name, unit: m.def.unit, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ ...base, asDouble: m.sum }] } };
                }
                const point = { ...base, count: String(m.count), sum: m.sum, min: m.min, max: m.max, bucketCounts: m.buckets.map(String), explicitBounds: BOUNDS };
                return { name: m.name, unit: m.def.unit, histogram: { aggregationTemporality: 2, dataPoints: [point] } };
              }),
            }],
          }],
        };
      }
      if (logs.length) {
        out.logs = {
          resourceLogs: [{
            resource,
            scopeLogs: [{
              scope,
              logRecords: logs.map((l) => ({
                timeUnixNano: nano(l.timeMs),
                severityNumber: SEVERITY[l.sev],
                severityText: l.sev.toUpperCase(),
                body: { stringValue: l.body },
                attributes: toKeyValues(l.attrs),
                ...(l.traceId ? { traceId: l.traceId, spanId: l.spanId } : {}),
              })),
            }],
          }],
        };
      }
      return out;
    },

    /** Export and clear buffered telemetry. File export is synchronous; OTLP is awaited. Never throws. */
    async flush() {
      if (!active) return;
      const p = api.payloads();
      spans = [];
      logs = [];
      metrics.clear();
      try {
        if (exporter === 'file') {
          const dir = join(root, '.unknot', 'telemetry');
          mkdirSync(dir, { recursive: true });
          const day = new Date(now()).toISOString().slice(0, 10);
          const lines = Object.values(p).map((x) => JSON.stringify(x)).join('\n');
          if (lines) appendFileSync(join(dir, `${day}.jsonl`), `${lines}\n`);
        } else {
          const base = t.endpoint.replace(/\/+$/, '');
          const paths = { traces: '/v1/traces', metrics: '/v1/metrics', logs: '/v1/logs' };
          await Promise.all(Object.entries(p).map(([k, body]) => post(base + paths[k], JSON.stringify(body), EXPORT_TIMEOUT_MS)));
        }
      } catch (err) {
        warnOnce(`export failed (${err.code ?? err.message}); dropping`);
      }
    },
  };
  return api;
}

// Process-wide default instance, disabled until configured.
let current = createTelemetry();

/** Configure the process-wide telemetry from a loaded config. Returns the instance. */
export function configureTelemetry(config, { root } = {}) {
  current = createTelemetry({ config, root });
  return current;
}
export const startSpan = (name, attrs) => current.startSpan(name, attrs);
export const withSpan = (name, attrs, fn) => current.withSpan(name, attrs, fn);
export const metric = (name, value, attrs) => current.metric(name, value, attrs);
export const log = (severity, message, attrs) => current.log(severity, message, attrs);
export const flush = () => current.flush();
export const telemetryEnabled = () => current.enabled;
