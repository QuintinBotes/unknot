// The local store (spec §23): one SQLite file per project, opened through node:sqlite so
// the plugin has no native dependency to install.
//
// Mutable entities carry `version` and are updated with compare-and-set (optimistic
// concurrency); the events table is append-only, enforced by triggers, and is the source
// of truth the other tables are projections of.

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { UnknotError } from '../core/errors.mjs';

// node:sqlite prints an ExperimentalWarning on load. Hooks and the MCP server share stderr
// with Claude Code, so the one known warning is dropped and every other passes through.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function filtered(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (typeof text === 'string' && text.includes('SQLite is an experimental feature')) return;
  return originalEmitWarning.call(this, warning, ...rest);
};
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const STORE_SCHEMA_VERSION = 1;

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, command TEXT NOT NULL, mode TEXT NOT NULL,
  state TEXT NOT NULL, scope TEXT NOT NULL, commit_sha TEXT, campaign_id TEXT, slice_id TEXT,
  actor TEXT NOT NULL, session_id TEXT, budget TEXT NOT NULL, usage TEXT NOT NULL,
  policy_digest TEXT, config_digest TEXT, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT,
  parent_run_id TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, schema_version TEXT NOT NULL,
  type TEXT NOT NULL, run_id TEXT, campaign_id TEXT, slice_id TEXT, actor TEXT NOT NULL,
  capability_id TEXT, scope TEXT, budget TEXT, policy_decision TEXT, payload TEXT NOT NULL,
  at TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, signature TEXT);
CREATE TRIGGER IF NOT EXISTS events_append_only_u BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_d BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_i BEFORE INSERT ON events
  WHEN EXISTS (SELECT 1 FROM events WHERE seq = NEW.seq OR id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS events_slice ON events(slice_id);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, generation INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
  predicate TEXT, object TEXT, attrs TEXT, source_type TEXT NOT NULL, source_ref TEXT,
  extractor TEXT NOT NULL, observed_at TEXT NOT NULL, commit_sha TEXT, confidence TEXT NOT NULL,
  scope TEXT, contradicts TEXT, path TEXT, expires_at TEXT);
CREATE INDEX IF NOT EXISTS facts_subject ON facts(subject);
CREATE INDEX IF NOT EXISTS facts_object ON facts(object);
CREATE INDEX IF NOT EXISTS facts_path ON facts(path);
CREATE INDEX IF NOT EXISTS facts_generation ON facts(generation);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, path TEXT, attrs TEXT NOT NULL,
  label TEXT NOT NULL, fact_ids TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS nodes_path ON nodes(path);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
  attrs TEXT NOT NULL, label TEXT NOT NULL, fact_ids TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src, type);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst, type);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, schema_version TEXT NOT NULL,
  kind TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, priority REAL NOT NULL,
  body TEXT NOT NULL, first_seen_commit TEXT, last_seen_commit TEXT, last_run_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS slices (
  id TEXT PRIMARY KEY, campaign_id TEXT, schema_version TEXT NOT NULL, state TEXT NOT NULL,
  risk TEXT NOT NULL, body TEXT NOT NULL, slice_digest TEXT NOT NULL, worktree TEXT, branch TEXT,
  baseline_commit TEXT, diff_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS proof_obligations (
  id TEXT PRIMARY KEY, slice_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
  requires_human INTEGER NOT NULL, status TEXT NOT NULL, evidence_id TEXT,
  version INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS po_slice ON proof_obligations(slice_id);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, obligation_id TEXT, slice_id TEXT, run_id TEXT NOT NULL,
  record TEXT NOT NULL, verdict TEXT NOT NULL, diff_hash TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, slice_id TEXT NOT NULL, stage TEXT NOT NULL, role TEXT NOT NULL,
  approver TEXT NOT NULL, key_fingerprint TEXT NOT NULL, binding TEXT NOT NULL,
  binding_hash TEXT NOT NULL, signature TEXT NOT NULL, expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT);
CREATE INDEX IF NOT EXISTS approvals_slice ON approvals(slice_id);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, finding_id TEXT, fingerprint TEXT NOT NULL, decision TEXT NOT NULL,
  rationale TEXT NOT NULL, actor TEXT NOT NULL, suppress_until TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS decisions_fp ON decisions(fingerprint);
CREATE TABLE IF NOT EXISTS artifacts (
  digest TEXT PRIMARY KEY, media_type TEXT, size INTEGER NOT NULL, encrypted INTEGER NOT NULL,
  created_at TEXT NOT NULL, run_id TEXT, label TEXT);
CREATE TABLE IF NOT EXISTS policy_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, operation TEXT NOT NULL,
  decision TEXT NOT NULL, reasons TEXT NOT NULL, policy_ids TEXT NOT NULL, risk TEXT,
  at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS file_index (
  path TEXT NOT NULL, adapter TEXT NOT NULL, adapter_version TEXT NOT NULL,
  config_digest TEXT NOT NULL, blob TEXT NOT NULL, facts TEXT NOT NULL,
  PRIMARY KEY (path, adapter));
CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY, run_id TEXT, agent_id TEXT, agent_type TEXT, grant_json TEXT NOT NULL,
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS capabilities_agent ON capabilities(agent_id);
CREATE TABLE IF NOT EXISTS counters (
  scope TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (scope, name));
CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL, stage TEXT NOT NULL, cursor TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (run_id, stage));
`;

// Tables whose rows are entities with a `version` column and a JSON `body`.
const VERSIONED = new Set(['runs', 'findings', 'campaigns', 'slices', 'proof_obligations']);

export class Store {
  /** @param {string} file absolute path, or ':memory:' */
  constructor(file, { readOnly = false } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.file = file;
    this.db = new DatabaseSync(file, { readOnly });
    // recursive_triggers makes REPLACE fire the delete trigger too.
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
    if (!readOnly) {
      if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
      this.migrate();
    }
    this.depth = 0;
  }

  migrate() {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    const current = row ? Number(this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0) : 0;
    if (current > STORE_SCHEMA_VERSION) {
      throw new UnknotError(
        'UK_STATE_CONFLICT',
        `store schema ${current} is newer than this runtime supports (${STORE_SCHEMA_VERSION}); upgrade Unknot`,
      );
    }
    if (current >= 1) this.db.exec(DDL_V1); // idempotent: adds triggers introduced after creation
    if (current < 1) {
      this.db.exec(DDL_V1);
      this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(STORE_SCHEMA_VERSION));
    }
  }

  close() {
    this.db.close();
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params) ?? null;
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  /** Run `fn` in a transaction (IMMEDIATE, so writers serialise up front). Nests by savepoint. */
  tx(fn) {
    const outer = this.depth === 0;
    const sp = `sp${this.depth}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn(this);
      this.depth--;
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.depth--;
      this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  meta(key, value) {
    if (value === undefined) return this.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
    this.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', key, String(value));
    return value;
  }

  /** Next id in a named sequence, formatted like `F-0001`. */
  nextId(prefix, width = 4) {
    return this.tx(() => {
      const row = this.get('SELECT value FROM sequences WHERE name = ?', prefix);
      const next = (row?.value ?? 0) + 1;
      this.run('INSERT OR REPLACE INTO sequences(name, value) VALUES (?, ?)', prefix, next);
      return `${prefix}-${String(next).padStart(width, '0')}`;
    });
  }

  /**
   * Compare-and-set update of a versioned entity. Throws UK_STATE_CONFLICT when someone
   * else wrote first, so a stale reader can never overwrite a newer decision.
   */
  update(table, id, expectedVersion, fields) {
    if (!VERSIONED.has(table)) throw new TypeError(`${table} is not a versioned table`);
    const cols = Object.keys(fields);
    const assignments = cols.map((c) => `${assertIdent(c)} = ?`).join(', ');
    const values = cols.map((c) => encode(fields[c]));
    const res = this.run(
      `UPDATE ${table} SET ${assignments}${cols.length ? ', ' : ''}version = version + 1 WHERE id = ? AND version = ?`,
      ...values,
      id,
      expectedVersion,
    );
    if (res.changes !== 1) {
      const exists = this.get(`SELECT version FROM ${table} WHERE id = ?`, id);
      throw new UnknotError(
        exists ? 'UK_STATE_CONFLICT' : 'UK_NOT_FOUND',
        exists
          ? `${table} ${id} changed since it was read (expected version ${expectedVersion}, found ${exists.version})`
          : `${table} ${id} does not exist`,
        { details: { table, id, expected: expectedVersion, found: exists?.version ?? null } },
      );
    }
    return expectedVersion + 1;
  }

  insert(table, row) {
    const cols = Object.keys(row).map(assertIdent);
    this.run(
      `INSERT INTO ${assertIdent(table)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => encode(row[c])),
    );
  }

  /** Increment a budget/usage counter and return the new value. */
  bump(scope, name, by = 1) {
    this.run(
      'INSERT INTO counters(scope, name, value) VALUES (?, ?, ?) ON CONFLICT(scope, name) DO UPDATE SET value = value + excluded.value',
      scope,
      name,
      by,
    );
    return this.get('SELECT value FROM counters WHERE scope = ? AND name = ?', scope, name).value;
  }

  counters(scope) {
    return Object.fromEntries(this.all('SELECT name, value FROM counters WHERE scope = ?', scope).map((r) => [r.name, r.value]));
  }
}

function assertIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new TypeError(`bad identifier ${name}`);
  return name;
}

function encode(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function parseJSONColumns(row, cols) {
  if (!row) return row;
  const out = { ...row };
  for (const c of cols) if (typeof out[c] === 'string') out[c] = JSON.parse(out[c]);
  return out;
}

const open = new Map();

/** One Store per database file per process. */
export function openStore(file, opts) {
  const key = `${file}|${opts?.readOnly ? 'ro' : 'rw'}`;
  let s = open.get(key);
  if (!s) {
    s = new Store(file, opts);
    open.set(key, s);
  }
  return s;
}

export function closeAllStores() {
  for (const s of open.values()) s.close();
  open.clear();
}
