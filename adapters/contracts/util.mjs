// Shared helpers for the contracts adapter.

import { prov } from '../../runtime/graph/facts.mjs';

export const ID = 'contracts';
export const VERSION = '0.1.0';
export const EXTRACTOR = `${ID}@${VERSION}`;
export const MAX_FACTS = 5000;

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
export const uniqSorted = (xs) => [...new Set(xs)].sort();
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

export function P(path, line, confidence = 'high', source_type = 'config') {
  return prov({ source_type, source_ref: `${path}:${line || 1}`, extractor: EXTRACTOR, confidence });
}

export function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export function capFacts(facts) {
  if (facts.length <= MAX_FACTS) return facts;
  const out = facts.slice(0, MAX_FACTS);
  const i = out.findIndex((f) => f.kind === 'node');
  if (i !== -1) out[i] = { ...out[i], attrs: { ...out[i].attrs, truncated: true } };
  return out;
}

/** `/orders/{id}` -> `/orders/:id`, matching how language adapters name endpoints. */
export function normalizePath(p) {
  const s = String(p).replace(/\{([^}]+)\}/g, ':$1');
  return s.startsWith('/') ? s : `/${s}`;
}

/** Drop `user:pass@` from a URL so a credential in a spec's servers list is never stored. */
export const stripUserinfo = (u) => String(u).replace(/\/\/[^/@\s]*@/, '//');

/** Schema names referenced by a (possibly nested) JSON Schema fragment. */
export function schemaNames(schema, depth = 0) {
  if (!isObj(schema) || depth > 6) return [];
  const out = [];
  if (typeof schema.$ref === 'string') out.push(schema.$ref.split('/').pop());
  if (schema.items) out.push(...schemaNames(schema.items, depth + 1));
  for (const k of ['oneOf', 'anyOf', 'allOf']) for (const s of asArray(schema[k])) out.push(...schemaNames(s, depth + 1));
  if (out.length === 0 && schema.type) out.push(`inline:${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}`);
  return out;
}

/** The length of a `{...}` block starting at `open` in src, ignoring braces in strings. */
export function matchBrace(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return src.length;
}

/** Replace a matched region with the same number of newlines so line numbers survive. */
export const blank = (s) => s.replace(/[^\n]/g, '');
export const lineAt = (text, index) => text.slice(0, index).split('\n').length;
