// Lock, rewrite and duration forecasting for DDL (spec §14.7). This is a rule table,
// not a simulator: every rule names the engine documentation it comes from, states the
// version it applies to, and degrades to a conservative, low-confidence answer when the
// engine, version or statement is not understood. "Online" never means "zero impact":
// every ALTER still queues for a metadata/table lock, and replicas replay it.
//
// Confidence model
//   high    engine and version known, statement fully parsed, rule documented
//   medium  rule documented but depends on facts we may not have (old column type,
//           charset, journal mode) or the version is unknown but the rule is stable
//   low     unknown engine/version for a version-sensitive rule, or unrecognised statement

import { parseSql } from './sql/parser.mjs';

const PG_DOCS_LOCKING = 'PostgreSQL docs: Explicit Locking, table-level lock modes';
const PG_DOCS_ALTER = 'PostgreSQL docs: ALTER TABLE (Notes)';
const PG_DOCS_INDEX = 'PostgreSQL docs: CREATE INDEX (Building Indexes Concurrently)';
const MYSQL_DOCS_ONLINE = 'MySQL 8.0 Reference Manual: Online DDL Operations';
const SQLITE_DOCS_ALTER = 'SQLite docs: ALTER TABLE';

const PG_LOCK_ORDER = ['NONE', 'ACCESS SHARE', 'ROW SHARE', 'ROW EXCLUSIVE', 'SHARE UPDATE EXCLUSIVE', 'SHARE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE', 'ACCESS EXCLUSIVE'];
const MY_LOCK_ORDER = ['NONE', 'SHARED', 'EXCLUSIVE'];
const REWRITE_RANK = { none: 0, index: 1, unknown: 2, table: 3 };
const SCAN_RANK = { none: 0, unknown: 1, full: 2 };
const RISK_RANK = { low: 0, medium: 1, high: 2 };
const LAG_RANK = { low: 0, unknown: 1, medium: 2, high: 3 };
const CONF_RANK = { low: 0, medium: 1, high: 2 };

/** Normalise an engine name. */
export function normalizeEngine(engine) {
  const e = String(engine ?? '').toLowerCase();
  if (['postgres', 'postgresql', 'pg', 'psql'].includes(e)) return 'postgresql';
  if (['mysql', 'aurora-mysql'].includes(e)) return 'mysql';
  if (e === 'mariadb') return 'mariadb';
  if (['sqlite', 'sqlite3'].includes(e)) return 'sqlite';
  return 'unknown';
}

/** Parse '16', '9.6', '8.0.32', '10.6.12-MariaDB' into numeric parts; null when absent. */
export function parseVersion(version) {
  if (version === undefined || version === null || version === '') return null;
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version).trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/** version >= want (both part arrays). */
function atLeast(v, want) {
  if (!v) return false;
  for (let i = 0; i < want.length; i++) {
    if ((v[i] ?? 0) > want[i]) return true;
    if ((v[i] ?? 0) < want[i]) return false;
  }
  return true;
}

/** 'large' | 'small' | 'unknown' from whatever size facts the caller has. */
function tableScale(table) {
  const rows = table?.estimated_rows;
  const bytes = table?.size_bytes;
  if ((typeof rows === 'number' && rows >= 1e7) || (typeof bytes === 'number' && bytes >= 1e9)) return 'large';
  if ((typeof rows === 'number' && rows < 1e5) && (typeof bytes !== 'number' || bytes < 1e7)) return 'small';
  if (typeof bytes === 'number' && bytes < 1e7 && typeof rows !== 'number') return 'small';
  return 'unknown';
}

function base(rule_id, over = {}) {
  return {
    lock_mode: 'unknown',
    blocks: { reads: true, writes: true },
    metadata_lock_risk: 'high',
    rewrite: 'unknown',
    scan: 'unknown',
    transactional: false,
    online: false,
    concurrently_available: false,
    duration: 'unknown',
    temporary_disk: 'unknown',
    replication_lag_risk: 'unknown',
    cancellation: 'unknown: treat as non-cancellable once started',
    safer_alternative: null,
    rule_id,
    confidence: 'low',
    notes: [],
    sources: [],
    destructive: false,
    breaks_old_readers: false,
    ...over,
  };
}

function pgBlocks(mode) {
  switch (mode) {
    case 'ACCESS EXCLUSIVE': return { reads: true, writes: true };
    case 'EXCLUSIVE': case 'SHARE ROW EXCLUSIVE': case 'SHARE': return { reads: false, writes: true };
    default: return { reads: false, writes: false };
  }
}

function pgMdlRisk(mode) {
  // ACCESS EXCLUSIVE queues behind every running statement and then blocks all new ones.
  if (mode === 'ACCESS EXCLUSIVE') return 'high';
  if (['SHARE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE'].includes(mode)) return 'medium';
  return 'low';
}

function lagFor({ rewrite, scan, index }, scale) {
  if (rewrite === 'table') return scale === 'small' ? 'medium' : 'high';
  if (rewrite === 'index' || index) return scale === 'small' ? 'low' : 'medium';
  if (scan === 'full') return scale === 'large' ? 'medium' : 'low';
  return 'low';
}

/** Build a PostgreSQL result from a compact rule description. */
function pg(rule_id, d, ctx) {
  const mode = d.lock ?? 'ACCESS EXCLUSIVE';
  const rewrite = d.rewrite ?? 'none';
  const scan = d.scan ?? 'none';
  const metadataOnly = rewrite === 'none' && scan === 'none' && !d.index_build;
  const r = base(rule_id, {
    lock_mode: mode,
    blocks: pgBlocks(mode),
    metadata_lock_risk: pgMdlRisk(mode),
    rewrite,
    scan,
    transactional: d.transactional ?? true,
    online: mode === 'SHARE UPDATE EXCLUSIVE' || mode === 'ROW EXCLUSIVE' || mode === 'NONE' || mode === 'ACCESS SHARE',
    concurrently_available: d.concurrently_available ?? false,
    duration: d.duration ?? (metadataOnly ? 'constant' : 'proportional_to_table'),
    temporary_disk: d.temporary_disk ?? (rewrite === 'table' ? 'table_size' : (rewrite === 'index' || d.index_build) ? 'index_size' : 'none'),
    replication_lag_risk: d.lag ?? lagFor({ rewrite, scan, index: d.index_build }, ctx.scale),
    cancellation: d.cancellation ?? (d.transactional === false
      ? 'cancel is safe for data but may leave partial objects that need cleanup'
      : 'safe: cancel or lock_timeout aborts and rolls back with no partial state'),
    safer_alternative: d.safer ?? null,
    confidence: d.confidence ?? (ctx.version ? 'high' : 'medium'),
    notes: [...(d.notes ?? [])],
    sources: d.sources ?? [PG_DOCS_LOCKING, PG_DOCS_ALTER],
    destructive: Boolean(d.destructive),
    breaks_old_readers: Boolean(d.breaks_old_readers),
  });
  if (d.version_sensitive && !ctx.version) {
    r.confidence = 'low';
    r.notes.push('PostgreSQL version unknown; this rule differs by major version, so the conservative branch was chosen');
  }
  if (mode === 'ACCESS EXCLUSIVE') {
    r.notes.push('Takes ACCESS EXCLUSIVE: even a fast change queues behind running transactions and then blocks every query on the table behind it; set lock_timeout and retry');
  }
  return r;
}

// ------------------------------------------------------------------ PostgreSQL types

function normType(t) {
  const s = String(t ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  const m = /^([a-z_ ]+?)\s*(?:\(([^)]*)\))?(\[\])?$/.exec(s);
  if (!m) return { base: s, args: [], array: false };
  const alias = {
    'character varying': 'varchar', varchar: 'varchar', character: 'char', char: 'char', bpchar: 'char',
    int: 'int4', integer: 'int4', int4: 'int4', bigint: 'int8', int8: 'int8', smallint: 'int2', int2: 'int2',
    decimal: 'numeric', numeric: 'numeric', 'timestamp with time zone': 'timestamptz', timestamptz: 'timestamptz',
    'timestamp without time zone': 'timestamp', timestamp: 'timestamp', 'double precision': 'float8', float8: 'float8',
    real: 'float4', float4: 'float4', bool: 'boolean', boolean: 'boolean',
  };
  const b = m[1].trim();
  return { base: alias[b] ?? b, args: m[2] ? m[2].split(',').map((x) => Number(x.trim())) : [], array: Boolean(m[3]) };
}

/**
 * Does ALTER COLUMN TYPE old->new rewrite the table on PostgreSQL?
 * Binary-coercible cases skip the rewrite (PostgreSQL docs, ALTER TABLE: "Notes";
 * varchar/numeric limits since 9.2). Returns 'none' | 'table' | 'unknown'.
 */
export function pgTypeChangeRewrite(oldType, newType) {
  if (!oldType) return 'unknown';
  const o = normType(oldType);
  const n = normType(newType);
  if (o.array !== n.array) return 'table';
  if (o.base === n.base && JSON.stringify(o.args) === JSON.stringify(n.args)) return 'none';
  if (o.base === 'varchar' && n.base === 'text') return 'none';
  if (o.base === 'varchar' && n.base === 'varchar') {
    if (!n.args.length) return 'none';
    if (o.args.length && n.args[0] >= o.args[0]) return 'none';
    return 'table';
  }
  if (o.base === 'numeric' && n.base === 'numeric') {
    if (!n.args.length) return 'none';
    const [op, os = 0] = o.args;
    const [np, ns = 0] = n.args;
    if (o.args.length && os === ns && np >= op) return 'none';
    return 'table';
  }
  if (o.base === 'timestamp' && n.base === 'timestamptz') return 'table'; // rewrite unless UTC on PG >= 12; see note
  return 'table';
}

// ------------------------------------------------------------------ PostgreSQL rules

function pgAction(a, st, ctx) {
  const { version: v } = ctx;
  const ge = (n) => atLeast(v, [n]);
  switch (a.action) {
    case 'add_column': {
      const col = a.column;
      const parts = [];
      let main;
      if (col.generated?.stored) {
        // PostgreSQL docs, ALTER TABLE: a STORED generated column must be computed for every row.
        main = pg('pg.add_column.generated_stored', { rewrite: 'table', scan: 'full', safer: 'add a plain nullable column, backfill in batches, then add the application-level or trigger-maintained value', version_sensitive: false, notes: ['STORED generated columns are computed for every existing row (PostgreSQL 12+)'] }, ctx);
      } else if (col.identity) {
        // PostgreSQL docs, ALTER TABLE: adding an identity/serial column rewrites the table.
        main = pg('pg.add_column.identity', { rewrite: 'table', scan: 'full', safer: 'add a nullable integer column, backfill with batched UPDATEs using a sequence, then add NOT NULL via a validated CHECK', notes: [col.identity === 'serial' ? 'serial/bigserial implies DEFAULT nextval(), a volatile default' : 'identity columns assign a sequence value to every existing row'] }, ctx);
      } else if (!col.default || col.default.kind === 'null') {
        // PostgreSQL docs, ALTER TABLE: ADD COLUMN without default only updates the catalog.
        const notes = col.nullable ? [] : ['NOT NULL without a DEFAULT fails if the table already has rows'];
        main = pg('pg.add_column.no_default', { notes }, ctx);
      } else if (col.default.volatile) {
        // PostgreSQL docs, ALTER TABLE Notes: a volatile DEFAULT (e.g. clock_timestamp()) forces a rewrite.
        main = pg('pg.add_column.volatile_default', { rewrite: 'table', scan: 'full', safer: 'ADD COLUMN without default, set DEFAULT separately (applies to new rows only), backfill existing rows in batches', notes: [`DEFAULT ${col.default.expr} is volatile so every existing row is rewritten`] }, ctx);
      } else if (ge(11)) {
        // PostgreSQL 11 release notes: ADD COLUMN with a non-volatile DEFAULT is metadata-only ("fast default").
        const notes = col.default.stable_function ? ['stable function default (now(), CURRENT_TIMESTAMP) is evaluated once at ALTER time and stored; existing rows all get that single value'] : [];
        main = pg('pg.add_column.const_default', { notes }, ctx);
      } else {
        // Before PostgreSQL 11 any DEFAULT on ADD COLUMN rewrites the table.
        main = pg('pg.add_column.default_pre11', { rewrite: 'table', scan: 'full', version_sensitive: true, safer: 'ADD COLUMN without default, SET DEFAULT, backfill in batches (or upgrade to PostgreSQL 11+)', notes: ['PostgreSQL < 11 rewrites the table when ADD COLUMN has a DEFAULT'] }, ctx);
      }
      parts.push(main);
      for (const k of col.constraints ?? []) parts.push(pgConstraintAdd(k, ctx, st));
      return combine(parts);
    }
    case 'drop_column':
      return pg('pg.drop_column', {
        destructive: true, breaks_old_readers: true,
        safer: 'expand/contract: stop all reads and writes of the column in a prior release, then drop; keep a backup of the column data until the recovery window expires',
        notes: ['catalog-only: space is not reclaimed until a later rewrite', 'drops indexes and constraints that include the column; dependent views fail without CASCADE'],
      }, ctx);
    case 'rename_column':
      return pg('pg.rename_column', {
        breaks_old_readers: true,
        safer: 'add the new column, dual-write, backfill, switch reads, then drop the old column (expand/contract)',
        notes: ['metadata-only but instantly breaks every old reader and writer of the old name'],
      }, ctx);
    case 'rename_table':
      return pg('pg.rename_table', {
        breaks_old_readers: true,
        safer: 'create a compatibility view with the old name, or expand/contract with a new table',
        notes: ['metadata-only but instantly breaks every old reader and writer of the old name'],
      }, ctx);
    case 'alter_column_type': {
      const known = ctx.columnType(a.column);
      let rw = a.using && a.using.trim().toLowerCase() !== a.column ? 'table' : pgTypeChangeRewrite(known, a.type);
      const notes = [];
      let confidence;
      if (rw === 'unknown') {
        rw = 'table';
        confidence = 'medium';
        notes.push('current column type unknown; assumed rewrite. varchar(n)->varchar(m>n), varchar->text and numeric precision increases avoid it');
      }
      if (known && normType(known).base === 'timestamp' && normType(a.type).base === 'timestamptz') {
        notes.push('timestamp -> timestamptz skips the rewrite on PostgreSQL 12+ only when the session TimeZone is UTC');
      }
      const indexed = ctx.indexedColumn(a.column);
      if (rw === 'table' && indexed) notes.push(`column ${a.column} is indexed: every index on it is rebuilt during the rewrite`);
      if (rw === 'none') {
        // PostgreSQL docs, ALTER TABLE Notes: binary-coercible changes skip rewrite and scan.
        return pg('pg.alter_type.binary_coercible', { notes: [...notes, 'binary-coercible: no table rewrite, no scan'], confidence }, ctx);
      }
      return pg('pg.alter_type.rewrite', {
        rewrite: 'table', scan: 'full', notes, confidence,
        temporary_disk: 'table_size',
        safer: 'expand/contract: add a new column of the target type, dual-write, backfill in batches, switch reads, drop the old column',
      }, ctx);
    }
    case 'set_not_null': {
      if (ge(12) && ctx.table.has_valid_not_null_check) {
        // PostgreSQL 12 release notes: SET NOT NULL skips the scan when a valid CHECK (col IS NOT NULL) proves it.
        return pg('pg.set_not_null.check_proven', { notes: ['PostgreSQL 12+ uses the existing valid CHECK (col IS NOT NULL) to skip the table scan'] }, ctx);
      }
      return pg('pg.set_not_null.scan', {
        scan: 'full', version_sensitive: !v,
        safer: ge(12) || !v
          ? `ALTER TABLE ... ADD CONSTRAINT ${a.column}_not_null CHECK (${a.column} IS NOT NULL) NOT VALID; ALTER TABLE ... VALIDATE CONSTRAINT ...; then SET NOT NULL (PostgreSQL 12+ skips the scan), then drop the CHECK`
          : 'schedule in a low-traffic window; PostgreSQL < 12 cannot skip the scan',
        notes: ['scans the whole table under ACCESS EXCLUSIVE to prove no NULLs exist'],
      }, ctx);
    }
    case 'drop_not_null': return pg('pg.drop_not_null', {}, ctx);
    case 'set_default': case 'drop_default': return pg('pg.alter_default', { notes: ['affects only rows written afterwards'] }, ctx);
    case 'add_constraint': return pgConstraintAdd(a.constraint, ctx, st);
    case 'validate_constraint':
      // PostgreSQL docs, ALTER TABLE: VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE.
      return pg('pg.validate_constraint', {
        lock: 'SHARE UPDATE EXCLUSIVE', scan: 'full',
        notes: ['reads and writes continue during the scan; concurrent DDL and VACUUM wait', 'a validating foreign key also takes ROW SHARE on the referenced table'],
      }, ctx);
    case 'drop_constraint':
      return pg('pg.drop_constraint', { notes: ['dropping a PRIMARY KEY/UNIQUE constraint drops its index; a foreign key drop also locks the referenced table'], breaks_old_readers: false }, ctx);
    case 'set_tablespace':
      return pg('pg.set_tablespace', { rewrite: 'table', scan: 'full', temporary_disk: 'table_size', notes: ['physically copies the relation files'], safer: 'pg_repack or logical migration to a new table in the target tablespace' }, ctx);
    case 'set_logged': case 'set_unlogged':
      // PostgreSQL docs, ALTER TABLE: SET LOGGED/UNLOGGED rewrites the table.
      return pg('pg.set_logged', { rewrite: 'table', scan: 'full', temporary_disk: 'table_size', lag: 'high', notes: [a.action === 'set_logged' ? 'SET LOGGED writes the whole table to WAL, which replicas must replay' : 'unlogged tables are not replicated and are truncated on crash recovery'] }, ctx);
    case 'attach_partition':
      return pg('pg.attach_partition', {
        lock: atLeast(v, [12]) ? 'SHARE UPDATE EXCLUSIVE' : 'ACCESS EXCLUSIVE',
        scan: 'full', version_sensitive: !v,
        notes: ['ACCESS EXCLUSIVE on the partition being attached', 'the partition is scanned to validate bounds unless a matching valid CHECK constraint already exists'],
        safer: 'first ADD CONSTRAINT ... CHECK (bounds) NOT VALID and VALIDATE it on the new partition so ATTACH can skip the scan',
      }, ctx);
    case 'detach_partition': {
      if (a.concurrently) {
        // PostgreSQL 14 release notes: DETACH PARTITION CONCURRENTLY.
        if (!ge(14)) {
          return pg('pg.detach_partition.concurrently_unavailable', { version_sensitive: true, transactional: false, notes: [v ? 'DETACH PARTITION CONCURRENTLY requires PostgreSQL 14+; this version rejects the syntax' : 'requires PostgreSQL 14+'] }, ctx);
        }
        return pg('pg.detach_partition.concurrently', { lock: 'SHARE UPDATE EXCLUSIVE', transactional: false, concurrently_available: true, notes: ['cannot run inside a transaction block', 'cannot be used when a default partition exists', 'if cancelled, finish with DETACH PARTITION ... FINALIZE'] }, ctx);
      }
      return pg('pg.detach_partition', { concurrently_available: ge(14), safer: ge(14) ? 'DETACH PARTITION ... CONCURRENTLY' : null, notes: ['ACCESS EXCLUSIVE on the parent blocks all queries on the partitioned table'] }, ctx);
    }
    case 'row_level_security': case 'owner_to': case 'set_schema':
      return pg(`pg.${a.action}`, { notes: a.action === 'row_level_security' ? ['enabling RLS with no policy denies all non-owner access immediately'] : [] , breaks_old_readers: a.action === 'set_schema' }, ctx);
    default:
      return pg('pg.alter.other', { rewrite: 'unknown', scan: 'unknown', duration: 'unknown', confidence: 'low', notes: [`unrecognised ALTER TABLE action: ${a.text}`] }, ctx);
  }
}

function pgConstraintAdd(k, ctx) {
  switch (k.kind) {
    case 'check':
      if (k.not_valid) {
        // PostgreSQL docs, ALTER TABLE: NOT VALID skips the scan; new writes are checked immediately.
        return pg('pg.add_check.not_valid', { notes: ['existing rows are not checked until VALIDATE CONSTRAINT'], safer: null }, ctx);
      }
      return pg('pg.add_check.scan', { scan: 'full', safer: 'ADD CONSTRAINT ... CHECK (...) NOT VALID, then VALIDATE CONSTRAINT (SHARE UPDATE EXCLUSIVE, writes continue)', notes: ['full scan under ACCESS EXCLUSIVE'] }, ctx);
    case 'foreign_key':
      if (k.not_valid) {
        return pg('pg.add_fk.not_valid', { lock: 'SHARE ROW EXCLUSIVE', notes: ['SHARE ROW EXCLUSIVE on both the table and the referenced table, but no scan', 'new writes are enforced immediately; existing rows only after VALIDATE CONSTRAINT'], safer: null }, ctx);
      }
      return pg('pg.add_fk.scan', { lock: 'SHARE ROW EXCLUSIVE', scan: 'full', safer: 'ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID, then VALIDATE CONSTRAINT', notes: ['SHARE ROW EXCLUSIVE on both tables for the duration of the validating scan; writes to both are blocked'] }, ctx);
    case 'primary_key': case 'unique': case 'exclude': {
      if (k.using_index) {
        // PostgreSQL docs, ALTER TABLE: ADD ... USING INDEX adopts an existing index with no build.
        return pg('pg.add_unique.using_index', { notes: ['adopts a pre-built index; the constraint is metadata-only'] , safer: null }, ctx);
      }
      return pg('pg.add_unique.build_index', {
        rewrite: 'index', scan: 'full', index_build: true,
        safer: 'CREATE UNIQUE INDEX CONCURRENTLY ..., then ALTER TABLE ... ADD CONSTRAINT ... USING INDEX ...',
        notes: ['builds the backing index while holding ACCESS EXCLUSIVE', ...(k.kind === 'primary_key' ? ['PRIMARY KEY also requires NOT NULL; columns without it are scanned'] : [])],
      }, ctx);
    }
    default:
      return pg('pg.add_constraint.other', { scan: 'unknown', confidence: 'low' }, ctx);
  }
}

function pgStatement(st, ctx) {
  const { version: v } = ctx;
  const ge = (n) => atLeast(v, [n]);
  switch (st.kind) {
    case 'alter_table': {
      if (!st.actions.length) return pg('pg.alter_table.empty', { lock: 'NONE', confidence: 'medium' }, ctx);
      return combine(st.actions.map((a) => pgAction(a, st, ctx)));
    }
    case 'create_table': {
      const fk = st.constraints.some((k) => k.kind === 'foreign_key');
      return pg('pg.create_table', { lock: fk ? 'SHARE ROW EXCLUSIVE' : 'NONE', notes: fk ? ['SHARE ROW EXCLUSIVE is taken on each referenced table'] : [], duration: st.as_select ? 'proportional_to_table' : 'constant', scan: st.as_select ? 'full' : 'none' }, ctx);
    }
    case 'create_index': {
      if (st.concurrently) {
        // PostgreSQL docs, CREATE INDEX "Building Indexes Concurrently": SHARE UPDATE EXCLUSIVE, two scans, may leave INVALID index.
        const notes = ['two table scans and waits for every transaction that could see the old snapshot; slower and more I/O than a plain build', 'cannot run inside a transaction block', 'if it fails or is cancelled an INVALID index remains and must be dropped and retried'];
        if (ctx.table.partitioned) notes.push('CREATE INDEX CONCURRENTLY is not supported on a partitioned table: build on each partition, then attach');
        if (st.unique) notes.push('a failed concurrent unique build leaves an INVALID index that still enforces uniqueness for new writes');
        return pg('pg.create_index.concurrently', { lock: 'SHARE UPDATE EXCLUSIVE', scan: 'full', index_build: true, rewrite: 'index', transactional: false, concurrently_available: true, sources: [PG_DOCS_LOCKING, PG_DOCS_INDEX], notes, cancellation: 'safe for data, but leaves an INVALID index that must be dropped before retrying' }, ctx);
      }
      return pg('pg.create_index', {
        lock: 'SHARE', scan: 'full', index_build: true, rewrite: 'index', concurrently_available: true,
        sources: [PG_DOCS_LOCKING, PG_DOCS_INDEX],
        safer: 'CREATE INDEX CONCURRENTLY (outside a transaction block)',
        notes: ['SHARE lock blocks INSERT/UPDATE/DELETE for the whole build'],
      }, ctx);
    }
    case 'drop_index': {
      if (st.concurrently) {
        return pg('pg.drop_index.concurrently', { lock: 'SHARE UPDATE EXCLUSIVE', transactional: false, concurrently_available: true, notes: ['cannot run in a transaction block, drops only one index, and cannot drop an index that backs a constraint'] }, ctx);
      }
      return pg('pg.drop_index', { safer: 'DROP INDEX CONCURRENTLY', concurrently_available: true, destructive: true, notes: ['ACCESS EXCLUSIVE on the table; fast but queued behind running queries', 'queries relying on the index fall back to slower plans immediately'] }, ctx);
    }
    case 'reindex': {
      if (st.concurrently) {
        // PostgreSQL 12 release notes: REINDEX CONCURRENTLY.
        if (!ge(12)) {
          return pg('pg.reindex.concurrently_unavailable', { version_sensitive: true, transactional: false, rewrite: 'index', notes: ['REINDEX CONCURRENTLY requires PostgreSQL 12+'] }, ctx);
        }
        return pg('pg.reindex.concurrently', { lock: 'SHARE UPDATE EXCLUSIVE', rewrite: 'index', scan: 'full', index_build: true, transactional: false, concurrently_available: true, notes: ['cannot run inside a transaction block; a failure can leave an INVALID _ccnew index to drop'] }, ctx);
      }
      return pg('pg.reindex', {
        lock: 'SHARE', rewrite: 'index', scan: 'full', index_build: true, concurrently_available: ge(12),
        safer: ge(12) ? 'REINDEX ... CONCURRENTLY' : 'rebuild with CREATE INDEX CONCURRENTLY under a new name, then swap',
        version_sensitive: false,
        notes: ['SHARE lock on the table blocks writes', 'ACCESS EXCLUSIVE on the index being rebuilt blocks reads that would use it'],
      }, ctx);
    }
    case 'create_view': {
      if (st.materialized && !st.with_no_data) return pg('pg.create_matview', { lock: 'NONE', scan: 'full', rewrite: 'none', duration: 'proportional_to_table', notes: ['populates the view by running its query'], temporary_disk: 'table_size' }, ctx);
      return pg('pg.create_view', { lock: 'NONE', notes: [] }, ctx);
    }
    case 'refresh_matview': {
      if (st.concurrently) {
        // PostgreSQL docs, REFRESH MATERIALIZED VIEW: CONCURRENTLY needs a UNIQUE index and takes EXCLUSIVE.
        return pg('pg.refresh_matview.concurrently', { lock: 'EXCLUSIVE', scan: 'full', rewrite: 'none', duration: 'proportional_to_table', temporary_disk: 'table_size', concurrently_available: true, notes: ['requires a UNIQUE index covering all rows on the materialized view', 'EXCLUSIVE blocks writes to the view but not reads; computes a diff, so it is slower than a plain refresh'] }, ctx);
      }
      return pg('pg.refresh_matview', { rewrite: 'table', scan: 'full', temporary_disk: 'table_size', concurrently_available: true, safer: 'REFRESH MATERIALIZED VIEW CONCURRENTLY (needs a unique index)', notes: ['ACCESS EXCLUSIVE blocks all reads of the view while it is rebuilt'] }, ctx);
    }
    case 'drop_view': return pg('pg.drop_view', { destructive: true, breaks_old_readers: true }, ctx);
    case 'create_trigger': return pg('pg.create_trigger', { lock: 'SHARE ROW EXCLUSIVE', notes: ['blocks writes briefly; trigger runs on every affected row afterwards'] }, ctx);
    case 'drop_trigger': return pg('pg.drop_trigger', { breaks_old_readers: false }, ctx);
    case 'create_function': case 'create_type': case 'create_sequence': case 'create_schema': case 'create_extension': case 'create_role':
      return pg(`pg.${st.kind}`, { lock: 'NONE', notes: [] }, ctx);
    case 'drop_function': case 'drop_type': case 'drop_sequence': case 'drop_schema': case 'drop_other':
      return pg(`pg.${st.kind}`, { lock: 'ACCESS EXCLUSIVE', destructive: true, breaks_old_readers: true }, ctx);
    case 'alter_type': {
      if (st.action === 'add_value') {
        // PostgreSQL docs, ALTER TYPE: before 12 ADD VALUE cannot run inside a transaction block.
        const old = v ? !ge(12) : true;
        return pg('pg.alter_type.add_value', {
          lock: 'NONE', transactional: !old, version_sensitive: !v,
          notes: old ? ['PostgreSQL < 12: ALTER TYPE ... ADD VALUE cannot run inside a transaction block'] : ['PostgreSQL 12+: allowed in a transaction, but the new value cannot be used until the transaction commits'],
          safer: old ? 'run it as its own non-transactional migration step' : null,
        }, ctx);
      }
      return pg('pg.alter_type.other', { lock: 'ACCESS EXCLUSIVE', breaks_old_readers: st.action === 'rename_value' || st.action === 'rename' }, ctx);
    }
    case 'drop_table': return pg('pg.drop_table', { destructive: true, breaks_old_readers: true, safer: 'rename the table out of the way, wait a full release cycle and backup window, then drop', notes: ['irreversible without a backup; waits for and then blocks all concurrent queries'] }, ctx);
    case 'truncate': return pg('pg.truncate', { destructive: true, notes: ['removes all rows immediately; not MVCC-safe for concurrent snapshots', st.cascade ? 'CASCADE also truncates every table that references it' : 'fails if referenced by foreign keys without CASCADE'] , safer: 'DELETE in bounded batches if rows must be recoverable inside a transaction window' }, ctx);
    case 'vacuum': {
      if (st.full) {
        return pg('pg.vacuum_full', { rewrite: 'table', scan: 'full', transactional: false, temporary_disk: 'table_size', safer: 'pg_repack (extension) or plain VACUUM; schedule VACUUM FULL only in a maintenance window', notes: ['rewrites the table under ACCESS EXCLUSIVE', 'cannot run inside a transaction block'] }, ctx);
      }
      return pg('pg.vacuum', { lock: 'SHARE UPDATE EXCLUSIVE', scan: 'full', transactional: false, rewrite: 'none', duration: 'proportional_to_table' }, ctx);
    }
    case 'cluster': return pg('pg.cluster', { rewrite: 'table', scan: 'full', temporary_disk: 'table_size', safer: 'pg_repack (extension) to reorder without a long ACCESS EXCLUSIVE lock', notes: ['rewrites the table and all its indexes under ACCESS EXCLUSIVE'] }, ctx);
    case 'grant': case 'revoke':
      return pg(`pg.${st.kind}`, { lock: 'NONE', breaks_old_readers: st.kind === 'revoke', notes: st.kind === 'revoke' ? ['REVOKE takes effect immediately for new statements'] : [] }, ctx);
    case 'create_policy':
      // Conservative: policy creation locks the table; exact level not verified for every release.
      return pg('pg.create_policy', { confidence: 'medium', notes: ['row-level security policies change visible rows for every non-owner immediately'] }, ctx);
    case 'drop_policy': return pg('pg.drop_policy', { confidence: 'medium' }, ctx);
    case 'comment': return pg('pg.comment', { lock: 'SHARE UPDATE EXCLUSIVE' }, ctx);
    case 'rename_table': return pg('pg.rename_table', { breaks_old_readers: true }, ctx);
    case 'alter_other': return pg('pg.alter_other', { rewrite: 'unknown', scan: 'unknown', confidence: 'low', notes: [`unmodelled ALTER ${st.object}`] }, ctx);
    default: return null;
  }
}

// ------------------------------------------------------------------ MySQL / MariaDB

const ALG_RANK = { INSTANT: 0, INPLACE: 1, COPY: 2 };

/** Build a MySQL result from an algorithm description. */
function my(rule_id, d, ctx) {
  const algorithm = d.algorithm;
  const lock = d.lock ?? (algorithm === 'COPY' ? 'SHARED' : 'NONE');
  const rebuild = d.rebuild ?? (algorithm === 'COPY');
  const blocks = lock === 'NONE' ? { reads: false, writes: false } : lock === 'SHARED' ? { reads: false, writes: true } : { reads: true, writes: true };
  const heavy = rebuild || d.index_build;
  const r = base(rule_id, {
    lock_mode: lock,
    blocks,
    // Every ALTER (even INSTANT) needs an exclusive metadata lock at start and end, which
    // queues behind any open transaction that touched the table (MySQL manual, Metadata Locking).
    metadata_lock_risk: d.mdl ?? 'high',
    rewrite: rebuild ? 'table' : d.index_build ? 'index' : 'none',
    scan: algorithm === 'INSTANT' ? 'none' : (d.scan ?? (heavy ? 'full' : 'none')),
    transactional: false, // MySQL DDL implicitly commits and is never part of a transaction
    online: algorithm !== 'COPY' && lock === 'NONE',
    concurrently_available: false,
    duration: algorithm === 'INSTANT' || (!heavy && algorithm !== 'COPY') ? 'constant' : 'proportional_to_table',
    temporary_disk: algorithm === 'INSTANT' ? 'none' : rebuild ? 'table_size' : d.index_build ? 'index_size' : 'none',
    replication_lag_risk: d.lag ?? (algorithm === 'INSTANT' ? 'low' : lagFor({ rewrite: rebuild ? 'table' : 'none', scan: heavy ? 'full' : 'none', index: d.index_build }, ctx.scale)),
    cancellation: algorithm === 'INSTANT' ? 'not cancellable but completes in constant time'
      : algorithm === 'COPY' ? 'KILL aborts and discards the temporary table; the original is untouched'
        : 'KILL is possible, but rolling back a large in-place rebuild can itself take long',
    safer_alternative: d.safer ?? null,
    confidence: d.confidence ?? (ctx.version ? 'high' : 'medium'),
    notes: [...(d.notes ?? [])],
    sources: [MYSQL_DOCS_ONLINE],
    destructive: Boolean(d.destructive),
    breaks_old_readers: Boolean(d.breaks_old_readers),
    algorithm,
    explicit_clause: null,
  });
  if (!ctx.version && d.version_sensitive) {
    r.confidence = 'low';
    r.notes.push('server version unknown; INSTANT/INPLACE support differs by release so the conservative algorithm was chosen');
  }
  if (algorithm !== 'COPY') r.notes.push('online DDL still takes a brief exclusive metadata lock and replicas replay the ALTER');
  return r;
}

function mysqlAction(a, st, ctx) {
  const { version: v, engine } = ctx;
  const maria = engine === 'mariadb';
  const instantAny = !maria && atLeast(v, [8, 0, 29]); // MySQL 8.0.29: INSTANT add/drop column at any position
  const instantLast = maria ? atLeast(v, [10, 3, 2]) : atLeast(v, [8, 0, 12]); // 8.0.12: INSTANT add column (last position)
  switch (a.action) {
    case 'add_column': {
      const col = a.column;
      if (col.generated?.stored) return my('my.add_column.stored_generated', { algorithm: 'COPY', notes: ['adding a STORED generated column requires ALGORITHM=COPY'], safer: 'add a regular column and populate it in batches' }, ctx);
      if (col.identity === 'auto_increment') return my('my.add_column.auto_increment', { algorithm: 'INPLACE', rebuild: true, lock: 'SHARED', notes: ['adding an AUTO_INCREMENT column rebuilds the table and does not permit concurrent DML'] }, ctx);
      if (instantAny || (instantLast && !col.position)) {
        return my('my.add_column.instant', { algorithm: 'INSTANT', notes: [instantAny ? 'MySQL 8.0.29+ adds columns instantly at any position' : 'MySQL 8.0.12+ adds columns instantly only as the last column', 'not available for ROW_FORMAT=COMPRESSED tables or tables with a FULLTEXT index; the server then falls back to INPLACE'] , version_sensitive: false }, ctx);
      }
      return my('my.add_column.inplace', { algorithm: 'INPLACE', rebuild: true, version_sensitive: !v, safer: instantLast ? 'append the column at the end so ALGORITHM=INSTANT applies (or upgrade to MySQL 8.0.29+)' : 'upgrade to MySQL 8.0.12+/MariaDB 10.3+ for instant add column, or use pt-online-schema-change/gh-ost', notes: ['in-place table rebuild; concurrent DML is allowed but the rebuild keeps a row log and takes time proportional to the table'] }, ctx);
    }
    case 'drop_column':
      if (instantAny) return my('my.drop_column.instant', { algorithm: 'INSTANT', destructive: true, breaks_old_readers: true, safer: 'expand/contract: retire all readers before dropping', notes: ['MySQL 8.0.29+ drops columns instantly'] }, ctx);
      return my('my.drop_column.inplace', { algorithm: 'INPLACE', rebuild: true, destructive: true, breaks_old_readers: true, version_sensitive: !v, safer: 'expand/contract: retire all readers before dropping', notes: ['rebuilds the table in place; concurrent DML allowed'] }, ctx);
    case 'rename_column':
      if (!maria && atLeast(v, [8, 0, 28])) return my('my.rename_column.instant', { algorithm: 'INSTANT', breaks_old_readers: true }, ctx);
      return my('my.rename_column.inplace', { algorithm: 'INPLACE', rebuild: false, breaks_old_readers: true, version_sensitive: !v, notes: ['in place without rebuild only if the column type is unchanged'] }, ctx);
    case 'rename_table': return my('my.rename_table', { algorithm: 'INPLACE', rebuild: false, breaks_old_readers: true, safer: 'compatibility view with the old name' }, ctx);
    case 'modify_column': case 'change_column': {
      const col = a.column;
      const known = ctx.columnType(a.from ?? col.name);
      const notes = [];
      if (a.action === 'change_column' && a.from !== col.name) notes.push('renames the column; old readers break');
      if (known && normMy(known) === normMy(col.type)) {
        return my('my.modify_column.same_type', { algorithm: 'INPLACE', rebuild: true, notes: [...notes, 'nullability/default change: in-place rebuild (NULL->NOT NULL fails on existing NULLs under strict mode)'], breaks_old_readers: notes.length > 0 }, ctx);
      }
      if (known && varcharWidenInPlace(known, col.type)) {
        return my('my.modify_column.varchar_widen', { algorithm: 'INPLACE', rebuild: false, notes: [...notes, 'VARCHAR growth within the same length-byte class (<=255 bytes or >255 bytes) is in place without rebuild; assumes utf8mb4'], confidence: 'medium' }, ctx);
      }
      return my('my.modify_column.type_change', {
        algorithm: 'COPY', confidence: known ? undefined : 'medium',
        safer: 'expand/contract: add a new column of the target type, backfill in batches, switch reads, drop the old column; or gh-ost/pt-online-schema-change',
        notes: [...notes, known ? 'data type change requires ALGORITHM=COPY, which blocks writes for the whole copy' : 'current column type unknown; assumed a type change (COPY). A pure nullability or default change is INPLACE'],
      }, ctx);
    }
    case 'set_default': case 'drop_default':
      if (atLeast(v, [8, 0, 12]) && !maria) return my('my.alter_default.instant', { algorithm: 'INSTANT' }, ctx);
      return my('my.alter_default.inplace', { algorithm: 'INPLACE', rebuild: false, version_sensitive: !v }, ctx);
    case 'add_index':
      return my(a.fulltext ? 'my.add_fulltext' : 'my.add_index', a.fulltext
        ? { algorithm: 'INPLACE', lock: 'SHARED', index_build: true, notes: ['the first FULLTEXT index rebuilds the table and blocks writes (FTS_DOC_ID column added)'] }
        : { algorithm: 'INPLACE', index_build: true, safer: null, notes: ['secondary index build is in place with LOCK=NONE, but reads the whole table'] }, ctx);
    case 'drop_index': return my('my.drop_index', { algorithm: 'INPLACE', rebuild: false, notes: ['metadata-only; concurrent DML allowed'] }, ctx);
    case 'rename_index': return my('my.rename_index', { algorithm: 'INPLACE', rebuild: false }, ctx);
    case 'add_constraint': {
      const k = a.constraint;
      if (k.kind === 'primary_key') return my('my.add_pk', { algorithm: 'INPLACE', rebuild: true, notes: ['clustered index rebuild; columns must be NOT NULL'] }, ctx);
      if (k.kind === 'unique') return my('my.add_unique', { algorithm: 'INPLACE', index_build: true }, ctx);
      if (k.kind === 'foreign_key') return my('my.add_fk', { algorithm: 'COPY', confidence: 'medium', safer: 'SET foreign_key_checks=0 for the session so ALGORITHM=INPLACE applies, then validate orphans separately', notes: ['with foreign_key_checks=1 adding a foreign key uses ALGORITHM=COPY; with it off, INPLACE (and existing rows are not verified)'] }, ctx);
      if (k.kind === 'check') return my('my.add_check', { algorithm: 'COPY', confidence: 'medium', notes: ['MySQL 8.0.16+ validates existing rows when adding an enforced CHECK; assumed a COPY-class operation'] }, ctx);
      return my('my.add_constraint.other', { algorithm: 'COPY', confidence: 'low' }, ctx);
    }
    case 'drop_constraint':
      if (a.constraint_kind === 'primary_key') return my('my.drop_pk', { algorithm: 'COPY', notes: ['dropping a PRIMARY KEY (without adding a new one in the same statement) rebuilds the table with COPY'] }, ctx);
      return my('my.drop_constraint', { algorithm: 'INPLACE', rebuild: false }, ctx);
    case 'set_engine': case 'convert_charset':
      return my('my.rebuild_copy', { algorithm: 'COPY', notes: ['changing engine or character set copies the table'] }, ctx);
    default:
      return my('my.alter.other', { algorithm: 'COPY', confidence: 'low', notes: [`unrecognised ALTER TABLE action: ${a.text}`] }, ctx);
  }
}

const normMy = (t) => String(t).toLowerCase().replace(/\s+/g, '');

/** VARCHAR(n)->VARCHAR(m) in place when both sit on the same side of the 255-byte boundary (utf8mb4: 63 chars). */
function varcharWidenInPlace(oldT, newT) {
  const o = /^varchar\((\d+)\)/i.exec(oldT);
  const n = /^varchar\((\d+)\)/i.exec(newT);
  if (!o || !n) return false;
  const a = Number(o[1]);
  const b = Number(n[1]);
  if (b < a) return false;
  const cls = (x) => (x <= 63 ? 0 : 1);
  return cls(a) === cls(b);
}

function applyExplicitClause(res, st) {
  const alg = st.algorithm && st.algorithm !== 'DEFAULT' ? st.algorithm : null;
  const lock = st.lock && st.lock !== 'DEFAULT' ? st.lock : null;
  if (!alg && !lock) {
    res.notes.push('no ALGORITHM/LOCK clause: the server may silently pick a more disruptive method; add ALGORITHM=... , LOCK=NONE so an unsupported combination fails fast instead');
    if (res.algorithm !== 'COPY') res.safer_alternative = res.safer_alternative ?? `add ALGORITHM=${res.algorithm}, LOCK=${res.lock_mode === 'NONE' ? 'NONE' : res.lock_mode} so the statement errors instead of degrading`;
    return res;
  }
  res.explicit_clause = 'honoured';
  if (alg && ALG_RANK[alg] !== undefined) {
    if (ALG_RANK[alg] < ALG_RANK[res.algorithm]) {
      res.explicit_clause = 'rejected';
      res.notes.push(`explicit ALGORITHM=${alg} is incompatible with this operation (needs ${res.algorithm}); the server rejects it with an error and changes nothing`);
      res.safer_alternative = res.safer_alternative ?? 'use an expand/contract sequence or an external online schema change tool (gh-ost, pt-online-schema-change)';
    } else if (ALG_RANK[alg] > ALG_RANK[res.algorithm]) {
      res.explicit_clause = 'overridden';
      res.notes.push(`explicit ALGORITHM=${alg} forces a slower method than the server would have chosen`);
      res.algorithm = alg;
      if (alg === 'COPY') { res.rewrite = 'table'; res.scan = 'full'; res.temporary_disk = 'table_size'; res.duration = 'proportional_to_table'; res.lock_mode = 'SHARED'; res.blocks = { reads: false, writes: true }; res.online = false; res.replication_lag_risk = 'high'; }
      if (alg === 'INPLACE' && res.rewrite === 'none' && /add_column|drop_column/.test(res.rule_id)) { res.rewrite = 'table'; res.temporary_disk = 'table_size'; res.duration = 'proportional_to_table'; res.replication_lag_risk = 'medium'; }
    }
  }
  if (lock) {
    const need = MY_LOCK_ORDER.indexOf(res.lock_mode);
    const asked = MY_LOCK_ORDER.indexOf(lock);
    if (asked >= 0 && asked < need) {
      res.explicit_clause = 'rejected';
      res.notes.push(`explicit LOCK=${lock} is incompatible: this operation needs LOCK=${res.lock_mode}; the server rejects the statement`);
    } else if (asked > need && asked >= 0) {
      res.notes.push(`explicit LOCK=${lock} is stricter than needed and blocks ${lock === 'SHARED' ? 'writes' : 'reads and writes'}`);
      res.lock_mode = lock;
      res.blocks = lock === 'SHARED' ? { reads: false, writes: true } : { reads: true, writes: true };
      res.online = false;
    }
  }
  return res;
}

function mysqlStatement(st, ctx) {
  switch (st.kind) {
    case 'alter_table': {
      if (!st.actions.length) return applyExplicitClause(my('my.alter_table.options_only', { algorithm: 'INSTANT', confidence: 'medium' }, ctx), st);
      const r = combine(st.actions.map((a) => mysqlAction(a, st, ctx)));
      r.algorithm = st.actions.map((a) => mysqlAction(a, st, ctx).algorithm).reduce((x, y) => (ALG_RANK[x] >= ALG_RANK[y] ? x : y));
      return applyExplicitClause(r, st);
    }
    case 'create_index': {
      const r = mysqlAction({ action: 'add_index', fulltext: st.fulltext, text: st.text }, st, ctx);
      if (st.unique) r.rule_id = 'my.add_unique';
      return applyExplicitClause(r, st);
    }
    case 'drop_index': return applyExplicitClause(mysqlAction({ action: 'drop_index' }, st, ctx), st);
    case 'create_table': return my('my.create_table', { algorithm: 'INSTANT', lock: 'NONE', mdl: 'low', notes: ['no existing data affected; DDL implicitly commits'] }, ctx);
    case 'drop_table': return my('my.drop_table', { algorithm: 'COPY', rebuild: false, lock: 'EXCLUSIVE', destructive: true, breaks_old_readers: true, duration: 'constant', scan: 'none', notes: ['DROP TABLE needs an exclusive metadata lock and implicitly commits; irreversible without a backup'], safer: 'rename the table out of the way and drop after the backup window' }, ctx);
    case 'truncate': return my('my.truncate', { algorithm: 'COPY', rebuild: false, lock: 'EXCLUSIVE', destructive: true, duration: 'constant', notes: ['TRUNCATE is DDL: it drops and recreates the table, implicitly commits and cannot be rolled back'] }, ctx);
    case 'rename_table': return my('my.rename_table', { algorithm: 'INPLACE', rebuild: false, breaks_old_readers: true }, ctx);
    case 'create_view': case 'create_trigger': case 'create_function': case 'create_type': case 'create_sequence': case 'create_schema': case 'create_role':
      return my(`my.${st.kind}`, { algorithm: 'INSTANT', lock: 'NONE', mdl: 'medium', confidence: 'medium' }, ctx);
    case 'drop_view': case 'drop_trigger': case 'drop_function': case 'drop_schema': case 'drop_other':
      return my(`my.${st.kind}`, { algorithm: 'INSTANT', lock: 'NONE', mdl: 'medium', destructive: true, breaks_old_readers: true, confidence: 'medium' }, ctx);
    case 'grant': case 'revoke': return my(`my.${st.kind}`, { algorithm: 'INSTANT', lock: 'NONE', mdl: 'low', breaks_old_readers: st.kind === 'revoke' }, ctx);
    case 'comment': case 'vacuum': case 'cluster': case 'reindex': case 'refresh_matview': case 'alter_type': case 'create_policy': case 'drop_policy':
      return base(`my.unsupported.${st.kind}`, { confidence: 'low', notes: [`${st.kind} is not a MySQL/MariaDB statement`] });
    default: return null;
  }
}

// ------------------------------------------------------------------ SQLite

function sq(rule_id, d, ctx) {
  const rewrite = d.rewrite ?? 'none';
  return base(rule_id, {
    lock_mode: d.lock ?? 'EXCLUSIVE',
    // A SQLite writer holds the database-wide write lock; readers continue in WAL mode but
    // are blocked at commit in rollback-journal mode.
    blocks: { reads: Boolean(d.blocks_reads), writes: true },
    metadata_lock_risk: 'medium',
    rewrite,
    scan: d.scan ?? (rewrite !== 'none' ? 'full' : 'none'),
    transactional: true,
    online: false,
    duration: rewrite === 'none' && !d.index_build ? 'constant' : 'proportional_to_table',
    temporary_disk: rewrite === 'table' ? 'table_size' : d.index_build ? 'index_size' : 'none',
    replication_lag_risk: 'low',
    cancellation: 'safe: the transaction rolls back (journal or WAL)',
    safer_alternative: d.safer ?? null,
    confidence: d.confidence ?? (ctx.version ? 'high' : 'medium'),
    notes: [...(d.notes ?? []), 'single-writer database: all writers wait for the write lock; readers are unaffected only in WAL mode'],
    sources: [SQLITE_DOCS_ALTER],
    destructive: Boolean(d.destructive),
    breaks_old_readers: Boolean(d.breaks_old_readers),
  });
}

const SQLITE_REBUILD = 'SQLite ALTER TABLE cannot do this directly: use the documented 12-step procedure (create new table, copy rows, drop old, rename) inside one transaction with foreign_keys=OFF';

function sqliteStatement(st, ctx) {
  const { version: v } = ctx;
  switch (st.kind) {
    case 'alter_table': {
      const rs = st.actions.map((a) => {
        switch (a.action) {
          case 'add_column': {
            const c = a.column;
            const notes = [];
            if (!c.nullable && (!c.default || c.default.kind === 'null')) notes.push('NOT NULL columns must have a non-NULL DEFAULT');
            if (c.constraints.some((k) => k.kind === 'primary_key' || k.kind === 'unique')) notes.push('ADD COLUMN cannot add PRIMARY KEY or UNIQUE columns');
            if (c.generated?.stored) notes.push('ADD COLUMN cannot add STORED generated columns');
            if (c.default && c.default.kind !== 'literal' && c.default.kind !== 'null') notes.push('DEFAULT must be a constant (not CURRENT_TIMESTAMP or an expression)');
            return sq('sqlite.add_column', { notes }, ctx);
          }
          case 'rename_column': return sq('sqlite.rename_column', { breaks_old_readers: true, confidence: atLeast(v, [3, 25]) || !v ? undefined : 'medium', notes: atLeast(v, [3, 25]) ? [] : ['RENAME COLUMN requires SQLite 3.25+'] }, ctx);
          case 'rename_table': return sq('sqlite.rename_table', { breaks_old_readers: true }, ctx);
          case 'drop_column':
            return sq('sqlite.drop_column', { rewrite: 'table', destructive: true, breaks_old_readers: true, notes: ['DROP COLUMN requires SQLite 3.35+ and rewrites the table content; fails if the column is indexed, in a constraint, or a key'] , confidence: atLeast(v, [3, 35]) ? undefined : v ? 'medium' : 'low' }, ctx);
          default:
            return sq('sqlite.alter.needs_rebuild', { rewrite: 'table', safer: SQLITE_REBUILD, notes: ['no native ALTER COLUMN / ADD CONSTRAINT: requires a table rebuild'], confidence: 'medium' }, ctx);
        }
      });
      return rs.length ? combine(rs) : null;
    }
    case 'create_index': return sq('sqlite.create_index', { rewrite: 'index', index_build: true, notes: ['blocks writers while the index is built'] }, ctx);
    case 'drop_index': return sq('sqlite.drop_index', { destructive: true }, ctx);
    case 'create_table': return sq('sqlite.create_table', { lock: 'EXCLUSIVE' }, ctx);
    case 'drop_table': return sq('sqlite.drop_table', { destructive: true, breaks_old_readers: true }, ctx);
    case 'truncate': return sq('sqlite.truncate', { confidence: 'low', notes: ['SQLite has no TRUNCATE; use DELETE FROM'] }, ctx);
    case 'create_view': case 'create_trigger': return sq(`sqlite.${st.kind}`, {}, ctx);
    case 'drop_view': case 'drop_trigger': return sq(`sqlite.${st.kind}`, { destructive: true }, ctx);
    case 'vacuum': return sq('sqlite.vacuum', { rewrite: 'table', blocks_reads: true, notes: ['VACUUM rebuilds the whole database file and needs up to 2x free disk'], temporary_disk: 'table_size' }, ctx);
    case 'reindex': return sq('sqlite.reindex', { rewrite: 'index', index_build: true }, ctx);
    default: return null;
  }
}

// ------------------------------------------------------------------ shared: DML & combining

function dmlForecast(st, ctx) {
  const { engine } = ctx;
  const known = engine !== 'unknown';
  const rowLock = engine === 'postgresql' ? 'ROW EXCLUSIVE' : engine === 'sqlite' ? 'EXCLUSIVE' : 'NONE';
  if (st.kind === 'select') {
    return base(`${engine}.select`, {
      lock_mode: engine === 'postgresql' ? 'ACCESS SHARE' : 'NONE', blocks: { reads: false, writes: false }, metadata_lock_risk: 'low',
      rewrite: 'none', scan: 'unknown', transactional: true, online: true, duration: 'unknown', temporary_disk: 'unknown',
      replication_lag_risk: 'low', cancellation: 'safe: cancel aborts the statement', confidence: known ? 'medium' : 'low', sources: [PG_DOCS_LOCKING],
    });
  }
  const full = (st.kind === 'update' || st.kind === 'delete') && !st.has_where;
  const r = base(`${engine}.dml.${st.kind}${full ? '.no_where' : ''}`, {
    lock_mode: rowLock,
    blocks: { reads: false, writes: engine === 'sqlite' },
    metadata_lock_risk: 'low',
    rewrite: 'none',
    scan: full ? 'full' : 'unknown',
    transactional: true,
    online: engine !== 'sqlite',
    duration: full ? 'proportional_to_table' : 'unknown',
    temporary_disk: full ? 'table_size' : 'unknown',
    replication_lag_risk: full ? 'high' : 'low',
    cancellation: 'safe: rolls back, but rollback of a large write can take as long as the write',
    confidence: known ? 'medium' : 'low',
    sources: [PG_DOCS_LOCKING],
    destructive: st.kind === 'delete' && full,
  });
  if (full) {
    r.notes.push(`${st.kind.toUpperCase()} without WHERE touches every row: one long transaction, row locks on the whole table, dead-tuple/undo and WAL/binlog growth that replicas must replay`);
    r.safer_alternative = 'process in bounded, keyed batches (e.g. WHERE id > :last ORDER BY id LIMIT 1000) with checkpoints and a replica-lag throttle';
  }
  return r;
}

/** Merge several per-action forecasts into one worst-case forecast. */
function combine(rs) {
  const rsF = rs.filter(Boolean);
  if (rsF.length === 1) return rsF[0];
  const out = { ...rsF[0], notes: [], sources: [] };
  const lockOrder = (m) => { const i = PG_LOCK_ORDER.indexOf(m); if (i >= 0) return i; const j = MY_LOCK_ORDER.indexOf(m); return j >= 0 ? j : 99; };
  for (const r of rsF) {
    if (lockOrder(r.lock_mode) > lockOrder(out.lock_mode)) out.lock_mode = r.lock_mode;
    out.blocks = { reads: out.blocks.reads || r.blocks.reads, writes: out.blocks.writes || r.blocks.writes };
    if (RISK_RANK[r.metadata_lock_risk] > RISK_RANK[out.metadata_lock_risk]) out.metadata_lock_risk = r.metadata_lock_risk;
    if (REWRITE_RANK[r.rewrite] > REWRITE_RANK[out.rewrite]) out.rewrite = r.rewrite;
    if (SCAN_RANK[r.scan] > SCAN_RANK[out.scan]) out.scan = r.scan;
    out.transactional = out.transactional && r.transactional;
    out.online = out.online && r.online;
    out.concurrently_available = out.concurrently_available || r.concurrently_available;
    if (r.duration === 'proportional_to_table' || (out.duration !== 'proportional_to_table' && r.duration === 'unknown')) out.duration = r.duration;
    if (r.temporary_disk === 'table_size' || (out.temporary_disk === 'none' && r.temporary_disk !== 'none')) out.temporary_disk = r.temporary_disk;
    if (LAG_RANK[r.replication_lag_risk] > LAG_RANK[out.replication_lag_risk]) out.replication_lag_risk = r.replication_lag_risk;
    if (CONF_RANK[r.confidence] < CONF_RANK[out.confidence]) out.confidence = r.confidence;
    out.safer_alternative = out.safer_alternative ?? r.safer_alternative;
    out.destructive = out.destructive || r.destructive;
    out.breaks_old_readers = out.breaks_old_readers || r.breaks_old_readers;
    out.notes.push(...r.notes);
    out.sources.push(...r.sources);
    if (r.cancellation.startsWith('cancel is safe for data') || r.cancellation.startsWith('safe for data')) out.cancellation = r.cancellation;
  }
  out.rule_id = [...new Set(rsF.map((r) => r.rule_id))].join('+');
  out.notes = [...new Set(out.notes)];
  out.sources = [...new Set(out.sources)];
  return out;
}

/**
 * Forecast the locking and cost of one SQL statement.
 *
 * @param {object|string} statement parsed statement (from parseSql) or SQL text
 * @param {{engine?: string, version?: string, table?: {estimated_rows?: number, size_bytes?: number, columns?: Record<string,string>, indexed_columns?: string[], partitioned?: boolean, has_valid_not_null_check?: boolean}}} [opts]
 */
export function forecast(statement, opts = {}) {
  const engine = normalizeEngine(opts.engine);
  const version = parseVersion(opts.version);
  const table = opts.table ?? {};
  const st = typeof statement === 'string' ? (parseSql(statement, { dialect: engine === 'unknown' ? 'generic' : engine })[0] ?? { kind: 'unknown', text: statement }) : statement;
  const ctx = {
    engine,
    version,
    table,
    scale: tableScale(table),
    columnType: (name) => (table.columns && name ? table.columns[name] ?? null : null),
    indexedColumn: (name) => Boolean(table.indexed_columns && table.indexed_columns.includes(name)),
  };

  let res = null;
  if (st && ['insert', 'update', 'delete', 'merge', 'select'].includes(st.kind)) res = dmlForecast(st, ctx);
  else if (st && st.kind === 'transaction' || st?.kind === 'set') res = base(`${engine}.session`, { lock_mode: 'NONE', blocks: { reads: false, writes: false }, metadata_lock_risk: 'low', rewrite: 'none', scan: 'none', transactional: true, online: true, duration: 'constant', temporary_disk: 'none', replication_lag_risk: 'low', cancellation: 'n/a', confidence: 'high' });
  else if (st) {
    if (engine === 'postgresql') res = pgStatement(st, ctx);
    else if (engine === 'mysql' || engine === 'mariadb') res = mysqlStatement(st, ctx);
    else if (engine === 'sqlite') res = sqliteStatement(st, ctx);
  }

  if (!res) {
    res = base(engine === 'unknown' ? 'unknown.engine' : `${engine}.unmodelled.${st?.kind ?? 'unknown'}`, {
      confidence: 'low',
      notes: [engine === 'unknown'
        ? 'engine not recognised: assuming the worst case (exclusive lock, rewrite, not transactional)'
        : `statement kind "${st?.kind ?? 'unknown'}" is not modelled for ${engine}`],
      lock_mode: 'unknown', rewrite: 'unknown', scan: 'unknown', duration: 'unknown', temporary_disk: 'unknown',
    });
  }
  if (engine === 'unknown' && res.confidence !== 'low') res.confidence = 'low';
  if (engine !== 'unknown' && !version && res.confidence === 'high') res.confidence = 'medium';
  res.engine = engine;
  res.version = opts.version ?? null;
  res.sources = [...new Set(res.sources)];
  if (tableScale(table) === 'large' && res.duration === 'proportional_to_table') {
    res.notes.push('table is large: expect a long-running operation; rehearse at production volume');
  }
  return res;
}

/** Forecast every statement in a SQL script. */
export function forecastScript(sql, opts = {}) {
  const engine = normalizeEngine(opts.engine);
  return parseSql(sql, { dialect: engine === 'unknown' ? 'generic' : engine }).map((st) => ({ statement: st, forecast: forecast(st, opts) }));
}
