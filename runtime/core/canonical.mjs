// Canonical JSON and digests. Approvals, evidence and the ledger all bind to hashes, and
// a hash is only meaningful if two equal values always serialise to the same bytes.

import { createHash, randomBytes } from 'node:crypto';

/** JSON with object keys sorted at every depth; undefined members dropped like JSON does. */
export function canonicalJSON(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortDeep(v)));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (typeof value.toJSON === 'function') return sortDeep(value.toJSON());
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortDeep(value[key]);
    }
    return out;
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
