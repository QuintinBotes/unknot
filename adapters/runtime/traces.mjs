// Trace parsers: OTLP JSON, OTLP JSON Lines, Jaeger JSON and Zipkin v2 JSON, all
// normalised to one span shape by lazy generators so the deriver never holds a second
// copy. Only allowlisted attributes survive normalisation: span attributes routinely
// carry PII and secrets, so anything unknown is dropped here, at the boundary.

import { MAX_SPANS, redactStatement, safeName, stripQuery, templatePath } from './util.mjs';

// raw attribute key -> canonical key. Anything not listed is discarded.
const ALLOWED = new Map([
  ['http.method', 'http.method'], ['http.request.method', 'http.method'],
  ['http.route', 'http.route'], ['http.target', 'http.target'], ['url.path', 'url.path'],
  ['http.url', 'url.path'], ['url.full', 'url.path'], // reduced to a path: query strings are never kept
  ['http.status_code', 'http.status_code'], ['http.response.status_code', 'http.status_code'],
  ['db.system', 'db.system'], ['db.name', 'db.name'], ['db.namespace', 'db.name'],
  ['db.statement', 'db.statement'], ['db.query.text', 'db.statement'],
  ['db.sql.table', 'db.sql.table'], ['db.collection.name', 'db.sql.table'],
  ['messaging.system', 'messaging.system'],
  ['messaging.destination', 'messaging.destination'], ['messaging.destination.name', 'messaging.destination'],
  ['rpc.service', 'rpc.service'], ['rpc.method', 'rpc.method'],
  ['peer.service', 'peer.service'], ['server.address', 'server.address'],
]);

const KINDS = new Set(['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER']);
const OTLP_KIND = ['INTERNAL', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];

/** Apply one raw key/value to the allowlisted attribute bag. */
function putAttr(out, key, value) {
  const canon = ALLOWED.get(key);
  if (!canon || value === null || value === undefined || typeof value === 'object') return;
  switch (canon) {
    case 'http.status_code': {
      const n = Number(value);
      if (Number.isFinite(n)) out[canon] = n;
      break;
    }
    case 'db.statement': out[canon] = redactStatement(value); break;
    case 'http.route': out[canon] = stripQuery(value); break;
    case 'http.target': out[canon] = templatePath(stripQuery(value)); break;
    case 'url.path': out[canon] = templatePath(stripQuery(value)); break;
    case 'http.method': out[canon] = safeName(value, 16).toUpperCase(); break;
    default: out[canon] = safeName(value);
  }
}

export function normaliseKind(k) {
  if (typeof k === 'number') return OTLP_KIND[k] ?? 'INTERNAL';
  const s = String(k ?? '').toUpperCase().replace(/^SPAN_KIND_/, '');
  return KINDS.has(s) ? s : 'INTERNAL';
}

/** ns/us timestamps as Number; BigInt only when the value would lose integer precision. */
function bigDelta(end, start) {
  const e = toBig(end);
  const s = toBig(start);
  if (e === null || s === null) return 0;
  return Number(e - s);
}

function toBig(v) {
  if (v === null || v === undefined || v === '') return null;
  try { return BigInt(typeof v === 'number' ? Math.trunc(v) : String(v)); } catch { return null; }
}

function otlpValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return v.intValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  return undefined;
}

function span(trace, id, parent, service, kind, name, startNs, durNs, error, attrs) {
  const status = attrs['http.status_code'];
  return {
    trace: String(trace ?? '').toLowerCase(),
    id: String(id ?? '').toLowerCase(),
    parent: parent ? String(parent).toLowerCase() : '',
    service: safeName(service) || 'unknown_service',
    kind,
    name: safeName(name),
    start_ns: startNs,
    duration_ns: durNs > 0 ? durNs : 0, // clock skew can produce negative durations
    error: Boolean(error) || (typeof status === 'number' && status >= 500),
    attrs,
  };
}

/** One ExportTraceServiceRequest. */
function* otlpRequest(req) {
  for (const rs of req?.resourceSpans ?? []) {
    let service = 'unknown_service';
    for (const a of rs.resource?.attributes ?? []) {
      if (a.key === 'service.name') service = otlpValue(a.value) ?? service;
    }
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      for (const s of ss.spans ?? []) {
        const attrs = {};
        for (const a of s.attributes ?? []) if (ALLOWED.has(a.key)) putAttr(attrs, a.key, otlpValue(a.value));
        const code = s.status?.code;
        const error = code === 2 || code === 'STATUS_CODE_ERROR';
        const startNs = Number(s.startTimeUnixNano ?? 0);
        yield span(s.traceId, s.spanId, s.parentSpanId, service, normaliseKind(s.kind), s.name, startNs,
          bigDelta(s.endTimeUnixNano, s.startTimeUnixNano), error, attrs);
      }
    }
  }
}

function* jaeger(doc) {
  for (const t of doc.data ?? []) {
    const processes = t.processes ?? {};
    for (const s of t.spans ?? []) {
      const attrs = {};
      let kind = 'INTERNAL';
      let error = false;
      for (const tag of s.tags ?? []) {
        if (tag.key === 'span.kind') kind = normaliseKind(tag.value);
        else if (tag.key === 'error') error = tag.value === true || tag.value === 'true';
        else if (tag.key === 'otel.status_code') error = String(tag.value).toUpperCase() === 'ERROR';
        else if (ALLOWED.has(tag.key)) putAttr(attrs, tag.key, tag.value);
      }
      const ref = (s.references ?? []).find((r) => r.refType === 'CHILD_OF') ?? (s.references ?? [])[0];
      const parent = ref?.spanID ?? s.parentSpanID ?? '';
      const proc = processes[s.processID] ?? {};
      yield span(s.traceID ?? t.traceID, s.spanID, parent, proc.serviceName, kind, s.operationName,
        Number(s.startTime ?? 0) * 1000, Number(s.duration ?? 0) * 1000, error, attrs);
    }
  }
}

function* zipkin(list) {
  for (const item of list) {
    // /api/v2/traces returns an array of traces (arrays of spans); /spans returns spans.
    if (Array.isArray(item)) { yield* zipkin(item); continue; }
    if (!item || typeof item !== 'object') continue;
    const attrs = {};
    const tags = item.tags ?? {};
    for (const k of Object.keys(tags)) if (ALLOWED.has(k)) putAttr(attrs, k, tags[k]);
    const kind = normaliseKind(item.kind);
    // The remote endpoint is Zipkin's peer.service for outbound spans.
    if (!attrs['peer.service'] && item.remoteEndpoint?.serviceName && (kind === 'CLIENT' || kind === 'PRODUCER')) {
      attrs['peer.service'] = safeName(item.remoteEndpoint.serviceName);
    }
    yield span(item.traceId, item.id, item.parentId, item.localEndpoint?.serviceName, kind, item.name,
      Number(item.timestamp ?? 0) * 1000, Number(item.duration ?? 0) * 1000, 'error' in tags, attrs);
  }
}

/** Parse the whole text as JSON; null when it is not a single JSON document. */
function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Detect the format and return a lazy span stream plus metadata that is complete only
 * after the stream has been consumed (`truncated` flips when the span cap is reached).
 */
export function parseTraces(text, { maxSpans = MAX_SPANS } = {}) {
  const meta = { format: 'unknown', truncated: false, emitted: 0 };
  let source;
  const doc = tryJson(text);
  if (doc && !Array.isArray(doc) && doc.resourceSpans) { meta.format = 'otlp-json'; source = otlpRequest(doc); }
  else if (doc && !Array.isArray(doc) && Array.isArray(doc.data)) { meta.format = 'jaeger-json'; source = jaeger(doc); }
  else if (Array.isArray(doc)) { meta.format = 'zipkin-v2-json'; source = zipkin(doc); }
  else if (doc === null) {
    meta.format = 'otlp-jsonl';
    source = (function* lines() {
      let start = 0;
      while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end < 0) end = text.length;
        const line = text.slice(start, end).trim();
        start = end + 1;
        if (line === '') continue;
        const req = tryJson(line);
        if (req === null || typeof req !== 'object') throw new SyntaxError('trace file is neither JSON nor JSON Lines');
        yield* otlpRequest(req);
      }
    })();
  } else {
    throw new SyntaxError('unrecognised trace format');
  }
  const spans = (function* bounded() {
    for (const s of source) {
      if (meta.emitted >= maxSpans) { meta.truncated = true; return; }
      meta.emitted += 1;
      yield s;
    }
  })();
  return { spans, meta };
}
