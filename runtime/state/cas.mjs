// Content-addressed artifact store (spec §23, §16.5). Blobs are addressed by the SHA-256
// of their plaintext and stored AES-256-GCM encrypted with the project's cache key, so
// deleting the key (crypto-shredding) makes every cached blob unrecoverable.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { cacheKey, decrypt, encrypt } from '../core/keys.mjs';

function blobPath(ctx, hex) {
  return join(ctx.paths.cas, 'sha256', hex.slice(0, 2), hex.slice(2));
}

/** Store bytes; returns `sha256:<hex>`. Idempotent. */
export function casPut(ctx, data, { mediaType = 'application/octet-stream', runId = null, label = null, encrypted = true } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const hex = sha256(buf);
  const file = blobPath(ctx, hex);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, encrypted ? encrypt(cacheKey(ctx.projectId), buf) : buf, { mode: 0o600 });
    renameSync(tmp, file);
  }
  ctx.store.run(
    'INSERT OR IGNORE INTO artifacts(digest, media_type, size, encrypted, created_at, run_id, label) VALUES (?, ?, ?, ?, ?, ?, ?)',
    `sha256:${hex}`,
    mediaType,
    buf.length,
    encrypted ? 1 : 0,
    nowISO(),
    runId,
    label,
  );
  return `sha256:${hex}`;
}

/** Read and authenticate a blob. Throws UK_INTEGRITY if it was altered. */
export function casGet(ctx, digestStr) {
  const hex = String(digestStr).replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new UnknotError('UK_SCHEMA_INVALID', `bad digest ${digestStr}`);
  const file = blobPath(ctx, hex);
  if (!existsSync(file)) throw new UnknotError('UK_NOT_FOUND', `no artifact ${digestStr}`);
  const meta = ctx.store.get('SELECT encrypted FROM artifacts WHERE digest = ?', `sha256:${hex}`);
  const raw = readFileSync(file);
  const buf = meta?.encrypted === 0 ? raw : decrypt(cacheKey(ctx.projectId), raw);
  if (sha256(buf) !== hex) throw new UnknotError('UK_INTEGRITY', `artifact ${digestStr} does not match its digest`);
  return buf;
}
