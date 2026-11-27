// Canonical JSON and digests. Approvals, evidence and the ledger all bind to hashes, and
// a hash is only meaningful if two equal values always serialise to the same bytes.

import { createHash, randomBytes } from 'node:crypto';

/** JSON with object keys sorted at every depth; undefined members dropped like JSON does. */
export function canonicalJSON(value) {
  return JSON.stringify(sortDeep(value));
}

// A value already in canonical form is returned as it is, not copied: cached facts are stored
// canonical, and copying every one of them was most of the cost of hashing a large map (#145).
function sortDeep(value) {
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      const s = v === undefined ? null : sortDeep(v);
      if (s !== v && !out) out = value.slice(0, i);
      if (out) out.push(s);
    }
    return out ?? value;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (typeof value.toJSON === 'function') return sortDeep(value.toJSON());
    const keys = Object.keys(value);
    let ordered = true;
    for (let i = 0; i < keys.length && ordered; i++) ordered = value[keys[i]] !== undefined && (i === 0 || keys[i - 1] < keys[i]);
    if (!ordered) {
      const out = {};
      for (const key of keys.sort()) {
        if (value[key] !== undefined) out[key] = sortDeep(value[key]);
      }
      return out;
    }
    let out = null;
    for (let i = 0; i < keys.length; i++) {
      const v = value[keys[i]];
      const s = sortDeep(v);
      if (s !== v && !out) {
        out = {};
        for (let j = 0; j < i; j++) out[keys[j]] = value[keys[j]];
      }
      if (out) out[keys[i]] = s;
    }
    return out ?? value;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('non-finite numbers have no canonical JSON form');
  }
  return value;
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** `sha256:<hex>` over canonical JSON, the form every binding in Unknot uses. */
export function digest(value) {
  return `sha256:${sha256(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value))}`;
}

export function randomId(bytes = 6) {
  return randomBytes(bytes).toString('hex');
}
