// Ordered, named store migrations. Each is idempotent, runs inside the open-time transaction,
// and is recorded in `meta`: `schema_version` (the highest applied id) and `migrations`
// (a JSON array of applied names). A store newer than this runtime is refused, never opened.
//
// Add a migration by appending to MIGRATIONS with the next id; never edit or reorder one that
// shipped. `up(db, ctx)` gets the raw DatabaseSync and the store's DDL text in `ctx.ddl`.
// `always: true` re-runs it on every open (only for statements that are cheap and idempotent).

import { UnknotError } from '../core/errors.mjs';

export const MIGRATIONS = [
  // Everything before the runner existed: the full DDL, every statement `IF NOT EXISTS`.
  // Re-applying it on open is what adds tables and triggers introduced after a store was
  // created, so it stays `always`.
  { id: 1, name: 'initial-schema', always: true, up: (db, { ddl }) => db.exec(ddl) },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;

function readMeta(db) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!has) return { version: 0, applied: [] };
  const get = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
  let applied = [];
  try {
    applied = JSON.parse(get('migrations') ?? '[]');
  } catch {
    // an unreadable list is rebuilt below
  }
  return { version: Number(get('schema_version') ?? 0), applied };
}

/**
 * Bring `db` to the latest schema; returns the names newly recorded by this call.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ddl: string, migrations?: typeof MIGRATIONS}} ctx
 */
export function runMigrations(db, { ddl, migrations = MIGRATIONS }) {
  const latest = migrations[migrations.length - 1].id;
  const refuse = (version) => {
    throw new UnknotError('UK_STATE_CONFLICT', `store schema ${version} is newer than this runtime supports (${latest}); upgrade Unknot`);
  };
  const before = readMeta(db);
  if (before.version > latest) refuse(before.version);
  const done = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read again under the lock: another process may have migrated since.
    const cur = readMeta(db);
    if (cur.version > latest) refuse(cur.version);
    const names = new Set(cur.applied);
    for (const m of migrations) {
      // A store from before names were recorded sits at version 1 with no list: its
      // migrations up to that version are already applied, only the record is missing.
      if (m.id <= cur.version && !names.has(m.name)) names.add(m.name), done.push(m.name);
      if (names.has(m.name) && !m.always) continue;
      m.up(db, { ddl });
      if (!names.has(m.name)) names.add(m.name), done.push(m.name);
    }
    const put = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
    put.run('schema_version', String(latest));
    put.run('migrations', JSON.stringify(migrations.filter((m) => names.has(m.name)).map((m) => m.name)));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return done;
}
