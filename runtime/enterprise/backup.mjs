// Backup and restore (disaster recovery) for one project's Unknot state.
//
// Archive format (documented in docs/operations.md): a single UTF-8 file of newline-
// separated lines.
//
//   line 1      plain JSON header: format, version, cipher, scrypt parameters, salt
//   lines 2..n  one record per line: base64( iv[12] | gcm-tag[16] | ciphertext ), where the
//               plaintext is a JSON record and the AEAD additional data binds the record to
//               the header and its position (so records cannot be reordered, dropped from
//               the middle, or spliced in from another backup)
//   last record the manifest: sha256 and size of every file, project id, audit public key
//               and the ledger head. A archive without a manifest is truncated and rejected.
//
// Records are `chunk`s of files (4 MiB each) followed by the `manifest`. Files are the
// consistent SQLite snapshot (VACUUM INTO), config.yaml, decisions.jsonl, campaigns/,
// slices/, decompositions/ and the CAS directory (whose blobs are already encrypted under
// the project cache key, which is deliberately NOT part of the backup: see operations.md).

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { unknotHome } from '../core/project.mjs';
import { verifyLedger } from '../state/ledger.mjs';
import { Store } from '../state/store.mjs';

export const BACKUP_FORMAT = 'unknot-backup';
export const BACKUP_VERSION = 1;
const CHUNK = 4 * 1024 * 1024;
const MIN_PASSPHRASE = 12;
const SCRYPT_N = 1 << 15;
const DB_REL = 'state/unknot.db';
const TOP_FILES = ['config.yaml', 'decisions.jsonl'];
const TOP_DIRS = ['campaigns', 'slices', 'decompositions', 'cas'];

const integrity = (msg, details) => new UnknotError('UK_INTEGRITY', msg, { details });
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- passphrases ----

/**
 * Read a passphrase file for unattended backups. Refuses anything another user could read:
 * a passphrase protecting the archive is worthless if the file next to it is world-readable.
 */
export function readPassphraseFile(path) {
  const abs = resolve(path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new UnknotError('UK_NOT_FOUND', `no passphrase file ${abs}`);
  }
  if (!st.isFile()) throw new UnknotError('UK_CONFIG_INVALID', `${abs} is not a regular file`);
  if (process.platform !== 'win32') {
    if (st.mode & 0o077) {
      throw new UnknotError('UK_POLICY_DENIED', `passphrase file ${abs} is accessible to group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`, { details: { policy: 'backup.passphrase_file_mode' } });
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new UnknotError('UK_POLICY_DENIED', `passphrase file ${abs} is not owned by the current user`);
    }
  }
  const pass = readFileSync(abs, 'utf8').replace(/\r?\n+$/, '');
  checkPassphrase(pass);
  return pass;
}

function checkPassphrase(pass) {
  if (typeof pass !== 'string' || pass.length < MIN_PASSPHRASE) {
    throw new UnknotError('UK_CONFIG_INVALID', `backup passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
}

// ---- record encryption ----

function deriveKey(passphrase, kdf) {
  return scryptSync(passphrase, Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

const aad = (headerLine, seq) => Buffer.from(`${sha(headerLine)}:${seq}`);

function sealRecord(key, headerLine, seq, record) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(headerLine, seq));
  const ct = Buffer.concat([c.update(JSON.stringify(record), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function openRecord(key, headerLine, seq, line) {
  const raw = Buffer.from(line, 'base64');
  if (raw.length < 28) throw integrity(`backup record ${seq} is malformed`);
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(aad(headerLine, seq));
  d.setAuthTag(raw.subarray(12, 28));
  try {
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    throw integrity(`backup record ${seq} failed authentication (wrong passphrase, or the archive was altered)`);
  }
}

/** Newline-delimited lines of a file as strings, without reading it all into memory. */
function* readLines(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let rest = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      rest = Buffer.concat([rest, buf.subarray(0, n)]);
      let i;
      while ((i = rest.indexOf(10)) !== -1) {
        yield rest.subarray(0, i).toString('utf8');
        rest = rest.subarray(i + 1);
      }
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseHeader(line) {
  let h;
  try {
    h = JSON.parse(line);
  } catch {
    throw integrity('not an Unknot backup (header is not JSON)');
  }
  const k = h?.kdf;
  if (h?.format !== BACKUP_FORMAT || h.version !== BACKUP_VERSION || h.cipher !== 'aes-256-gcm' || k?.alg !== 'scrypt') {
    throw integrity('not an Unknot backup, or an unsupported version');
  }
  // A hostile header must not be able to request unbounded memory or time.
  if (!Number.isInteger(k.N) || k.N < 1 << 14 || k.N > 1 << 20 || (k.N & (k.N - 1)) !== 0 || k.r !== 8 || k.p !== 1 || typeof k.salt !== 'string') {
    throw integrity('backup header has unacceptable key-derivation parameters');
  }
  return h;
}

/** Relative paths allowed inside an archive; anything else is refused before it touches disk. */
export function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  if (rel === DB_REL || TOP_FILES.includes(rel)) return true;
  const [top] = rel.split('/');
  return TOP_DIRS.includes(top) && rel.includes('/');
}

// ---- create ----

function walk(root, rel, out) {
  const abs = join(root, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return; // never follow links out of the project
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(root, `${rel}/${name}`, out);
  } else if (st.isFile() && !rel.endsWith('.tmp')) out.push({ rel, abs });
}

/**
 * Write an encrypted snapshot of the project to `outFile` (which must not exist).
 * @param {{store: object, paths: object, projectId: string}} ctx
 */
export function createBackup(ctx, outFile, passphrase, { kdfN = SCRYPT_N } = {}) {
  checkPassphrase(passphrase);
  const out = resolve(outFile);
  if (existsSync(out)) throw new UnknotError('UK_STATE_CONFLICT', `${out} already exists; backups are never overwritten`);
  const tmp = mkdtempSync(join(tmpdir(), 'unknot-backup-'));
  let fd = null;
  try {
    // VACUUM INTO is a transactionally consistent copy even while other processes write.
    const snapshot = join(tmp, 'unknot.db');
    ctx.store.run('VACUUM INTO ?', snapshot);
    const snap = new Store(snapshot, { readOnly: true });
    const pub = snap.meta('audit_public_key');
    const ledger = verifyLedger(snap, pub);
    const projectId = snap.meta('project_id');
    snap.close();
    if (!ledger.ok) throw integrity(`refusing to back up a ledger that does not verify (broken at event ${ledger.broken_at}: ${ledger.reason})`);

    const files = [{ rel: DB_REL, abs: snapshot }];
    for (const f of TOP_FILES) walk(ctx.paths.base, f, files);
    for (const d of TOP_DIRS) walk(ctx.paths.base, d, files);

    const kdf = { alg: 'scrypt', N: kdfN, r: 8, p: 1, salt: randomBytes(16).toString('base64') };
    const headerLine = JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, cipher: 'aes-256-gcm', created_at: nowISO(), kdf });
    const key = deriveKey(passphrase, kdf);
    mkdirSync(dirname(out), { recursive: true });
    fd = openSync(out, 'wx', 0o600);
    writeSync(fd, `${headerLine}\n`);
    let seq = 0;
    const manifestFiles = [];
    for (const f of files) {
      const hash = createHash('sha256');
      const src = openSync(f.abs, 'r');
      let size = 0;
      try {
        const total = fstatSync(src).size;
        const buf = Buffer.alloc(CHUNK);
        let i = 0;
        do {
          const n = readSync(src, buf, 0, CHUNK, null);
          size += n;
          hash.update(buf.subarray(0, n));
          const last = size >= total || n === 0;
          writeSync(fd, `${sealRecord(key, headerLine, seq++, { t: 'chunk', path: f.rel, i: i++, last, data: buf.subarray(0, n).toString('base64') })}\n`);
          if (last) break;
        } while (true);
      } finally {
        closeSync(src);
      }
      manifestFiles.push({ path: f.rel, sha256: hash.digest('hex'), size });
    }
    const manifest = {
      t: 'manifest',
      created_at: nowISO(),
      project_id: projectId,
      audit_public_key: pub,
      ledger: { count: ledger.count, head: ledger.head },
      files: manifestFiles,
      total_bytes: manifestFiles.reduce((n, f) => n + f.size, 0),
    };
    writeSync(fd, `${sealRecord(key, headerLine, seq++, manifest)}\n`);
    closeSync(fd);
    fd = null;
    return { file: out, project_id: projectId, files: manifestFiles.length, bytes: manifest.total_bytes, ledger: manifest.ledger };
  } catch (err) {
    if (fd !== null) {
      closeSync(fd);
      rmSync(out, { force: true });
    }
    throw err;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- read ----

/**
 * Decrypt and structurally validate the whole archive, handing each file chunk to
 * `onChunk(path, buffer, {first, last})`. Returns the authenticated manifest after checking
 * every file's digest and size against it.
 */
function scanArchive(file, passphrase, onChunk) {
  if (!existsSync(file)) throw new UnknotError('UK_NOT_FOUND', `no backup file ${file}`);
  const lines = readLines(file);
  const first = lines.next();
  if (first.done) throw integrity('backup file is empty');
  const headerLine = first.value;
  const header = parseHeader(headerLine);
  const key = deriveKey(passphrase, header.kdf);
  const seen = new Map(); // path → {hash, size, next}
  let manifest = null;
  let seq = 0;
  for (const line of lines) {
    if (manifest) throw integrity('backup has data after its manifest');
    const rec = openRecord(key, headerLine, seq++, line);
    if (rec.t === 'manifest') {
      manifest = rec;
      continue;
    }
    if (rec.t !== 'chunk' || !safeRel(rec.path) || typeof rec.data !== 'string' || typeof rec.last !== 'boolean') throw integrity(`backup record ${seq - 1} is not a valid file chunk`);
    let s = seen.get(rec.path);
    if (!s) seen.set(rec.path, (s = { hash: createHash('sha256'), size: 0, next: 0, done: false }));
    if (s.done || rec.i !== s.next) throw integrity(`backup chunks for ${rec.path} are out of order`);
    const buf = Buffer.from(rec.data, 'base64');
    s.hash.update(buf);
    s.size += buf.length;
    s.next++;
    s.done = rec.last;
    s.final = s.done ? s.hash.digest('hex') : null;
    onChunk?.(rec.path, buf, { first: rec.i === 0, last: rec.last });
  }
  if (!manifest) throw integrity('backup has no manifest: the archive is truncated');
  const listed = new Map();
  for (const f of manifest.files ?? []) {
    if (!safeRel(f.path) || listed.has(f.path)) throw integrity(`manifest lists an invalid or duplicate path ${f.path}`);
    listed.set(f.path, f);
  }
  if (listed.size !== seen.size) throw integrity(`manifest lists ${listed.size} files but the archive holds ${seen.size}`);
  for (const [path, f] of listed) {
    const s = seen.get(path);
    if (!s || !s.done || s.final !== f.sha256 || s.size !== f.size) throw integrity(`digest mismatch for ${path}`);
  }
  if (!listed.has(DB_REL)) throw integrity('backup contains no database snapshot');
  return manifest;
}

function checkLedger(dbFile, manifest) {
  const store = new Store(dbFile, { readOnly: true });
  try {
    if (store.meta('audit_public_key') !== manifest.audit_public_key) throw integrity('audit key in the database differs from the manifest');
    const r = verifyLedger(store, manifest.audit_public_key);
    if (!r.ok) throw integrity(`restored ledger does not verify (broken at event ${r.broken_at}: ${r.reason})`);
    if (r.count !== manifest.ledger.count || r.head !== manifest.ledger.head) throw integrity('ledger head differs from the manifest');
    return r;
  } finally {
    store.close();
  }
}

/** Check digests and ledger. Never throws for tampering: returns `{ok: false, reason}`. */
export function verifyBackup(file, passphrase) {
  checkPassphrase(passphrase);
  const tmp = mkdtempSync(join(tmpdir(), 'unknot-verify-'));
  const dbFile = join(tmp, 'unknot.db');
  let fd = null;
  try {
    const manifest = scanArchive(resolve(file), passphrase, (path, buf, { first, last }) => {
      if (path !== DB_REL) return;
      if (first) fd = openSync(dbFile, 'wx', 0o600);
      writeSync(fd, buf);
      if (last) {
        closeSync(fd);
        fd = null;
      }
    });
    const ledger = checkLedger(dbFile, manifest);
    return { ok: true, project_id: manifest.project_id, created_at: manifest.created_at, files: manifest.files.length, bytes: manifest.total_bytes, ledger: { count: ledger.count, head: ledger.head } };
  } catch (err) {
    if (err instanceof UnknotError && err.code === 'UK_INTEGRITY') return { ok: false, reason: err.message };
    throw err;
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Restore into `toDir`, which must be empty or absent. The whole archive is verified
 * before the first byte is written, so a bad backup never leaves a partial restore.
 */
export function restoreBackup(file, passphrase, toDir) {
  const to = resolve(toDir);
  if (existsSync(to)) {
    if (!statSync(to).isDirectory()) throw new UnknotError('UK_STATE_CONFLICT', `${to} exists and is not a directory`);
    if (readdirSync(to).length) throw new UnknotError('UK_STATE_CONFLICT', `${to} is not empty; restore never overwrites existing data`);
  }
  const pre = verifyBackup(file, passphrase);
  if (!pre.ok) throw integrity(`backup does not verify: ${pre.reason}`);

  const base = join(to, '.unknot');
  mkdirSync(to, { recursive: true, mode: 0o700 });
  mkdirSync(base, { mode: 0o700 });
  let fd = null;
  try {
    const manifest = scanArchive(resolve(file), passphrase, (path, buf, { first, last }) => {
      const dest = join(base, path);
      if (first) {
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        fd = openSync(dest, 'wx', 0o600); // 'wx': never overwrite, and never follow a planted link
      }
      writeSync(fd, buf);
      if (last) {
        closeSync(fd);
        fd = null;
      }
    });
    const ledger = checkLedger(join(base, DB_REL), manifest);
    const keyDir = join(unknotHome(), 'projects', manifest.project_id);
    return {
      root: to,
      project_id: manifest.project_id,
      files: manifest.files.length,
      ledger: { count: ledger.count, head: ledger.head },
      keys_present: existsSync(join(keyDir, 'cache.key')) && existsSync(join(keyDir, 'audit.pem')),
      key_dir: keyDir,
    };
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(base, { recursive: true, force: true });
    throw err;
  }
}
