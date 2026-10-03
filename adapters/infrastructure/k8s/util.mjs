// Shared helpers for the k8s adapter: provenance, YAML document splitting, image parsing
// and selector matching. Kept tiny and pure so every module stays deterministic.

import { posix } from 'node:path';
import { prov } from '../../../runtime/graph/facts.mjs';
import { parseYAML, YAMLError } from '../../../runtime/core/yaml.mjs';

export const ID = 'k8s';
export const VERSION = '0.1.0';
export const EXTRACTOR = `${ID}@${VERSION}`;

/** Per-file fact cap (adapters/README.md rules). */
export const FACT_CAP = 5000;

export const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const asArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
export const asString = (x) => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : null);
export const uniqSorted = (xs) => [...new Set(xs.filter((x) => x != null))].sort();

/** Build a provenance maker bound to a file and optional overrides. */
export function provMaker(path, { sourceType = 'config', confidence = 'high' } = {}) {
  return (line = 1, extra = {}) => prov({
    source_type: sourceType,
    source_ref: `${path}:${line || 1}`,
    extractor: EXTRACTOR,
    confidence,
    ...extra,
  });
}

/** Repository directory of a path; '.' for the root so ids stay non-empty. */
export const dirOf = (path) => posix.dirname(path);
export const baseOf = (path) => posix.basename(path);

/** Resolve `rel` against `dir`; null when it escapes the repository or is remote. */
export function resolveRel(dir, rel) {
  if (typeof rel !== 'string' || /^[a-z][a-z0-9+.-]*:\/\//i.test(rel) || rel.startsWith('git@')) return null;
  const out = posix.normalize(posix.join(dir, rel));
  if (out.startsWith('..') || posix.isAbsolute(out)) return null;
  return out === '' ? '.' : out.replace(/\/$/, '');
}

/**
 * Split a multi-document YAML stream into segments, remembering each one's first line so
 * facts can point at `path:line`. Parsing per segment keeps one bad document from hiding
 * the rest of the file.
 */
export function splitDocs(text) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let cur = [];
  let start = 1;
  const flush = () => {
    if (cur.some((l) => l.trim() !== '' && !l.trim().startsWith('#'))) segs.push({ text: cur.join('\n'), line: start });
    cur = [];
  };
  lines.forEach((l, i) => {
    if (/^---(\s|$)/.test(l) || /^\.\.\.\s*$/.test(l)) {
      flush();
      start = i + 2;
    } else {
      cur.push(l);
    }
  });
  flush();
  return segs;
}

/** Parse every document; documents that fail to parse are returned as `error` entries. */
export function parseDocs(text) {
  return splitDocs(text).map((s) => {
    try {
      return { doc: parseYAML(s.text), line: s.line };
    } catch (e) {
      if (e instanceof YAMLError) return { doc: null, line: s.line, error: e };
      throw e;
    }
  });
}

/**
 * Parse an image reference. `latest` is true for an explicit `:latest` and for a missing
 * tag, because both resolve to a moving target.
 */
export function parseImage(ref) {
  const raw = String(ref ?? '').trim();
  let rest = raw;
  let digest = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const pinned = !!digest && /^sha256:[0-9a-f]{6,}/i.test(digest);
  const variable = raw.includes('$');
  return {
    raw,
    name: rest,
    tag,
    digest,
    pinned,
    latest: !variable && !pinned && (tag === null || tag === 'latest'),
    untagged: !variable && tag === null && !digest,
    variable,
  };
}

/** Last path segment of an image name: `ghcr.io/acme/api` -> `api`. */
export const imageBase = (name) => String(name).split('/').pop();

/** Kubernetes label selector match; supports matchLabels, matchExpressions and bare maps. */
export function matchesSelector(selector, labels) {
  const l = labels ?? {};
  if (!isObj(selector)) return false;
  if (!('matchLabels' in selector) && !('matchExpressions' in selector)) {
    // Legacy Service form: a plain label map.
    return Object.entries(selector).every(([k, v]) => k in l && String(l[k]) === String(v));
  }
  for (const [k, v] of Object.entries(isObj(selector.matchLabels) ? selector.matchLabels : {})) {
    if (!(k in l) || String(l[k]) !== String(v)) return false;
  }
  for (const e of asArray(selector.matchExpressions)) {
    if (!isObj(e)) continue;
    const vals = asArray(e.values).map(String);
    const has = e.key in l;
    if (e.operator === 'In' && !(has && vals.includes(String(l[e.key])))) return false;
    if (e.operator === 'NotIn' && has && vals.includes(String(l[e.key]))) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}

/** Is a selector the empty (select everything) selector? */
export function selectorEmpty(selector) {
  if (!isObj(selector)) return true;
  if ('matchLabels' in selector || 'matchExpressions' in selector) {
    return Object.keys(selector.matchLabels ?? {}).length === 0 && asArray(selector.matchExpressions).length === 0;
  }
  return Object.keys(selector).length === 0;
}

/** Names that suggest a credential. Names only; values are never recorded. */
export const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|(^|_)KEY$)/i;

/** Cap a fact list per the adapter rules and say so on the first node. */
export function capFacts(facts, cap = FACT_CAP) {
  if (facts.length <= cap) return facts;
  const out = facts.slice(0, cap);
  const first = out.find((f) => f.kind === 'node');
  if (first) first.attrs = { ...first.attrs, truncated: true, dropped_facts: facts.length - cap };
  return out;
}
