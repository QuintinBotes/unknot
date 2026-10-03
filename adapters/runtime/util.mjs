// Shared helpers for the runtime adapter: privacy scrubbing, statistics and the
// provenance/window stamping every runtime fact needs (spec §9.4 step 7, §9.5 TTLs).

import { prov } from '../../runtime/graph/facts.mjs';

export const EXTRACTOR = 'runtime@0.1.0';
export const DEFAULT_TTL_DAYS = 14;
export const MAX_SPANS = 2_000_000;
export const MAX_FACTS_PER_FILE = 5000;
const DAY_MS = 86_400_000;

/** Strip control characters and cap length: names become node ids and must stay inert. */
export function safeName(v, max = 200) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Redact SQL for storage. Order matters: comments and literals go first, truncation
 * last, so a cut can never expose half of a literal. Double-quoted tokens survive only
 * when they look like identifiers (they are identifiers in standard SQL).
 */
export function redactStatement(sql, max = 200) {
  let s = String(sql ?? '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  s = s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '?');
  s = s.replace(/'(?:[^']|'')*'/g, '?');
  s = s.replace(/'[\s\S]*$/, '?'); // an unterminated quote swallows the remainder
  s = s.replace(/"([^"]*)"/g, (m, inner) => (/^[A-Za-z_][\w$.]*$/.test(inner) ? m : '?'));
  s = s.replace(/\b0x[0-9a-f]+\b/gi, '?');
  s = s.replace(/(?<![\w$.])\d+(?:\.\d+)?(?:e[+-]?\d+)?(?!\w)/gi, '?');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Drop scheme, authority, query and fragment: query strings routinely carry tokens. */
export function stripQuery(v) {
  let s = String(v ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  s = safeName(s);
  return s === '' ? '/' : s;
}

/** Collapse high-cardinality path segments (ids, uuids, long tokens) into `:id`. */
export function templatePath(path) {
  return path.split('/').map((seg) => {
    if (seg === '') return seg;
    if (/^\d+$/.test(seg)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id';
    if (seg.length >= 20 && /\d/.test(seg) && /^[\w-]+$/.test(seg)) return ':id';
    return seg;
  }).join('/');
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Ascending numeric copy (the default sort is lexicographic, which is wrong for numbers). */
export function ascending(arr) {
  return Float64Array.from(arr).sort();
}

export function round(x, d = 3) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export function toIso(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Window end plus ttl; evidence older than that is stale (§9.5). */
export function expiry(endIso, ttlDays) {
  return toIso(Date.parse(endIso) + ttlDays * DAY_MS);
}

export function ttlOf(options) {
  const t = options?.ttl_days;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULT_TTL_DAYS;
}

/** Repo-relative POSIX prefix or null: absolute paths and `..` are refused. */
export function cleanCodeRoot(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (s === '' || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..')) return null;
  return safeName(s, 300);
}

export function codeRootOf(options, service) {
  const m = options?.service_map;
  if (!m || typeof m !== 'object' || !Object.hasOwn(m, service)) return null;
  return cleanCodeRoot(m[service]);
}

/**
 * Stamps provenance and the evidence window onto every fact of one evidence file so no
 * code path can forget `observed_window` or `expires_at`.
 */
export function stamper({ file, sourceType, window, ttlDays }) {
  const expires_at = expiry(window.end, ttlDays);
  return {
    prov: (locator, confidence = 'high') => prov({
      source_type: sourceType, source_ref: `${file}#${locator}`, extractor: EXTRACTOR, confidence,
    }),
    attrs: (extra = {}) => {
      const out = {};
      for (const k of Object.keys(extra).sort()) if (extra[k] !== null && extra[k] !== undefined) out[k] = extra[k];
      out.observed_window = { start: window.start, end: window.end };
      out.expires_at = expires_at;
      return out;
    },
  };
}

/** Deterministic order: node facts by id, edge facts by type|from|to. */
export function sortFacts(facts) {
  const key = (f) => (f.kind === 'node' ? f.id : `${f.type}|${f.from}|${f.to}`);
  return facts.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Bound output per evidence file (adapters README): keep the head, flag every survivor. */
export function capFacts(facts, max) {
  if (facts.length <= max) return facts;
  const kept = facts.slice(0, max);
  for (const f of kept) f.attrs.truncated = true;
  return kept;
}
