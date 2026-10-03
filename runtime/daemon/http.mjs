// HTTP plumbing for the daemon: bounded JSON bodies, the §25 error shape and its status
// mapping, per-client rate limiting, and idempotent replay of mutations.

import { digest } from '../core/canonical.mjs';
import { UnknotError, toErrorJSON } from '../core/errors.mjs';

/** Requests larger than this are refused (spec §24: request and artifact size limits). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Largest single proof-bundle file the API will return. */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_DRAIN_BYTES = 32 * 1024 * 1024;

const STATUS = {
  UK_SCHEMA_INVALID: 400,
  UK_CONFIG_INVALID: 400,
  UK_POLICY_DENIED: 403,
  UK_APPROVAL_REQUIRED: 403,
  UK_SCOPE_VIOLATION: 403,
  UK_NOT_FOUND: 404,
  UK_NOT_INITIALIZED: 404,
  UK_STATE_CONFLICT: 409,
  UK_APPROVAL_STALE: 409,
  UK_BASELINE_INVALID: 409,
  UK_VERIFICATION_FAILED: 409,
  UK_BUDGET_EXCEEDED: 429,
};

/** An UnknotError that carries the HTTP status to answer with (for cases the code alone cannot say). */
export class ApiError extends UnknotError {
  constructor(status, code, message, extra) {
    super(code, message, extra);
    this.status = status;
  }
}

export const statusFor = (err) => err?.status ?? STATUS[err?.code] ?? 500;

/** Write a JSON response. Every response is uncacheable and never carries CORS headers. */
export function sendJson(res, status, body, headers = {}) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** Send any thrown value as the structured error. Unknown errors become opaque 500s: no stack, no internals. */
export function sendError(res, err, headers = {}) {
  const known = err instanceof UnknotError;
  const status = known ? statusFor(err) : 500;
  // Unknot errors are written for callers; anything else may carry paths or internals.
  const body = known ? toErrorJSON(err) : toErrorJSON(new UnknotError('UK_TOOL_FAILED', 'internal error', { retryable: false }));
  if (status === 401) headers = { 'www-authenticate': 'Bearer', ...headers };
  if (!res.headersSent) sendJson(res, status, body, headers);
  else res.end();
  return status;
}

/** Content-Type must be exactly JSON (optionally UTF-8); anything else is 415. */
export function requireJsonContentType(req) {
  const ct = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(ct)) {
    throw new ApiError(415, 'UK_SCHEMA_INVALID', 'content-type must be application/json', { details: { reason: 'unsupported_media_type' } });
  }
}

/**
 * Read and parse a JSON object body within `limit` bytes. The limit is enforced twice:
 * on the declared length (cheap rejection) and on bytes actually received (a lying client).
 * After an overflow the remainder is discarded up to a hard cap, then the socket is cut.
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const tooBig = () => new ApiError(413, 'UK_SCHEMA_INVALID', `request body exceeds ${limit} bytes`, { details: { limit } });
    let received = 0;
    let overflow = false;
    const chunks = [];
    const onData = (chunk) => {
      received += chunk.length;
      if (overflow) {
        if (received > MAX_DRAIN_BYTES) req.destroy();
        return;
      }
      if (received > limit) {
        overflow = true;
        chunks.length = 0;
        reject(tooBig());
        return;
      }
      chunks.push(chunk);
    };
    if (Number.isFinite(declared) && declared > limit) {
      overflow = true;
      req.on('data', onData);
      reject(tooBig());
      return;
    }
    req.on('data', onData);
    req.on('error', reject);
    req.on('end', () => {
      if (overflow) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return reject(new ApiError(400, 'UK_SCHEMA_INVALID', 'request body is not valid JSON'));
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return reject(new ApiError(400, 'UK_SCHEMA_INVALID', 'request body must be a JSON object'));
      }
      resolve(value);
    });
  });
}

/**
 * Token bucket per key. Capacity equals the per-minute rate, so a client may burst a
 * minute's allowance and then sustain the average.
 */
export class RateLimiter {
  constructor({ perMinute = 60, now = () => Date.now(), maxKeys = 10_000 } = {}) {
    this.perMinute = perMinute;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  /** @returns {{ok: boolean, retryAfter: number}} retryAfter is whole seconds */
  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: this.perMinute, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) * this.perMinute) / 60_000);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((1 - b.tokens) * 60_000) / this.perMinute / 1000)) };
  }
}

/** Parse `Idempotency-Key`: 8-128 visible ASCII characters. */
export function idempotencyKey(req) {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string' || k.length < 8 || k.length > 128 || !/^[\x21-\x7e]+$/.test(k)) {
    throw new ApiError(400, 'UK_SCHEMA_INVALID', 'mutations require an Idempotency-Key header of 8-128 visible characters', { details: { header: 'Idempotency-Key' } });
  }
  return k;
}

const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

/**
 * Run `fn` at most once per (scope, key). Same key and same request → the stored response
 * is replayed; same key and a different request → 409. Only successful responses are
 * stored, so a transient failure can be retried with the same key. Callers serialise per
 * store, which makes lookup-then-run atomic with respect to other requests.
 * @param {import('../state/store.mjs').Store} store
 * @param {{scope: string, key: string, request: object, fn: () => Promise<{status: number, body: unknown, headers?: object}>}} a
 */
export async function withIdempotency(store, { scope, key, request, fn }) {
  const rowKey = `${scope}|${key}`;
  const hash = digest(request);
  const row = store.get('SELECT request_hash, response FROM idempotency WHERE key = ?', rowKey);
  if (row) {
    if (row.request_hash !== hash) {
      throw new ApiError(409, 'UK_STATE_CONFLICT', 'Idempotency-Key was already used with a different request', { details: { header: 'Idempotency-Key' } });
    }
    const stored = JSON.parse(row.response);
    return { ...stored, headers: { ...stored.headers, 'idempotent-replay': 'true' } };
  }
  const out = await fn();
  if (out.status >= 200 && out.status < 300) {
    const at = new Date().toISOString();
    store.run('DELETE FROM idempotency WHERE at < ?', new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString());
    store.run(
      'INSERT OR IGNORE INTO idempotency(key, request_hash, response, at) VALUES (?, ?, ?, ?)',
      rowKey,
      hash,
      JSON.stringify({ status: out.status, body: out.body, headers: out.headers ?? {} }),
      at,
    );
  }
  return out;
}

/** The strong ETag for an entity version. */
export const etagFor = (version) => `"${version}"`;

/** Enforce `If-Match` against the current entity version (absent header = unconditional). */
export function checkIfMatch(req, version) {
  const h = req.headers['if-match'];
  if (h === undefined) return;
  const wanted = String(h).split(',').map((s) => s.trim().replace(/^W\//, ''));
  if (wanted.includes('*') || wanted.includes(etagFor(version))) return;
  throw new ApiError(412, 'UK_STATE_CONFLICT', 'If-Match does not match the current version; re-read and retry', {
    details: { current: etagFor(version) },
  });
}

/** Small promise-chain mutex: SQLite is synchronous but handlers await, so mutations are serialised per project. */
export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(fn) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
