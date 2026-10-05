// Shared helpers for the delivery adapter. Kept dependency-free and pure: the adapter
// only ever sees text, so everything here is string and object manipulation.

import { prov } from '../../runtime/graph/facts.mjs';

export const ID = 'delivery';
export const VERSION = '0.1.2';
export const EXTRACTOR = `${ID}@${VERSION}`;
/** Per-file fact cap from adapters/README.md. */
export const MAX_FACTS = 5000;

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
export const uniqSorted = (xs) => [...new Set(xs)].sort();

/** Provenance helper: `path:line`, adapter id@version. */
export function P(path, line, confidence = 'high', source_type = 'config') {
  return prov({ source_type, source_ref: `${path}:${line || 1}`, extractor: EXTRACTOR, confidence });
}

/** Drop undefined values so attrs stay canonical and small. */
export function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** 1-based line of the first line matching `^\s*"?key"?\s*:`; 1 when absent. */
export function lineOf(text, key) {
  const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:-\\s+)?["']?${esc}["']?\\s*:`);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 1;
}

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

export const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The key part of a `<type>:<key>` node id. */
export function keyOf(id) {
  return id.slice(id.indexOf(':') + 1);
}

/** Enforce the per-file fact cap and say so on the first node when it bites. */
export function capFacts(facts) {
  if (facts.length <= MAX_FACTS) return facts;
  const out = facts.slice(0, MAX_FACTS);
  const i = out.findIndex((f) => f.kind === 'node');
  if (i !== -1) out[i] = { ...out[i], attrs: { ...out[i].attrs, truncated: true } };
  return out;
}

/** JSON with comments (rush.json) - strips // and block comments outside strings. */
export function parseJsonLoose(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
