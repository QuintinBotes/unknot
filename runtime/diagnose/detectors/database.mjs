// Database detectors (spec §14.6). They read the facts the database adapter and the IaC
// adapter leave in the graph and propose findings; they never connect to a database, run
// SQL, or suggest running anything against a live system (§14.10). Every finding states
// which spec §14.5 invariants apply, what §14.11 verification is needed, and what recovery
// is honest: anything destructive is roll_forward or restore, never a casual revert.

/** Tables at or above this many estimated rows are "large" (heuristic, spec leaves it open). */
const LARGE_TABLE_ROWS = 100_000;
const HOT_QUERY_CALLS = 1_000; // heuristic: pg_stat_statements calls that make a scan "hot"
const THRESHOLDS = { large_table_rows: LARGE_TABLE_ROWS, large_table_rows_is_heuristic: true };

const DESTRUCTIVE_KINDS = /^(drop_table|truncate|alter_table\.(drop_column|rename_column|rename_table|rename)|rename_table|drop_column)/;
const EXCLUSIVE_LOCKS = new Set(['ACCESS EXCLUSIVE', 'EXCLUSIVE', 'SHARE', 'SHARE ROW EXCLUSIVE']);
const CONF = { high: 0.9, medium: 0.7, low: 0.5 };

const SAFE_ALT = { id: 'expand-migrate-contract', summary: 'Add compatible structure first, migrate in bounded batches, switch readers, and contract only after the recovery window.' };

// -------------------------------------------------------------------------------- helpers

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const evidence = (ref, summary, label = 'observed', source_ref = null) => ({ ref, label, summary, source_ref });
const scopeOf = (...nodes) => [...new Set(nodes.map((n) => n?.path).filter(Boolean))];

/** 1 when any restore test is recorded in the graph, else 0 (never guessed: absence is the signal). */
function restoreTested(graph, nodeId = null) {
  if (nodeId && (graph.out(nodeId, 'RESTORED_BY').length || graph.in(nodeId, 'RESTORED_BY').length)) return 1;
  return graph.nodes('restore_test').length > 0 ? 1 : 0;
}

/** Estimated rows of a table node id such as `table:public.orders`, or null when unknown. */
function rowsOf(graph, tableId) {
  return num(graph.node(tableId)?.attrs?.estimated_rows);
}

const isLarge = (rows) => rows !== null && rows >= LARGE_TABLE_ROWS;

/** Table node id for a statement table like `public.orders` (MySQL/SQLite have no schema). */
const tableId = (key) => `table:${key}`;

/**
 * Package-ish owner of a module: the nearest package/service/workspace ancestor, else the
 * first meaningful path segments (`services/orders/...` -> `services/orders`). Heuristic.
 */
function ownerOf(graph, id) {
  let cur = graph.node(id);
  for (let i = 0; cur && i < 8; i++) {
    if (['package', 'service', 'workspace'].includes(cur.type)) return `${cur.type}:${cur.name}`;
    cur = graph.parent(cur.id);
  }
  const path = graph.node(id)?.path ?? id.replace(/^[a-z_]+:/, '');
  const parts = String(path).split('/').filter(Boolean);
  const i = parts.findIndex((p) => ['services', 'packages', 'apps', 'libs', 'modules', 'cmd'].includes(p));
  if (i >= 0 && parts[i + 1]) return `${parts[i]}/${parts[i + 1]}`;
  return parts.length > 1 ? parts[0] : '.';
}

/** Distinct owners that mutate a table, from MUTATES edges whose source is code. */
function writersOf(graph, tid) {
  const owners = new Map();
  for (const e of graph.in(tid, 'MUTATES')) {
    const src = graph.node(e.from);
    if (!src || ['query', 'plan', 'migration'].includes(src.type)) continue;
    const o = ownerOf(graph, src.id);
    if (!owners.has(o)) owners.set(o, []);
    owners.get(o).push(src.id);
  }
  return owners;
}

/** Fill the fields every draft needs so detectors only state what is specific. */
function draft(d) {
  return {
    thresholds: THRESHOLDS,
    essential_considerations: [],
    invariants: [],
    risks: [],
    verification: [],
    uncertainties: [],
    blast_radius: 'bounded',
    quality_impacts: { changeability: 'medium', reliability: 'medium', security: 'low' },
    ...d,
    alternatives: [{ id: 'retain', summary: 'Keep the current schema and document why; revisit when the measured cost grows.' }, ...(d.alternatives ?? [])],
  };
}

function detector(name, detect, extra = {}) {
  return { id: `database.${name}`, version: '1.0.0', category: 'database', kinds: [`database.${name}`], detect, ...extra };
}

// §14.5 invariants, quoted once so findings pick the ones that apply.
const INV = {
  owner: 'Source of truth and owner of the data are named before any change.',
  paths: 'Read and write paths of every affected table are known and unchanged for callers.',
  constraints: 'Nullability, uniqueness, referential and domain constraints keep their current guarantees.',
  compat: 'Old and new application versions both work during the compatibility window (N and N-1).',
  recovery: 'RPO/RTO, backup and the restore mechanism are stated, and a restore has been rehearsed in isolation.',
  idempotent: 'Ordering, idempotency and deduplication of writes are preserved; backfills are resumable.',
  abort: 'Cutover, abort and roll-forward conditions are written down before execution.',
  reconcile: 'A reconciliation rule and acceptable discrepancy are defined (counts, checksums, domain checks).',
  tenant: 'Tenant boundary, classification, retention and residency are unchanged.',
};

const NO_LIVE = 'Rehearse on a copy at production-like volume and skew; execute only through the organisation delivery system, never directly against a live database.';

// -------------------------------------------------------------------------------- detectors

const unusedIndex = detector('unused-index', ({ graph }) => {
  const out = [];
  const tested = restoreTested(graph);
  for (const ix of graph.nodes('index')) {
    const a = ix.attrs;
    // Only catalog-sourced usage statistics can say "unused"; DDL alone cannot.
    const scans = num(a.idx_scan);
    if (scans !== 0 || a.unique || a.primary || a.valid === false) continue;
    const rows = rowsOf(graph, `table:${a.table}`);
    out.push(draft({
      kind: 'database.unused-index',
      title: `Index ${ix.name} on ${a.table} shows no scans in the statistics window`,
      scope: scopeOf(ix),
      key: ix.id,
      evidence: [evidence(ix.id, `idx_scan = 0${a.size_bytes ? `, ${a.size_bytes} bytes` : ''}; ${a.definition ?? 'definition unknown'}`, 'observed', ix.path)],
      measurements: { 'index.scans': 0, 'backup.restore_tested': tested, ...(rows !== null ? { 'table.rows': rows } : {}) },
      why_accidental: 'An index nobody reads still costs write amplification, storage and vacuum time on every row change.',
      essential_considerations: ['A rare month-end or batch query may be the only reader.', 'The index may back a constraint or be the only support for a foreign key lookup.', 'Replicas keep their own statistics; the primary alone may under-report use.'],
      smallest_simplification: 'Make the index invisible (or monitor it) across a full peak and batch cycle, keep its definition, then drop it with a prepared CREATE INDEX CONCURRENTLY to roll forward.',
      invariants: [INV.paths, INV.recovery, INV.compat],
      risks: ['Dropping takes a brief ACCESS EXCLUSIVE lock on the table; use DROP INDEX CONCURRENTLY and a lock timeout.', 'Rebuilding a large index later is a long, replica-lag-producing operation, so the drop is only cheap to reverse on small tables.', 'A rare query may regress to a sequential scan.'],
      verification: ['Collect pg_stat_user_indexes from primary and every replica across a full business cycle.', 'Compare plans of the slowest queries with the index hidden.', 'Rehearse the drop and the CONCURRENTLY rebuild on a production-sized copy and record rebuild time and replica lag.', NO_LIVE],
      recovery: { type: 'roll_forward', procedure: 'Recreate the saved definition with CREATE INDEX CONCURRENTLY.', notes: 'Rebuild time grows with table size; a restore is not required but its absence is recorded.' },
      quality_impacts: { changeability: 'low', reliability: 'medium', security: 'low' },
      factors: { benefit: 2, evidence: 0.5, reversibility: 0.6, blast: 2, cost: 1, uncertainty: 3 },
      uncertainties: [`Statistics window: ${a.observation_window ?? 'unknown'}. idx_scan counts since the last stats reset, so zero is a prompt to observe, not a verdict (spec §14.10).`],
      alternatives: [{ id: 'hide-then-drop', summary: 'Observe with the index disabled for one full cycle before dropping.' }],
      patterns: ['database.remove-unused-index'],
    }));
  }
  return out;
});

const duplicateIndex = detector('duplicate-index', ({ graph }) => {
  const out = [];
  const byTable = new Map();
  for (const ix of graph.nodes('index')) {
    const a = ix.attrs;
    if (!a.table || !Array.isArray(a.columns) || !a.columns.length || a.valid === false) continue;
    if (!byTable.has(a.table)) byTable.set(a.table, []);
    byTable.get(a.table).push(ix);
  }
  for (const [table, list] of byTable) {
    list.sort((x, y) => (x.attrs.primary ? -1 : y.attrs.primary ? 1 : 0) || x.id.localeCompare(y.id));
    const flagged = new Set();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = 0; j < list.length; j++) {
        const b = list[j];
        if (i === j || flagged.has(a.id)) continue;
        const ac = a.attrs.columns;
        const bc = b.attrs.columns;
        if ((a.attrs.method ?? 'btree') !== (b.attrs.method ?? 'btree') || (a.attrs.where ?? null) !== (b.attrs.where ?? null)) continue;
        const sameCols = ac.length === bc.length && ac.every((c, k) => c === bc[k]);
        const prefix = bc.length > ac.length && ac.every((c, k) => c === bc[k]);
        // Equal indexes: flag the later one. Prefix: flag the shorter, never a unique/primary one (it enforces a rule).
        const duplicate = sameCols && Boolean(a.attrs.unique) === Boolean(b.attrs.unique) && i > j && !a.attrs.primary;
        const redundant = prefix && !a.attrs.unique && !a.attrs.primary;
        if (!duplicate && !redundant) continue;
        flagged.add(a.id);
        const rows = rowsOf(graph, `table:${table}`);
        out.push(draft({
          kind: 'database.duplicate-index',
          title: `Index ${a.name} on ${table} is ${duplicate ? 'a duplicate of' : 'a leading-column prefix of'} ${b.name}`,
          scope: scopeOf(a, b),
          key: `${a.id}>${b.id}`,
          evidence: [
            evidence(a.id, `columns (${ac.join(', ')})${a.attrs.idx_scan !== undefined && a.attrs.idx_scan !== null ? `, idx_scan ${a.attrs.idx_scan}` : ''}`, 'observed', a.path),
            evidence(b.id, `columns (${bc.join(', ')})${b.attrs.idx_scan !== undefined && b.attrs.idx_scan !== null ? `, idx_scan ${b.attrs.idx_scan}` : ''}`, 'observed', b.path),
          ],
          measurements: { 'index.duplicates': 1, 'backup.restore_tested': restoreTested(graph), ...(rows !== null ? { 'table.rows': rows } : {}) },
          why_accidental: duplicate ? 'Two indexes with the same definition serve identical queries; one only adds write cost.' : 'A btree on (a) is served by a btree on (a, b) for equality and range on a, so the shorter one is redundant unless a query depends on its smaller size.',
          essential_considerations: ['A smaller prefix index can be faster for index-only scans on hot paths.', 'Different opclasses, collations or INCLUDE columns make "same columns" not the same index.', 'Never remove an index that backs a unique or primary-key constraint.'],
          smallest_simplification: `Drop ${a.name} after confirming ${b.name} serves its queries (plans compared), using DROP INDEX CONCURRENTLY.`,
          invariants: [INV.paths, INV.constraints, INV.recovery],
          risks: ['DROP INDEX CONCURRENTLY still waits on long transactions and cannot run inside a transaction block.', 'Queries that relied on the smaller index may become slower or lose index-only scans.', 'Large index rebuilds are slow and lag replicas if the drop must be reversed.'],
          verification: ['Compare EXPLAIN plans for the queries that used the dropped index against the retained one.', 'Check idx_scan on primary and replicas for both indexes.', 'Rehearse drop and CONCURRENTLY recreate on a production-sized copy; record rebuild time.', NO_LIVE],
          recovery: { type: 'roll_forward', procedure: 'Recreate the saved index definition with CREATE INDEX CONCURRENTLY.' },
          quality_impacts: { changeability: 'low', reliability: 'low', security: 'low' },
          factors: { benefit: 2, evidence: a.attrs.definition ? 0.85 : 0.7, reversibility: 0.6, blast: 2, cost: 1, uncertainty: 2 },
          uncertainties: ['Operator classes, collation, INCLUDE columns and partial predicates beyond the recorded WHERE are not compared.'],
          patterns: ['database.merge-duplicate-indexes'],
        }));
      }
    }
  }
  return out;
});

/** Flagged migration statements for hazards (lock/rewrite/scan) honouring table size. */
function hazardStatements(graph, mig) {
  const hits = [];
  // A table created earlier in the same migration is empty when the statement runs.
  const created = new Set();
  for (const st of mig.attrs.statements ?? []) {
    if (st.kind === 'create_table' && st.table) created.add(st.table);
    const f = st.forecast;
    if (!f || !st.table || created.has(st.table)) continue;
    const blocking = EXCLUSIVE_LOCKS.has(f.lock_mode) && (f.rewrite !== 'none' || f.scan === 'full');
    if (!blocking && f.rewrite !== 'table') continue;
    const rows = rowsOf(graph, tableId(st.table));
    if (rows !== null && !isLarge(rows)) continue; // known small table: a short lock, not a hazard
    hits.push({ st, f, rows });
  }
  return hits;
}

const hazardousMigration = detector('hazardous-migration', ({ graph }) => {
  const out = [];
  for (const mig of graph.nodes('migration')) {
    const hits = hazardStatements(graph, mig);
    if (!hits.length) continue;
    const unknownSize = hits.some((h) => h.rows === null);
    const conf = Math.min(...hits.map((h) => CONF[h.f.confidence] ?? 0.5));
    const known = hits.map((h) => h.rows).filter((r) => r !== null);
    const alts = [...new Set(hits.map((h) => h.f.safer_alternative).filter(Boolean))];
    out.push(draft({
      kind: 'database.hazardous-migration',
      title: `${mig.name} takes blocking locks or rewrites on ${[...new Set(hits.map((h) => h.st.table))].join(', ')}`,
      scope: scopeOf(mig),
      key: mig.id,
      evidence: hits.map((h) => evidence(mig.id, `line ${h.st.line}: ${h.st.kind} takes ${h.f.lock_mode}, rewrite ${h.f.rewrite}, scan ${h.f.scan} on ${h.st.table} (${h.rows === null ? 'size unknown' : `${h.rows} rows`}); rule ${h.f.rule_id}`, 'inferred', `${mig.path}:${h.st.line}`)),
      measurements: { 'migration.locks_exclusive': 1, 'migration.irreversible': mig.attrs.irreversible ? 1 : 0, 'backup.restore_tested': restoreTested(graph), ...(known.length ? { 'table.rows': Math.max(...known) } : {}) },
      thresholds: { ...THRESHOLDS, flagged_when: 'lock in {ACCESS EXCLUSIVE, EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE} with a rewrite or full scan, on a table >= large_table_rows or of unknown size' },
      why_accidental: 'The change is expressed as one blocking statement although the engine offers an online or phased form of the same outcome.',
      essential_considerations: ['A short maintenance window may be acceptable for a small or idle table.', 'Some changes (type narrowing) have no online form on older engine versions.'],
      smallest_simplification: alts[0] ?? 'Split into expand, backfill in bounded batches, validate, switch, then contract.',
      invariants: [INV.compat, INV.recovery, INV.abort, INV.idempotent],
      risks: [
        'ACCESS EXCLUSIVE and table rewrites block reads and writes for the full duration; lock queueing stalls unrelated traffic behind the waiting DDL.',
        'A rewrite needs temporary disk and write-ahead log of roughly the table size and produces replication and CDC lag.',
        'Cancelling a rewrite late wastes the work; set lock_timeout and statement_timeout.',
        ...(unknownSize ? ['Table size is unknown, so the duration and lag forecast is pessimistic.'] : []),
      ],
      verification: ['Run migration lint and syntax checks.', 'Rehearse on empty, representative and production-scale copies and record lock acquisition and duration.', 'Check disk headroom for rewrite and WAL, and replica and CDC lag during the rehearsal.', 'Verify N and N-1 application compatibility before and after.', 'Pause, cancel and resume the rehearsal.', NO_LIVE],
      recovery: { type: 'roll_forward', procedure: 'Prefer a forward corrective migration; a rewrite cannot be undone cheaply once committed.', notes: 'Transactional DDL can be rolled back only before commit.' },
      blast_radius: 'high',
      quality_impacts: { changeability: 'medium', reliability: 'high', security: 'low' },
      factors: { benefit: 4, evidence: unknownSize ? Math.min(conf, 0.6) : conf, reversibility: 0.4, blast: 4, cost: 3, uncertainty: unknownSize ? 3 : 2 },
      uncertainties: [...(unknownSize ? ['Table size unknown: add a catalog export with estimated_rows to confirm.'] : []), 'Forecast assumes the engine version recorded by the adapter; verify against the real version.'],
      alternatives: [SAFE_ALT],
      patterns: ['migration.expand-migrate-contract', 'migration.backfill'],
    }));
  }
  return out;
});

const destructiveMigration = detector('destructive-migration', ({ graph }) => {
  const out = [];
  for (const mig of graph.nodes('migration')) {
    const stmts = (mig.attrs.statements ?? []).filter((s) => !s.recreated && (DESTRUCTIVE_KINDS.test(s.kind) || s.forecast?.destructive || s.forecast?.breaks_old_readers));
    if (!stmts.length && !mig.attrs.destructive) continue;
    const noDown = mig.attrs.has_down === false;
    const adapterFindings = graph.nodes('finding').filter((f) => f.attrs?.migration === mig.id).map((f) => f.id);
    out.push(draft({
      kind: 'database.destructive-migration',
      title: `${mig.name} drops or renames data-bearing objects${noDown ? ' and has no down/undo' : ''}`,
      scope: scopeOf(mig),
      key: mig.id,
      evidence: [
        ...stmts.map((s) => evidence(mig.id, `line ${s.line}: ${s.kind} on ${s.table}`, 'observed', `${mig.path}:${s.line}`)),
        ...adapterFindings.map((id) => evidence(id, 'adapter reports a missing down migration', 'observed')),
      ],
      measurements: { 'migration.irreversible': mig.attrs.irreversible || noDown ? 1 : 0, 'backup.restore_tested': restoreTested(graph) },
      thresholds: { ...THRESHOLDS, flagged_when: 'DROP COLUMN/TABLE, RENAME or TRUNCATE (destructive per forecast); a missing down alone is not flagged because Flyway-style projects have none' },
      why_accidental: 'Dropping or renaming in the same release that stops using the object removes the only way back and breaks any old reader still deployed.',
      essential_considerations: ['The object may be genuinely dead, confirmed by usage statistics and a retired reader.', 'Regulatory deletion may require destruction.'],
      smallest_simplification: 'Split into expand/contract: stop all reads and writes first, keep the object renamed-out-of-the-way for a release cycle and backup window, and drop only when usage is zero and recovery obligations have expired.',
      invariants: [INV.compat, INV.recovery, INV.abort, INV.tenant],
      risks: ['Dropped data is recoverable only from backup or point-in-time recovery; replicas replay the drop immediately.', 'DROP and RENAME take ACCESS EXCLUSIVE locks and invalidate prepared statements and views of old readers.', 'Rolling deploys mean N-1 pods still query the old name during the release.'],
      verification: ['Prove zero reads/writes of the object over a full business cycle.', 'Verify N and N-1 compatibility against the schema after the change.', 'Take a backup and restore it in isolation; for critical stores rehearse point-in-time recovery.', 'Check retention and deletion-propagation requirements for copies of the data.', NO_LIVE],
      recovery: { type: 'restore', procedure: 'Restore the dropped object from a verified backup or PITR into an isolated instance and copy back.', notes: 'Without a tested restore this step is irreversible.' },
      blast_radius: 'high',
      quality_impacts: { changeability: 'medium', reliability: 'high', security: 'low' },
      factors: { benefit: 3, evidence: 0.85, reversibility: 0.15, blast: 4, cost: 3, uncertainty: 2 },
      uncertainties: ['Whether old readers are retired is not visible in the graph.'],
      alternatives: [SAFE_ALT],
      patterns: ['migration.expand-migrate-contract', 'migration.parallel-change'],
    }));
  }
  return out;
});

const backfillWithoutBatching = detector('backfill-without-batching', ({ graph }) => {
  const out = [];
  for (const mig of graph.nodes('migration')) {
    for (const st of mig.attrs.statements ?? []) {
      if (!['update', 'delete'].includes(st.kind) || !st.table) continue;
      const f = st.forecast ?? {};
      const noWhere = /no_where/.test(f.rule_id ?? '');
      const rows = rowsOf(graph, tableId(st.table));
      // Batching hints are not visible in the statement summary: an unbounded WHERE-less
      // statement is the confident case; a full scan on a known large table is the weaker one.
      const largeScan = f.scan === 'full' && isLarge(rows);
      if (!noWhere && !largeScan) continue;
      if (noWhere && rows !== null && !isLarge(rows)) continue;
      out.push(draft({
        kind: 'database.backfill-without-batching',
        title: `${mig.name} runs ${st.kind.toUpperCase()} on ${st.table} ${noWhere ? 'without WHERE' : 'as one full scan'}`,
        scope: scopeOf(mig),
        key: `${mig.id}:${st.line}`,
        evidence: [evidence(mig.id, `line ${st.line}: ${st.kind} on ${st.table}, rule ${f.rule_id ?? 'n/a'} (${rows === null ? 'size unknown' : `${rows} rows`})`, 'inferred', `${mig.path}:${st.line}`)],
        measurements: { 'migration.locks_exclusive': EXCLUSIVE_LOCKS.has(f.lock_mode) ? 1 : 0, 'backup.restore_tested': restoreTested(graph), ...(rows !== null ? { 'table.rows': rows } : {}) },
        why_accidental: 'A single statement touches every row in one transaction instead of bounded, resumable batches.',
        essential_considerations: ['A small table or an empty one in a fresh deployment is fine unbatched.', 'Batching hints inside the file are not visible to the adapter.'],
        smallest_simplification: f.safer_alternative ?? 'Process in bounded keyed batches (WHERE id > :last ORDER BY id LIMIT 1000) with checkpoints and a replica-lag throttle.',
        invariants: [INV.idempotent, INV.reconcile, INV.abort, INV.recovery],
        risks: ['One long transaction holds row locks, bloats the table, and generates a burst of write-ahead log that lags replicas and CDC consumers.', 'A failure late in the run rolls back all work and a partial run without a checkpoint cannot resume.', 'Autovacuum cannot reclaim dead tuples until the transaction ends.'],
        verification: ['Rehearse with batches on a production-sized copy; record duration, WAL volume and replica lag.', 'Test pause, resume, retry and idempotency (run twice, same result).', 'Reconcile counts, checksums and domain invariants after the run.', NO_LIVE],
        recovery: { type: st.kind === 'delete' ? 'restore' : 'roll_forward', procedure: st.kind === 'delete' ? 'Restore deleted rows from backup or PITR.' : 'Re-run the idempotent backfill with the corrected predicate.' },
        blast_radius: 'high',
        quality_impacts: { changeability: 'medium', reliability: 'high', security: 'low' },
        factors: { benefit: 3, evidence: noWhere ? 0.8 : 0.5, reversibility: st.kind === 'delete' ? 0.2 : 0.5, blast: 3, cost: 2, uncertainty: noWhere ? 2 : 3 },
        uncertainties: [...(rows === null ? ['Table size unknown.'] : []), 'Application-level throttling outside the migration file is not visible.'],
        alternatives: [{ id: 'batched-backfill', summary: 'Move the data change into a separate, throttled, resumable backfill job.' }],
        patterns: ['migration.backfill', 'migration.expand-migrate-contract'],
      }));
    }
  }
  return out;
});

const multipleWriters = detector('multiple-writers', ({ graph }) => {
  const out = [];
  for (const table of graph.nodes('table')) {
    const owners = writersOf(graph, table.id);
    if (owners.size < 2) continue;
    const declared = graph.in(table.id, 'OWNS_DATA').map((e) => ownerOf(graph, e.from));
    const names = [...owners.keys()].sort();
    out.push(draft({
      kind: 'database.multiple-writers',
      title: `${table.name} is written by ${owners.size} packages (${names.join(', ')})`,
      scope: scopeOf(table, ...[...owners.values()].flat().map((id) => graph.node(id))),
      key: table.id,
      evidence: names.map((o) => evidence(owners.get(o)[0], `${o} mutates ${table.id} via ${owners.get(o).length} module(s)`, 'observed')),
      measurements: { 'table.writers': owners.size, 'boundary.shared_table_writers': owners.size - 1, 'boundary.interface_count': declared.length },
      thresholds: { ...THRESHOLDS, writers_min: 2, owner_resolution: 'nearest package/service ancestor, else path heuristic' },
      why_accidental: 'Several teams change the same rows with no single owner enforcing invariants, so every writer must re-implement them.',
      essential_considerations: ['A shared library owned by one team that all services link is one writer, not many.', 'Some legacy tables are intentionally shared during a strangler migration.'],
      smallest_simplification: declared.length ? `Route the writes of non-owning packages through the owner (${declared[0]}) via an owned interface.` : 'Name one owner and put an owned interface (API or event) in front of writes; other packages stop writing directly.',
      invariants: [INV.owner, INV.paths, INV.constraints, INV.idempotent, INV.tenant],
      risks: ['Introducing the interface adds a hop and a new failure mode; dual writes during the transition need an outbox and reconciliation.', 'Changing write paths risks lost or duplicated writes without idempotency keys.', 'Permissions must be tightened afterwards, which can break forgotten writers.'],
      verification: ['Inventory every writer, including jobs and scripts, from statements and grants.', 'Contract-test the new interface; compare row counts and checksums between old and new paths.', 'Restrict database grants for non-owners last, after a rollback-free observation window.', NO_LIVE],
      recovery: { type: 'roll_forward', procedure: 'Re-enable the previous direct writer behind a flag while reconciling.', notes: 'Rows written through a mixed path need reconciliation, so a plain revert is not enough.' },
      blast_radius: 'moderate',
      quality_impacts: { changeability: 'high', reliability: 'medium', security: 'medium' },
      factors: { benefit: 4, evidence: 0.75, reversibility: 0.5, blast: 4, cost: 4, uncertainty: 3 },
      uncertainties: [declared.length ? 'An owner is declared; whether the other writers already go through an interface is not visible.' : 'No declared owner (OWNS_DATA); ownership must be decided by people, not inferred.'],
      alternatives: [{ id: 'owned-interface', summary: 'One owner exposes writes behind an interface.' }, { id: 'merge-owners', summary: 'Merge the writing packages when they change and deploy together.' }],
      patterns: ['database.owned-interface-for-cross-service-writes', 'database.split-schema-by-ownership', 'anti-pattern.shared-database'],
    }));
  }
  return out;
});

const crossBoundaryJoins = detector('cross-boundary-joins', ({ graph }) => {
  const out = [];
  const seen = new Set();
  for (const e of graph.edges('JOINS_WITH')) {
    const pair = [e.from, e.to].sort().join('|');
    if (seen.has(pair)) continue;
    const a = writersOf(graph, e.from);
    const b = writersOf(graph, e.to);
    if (!a.size || !b.size) continue;
    // Shared ownership on either side means the join stays inside one boundary.
    if ([...a.keys()].some((o) => b.has(o))) continue;
    seen.add(pair);
    const ta = graph.node(e.from);
    const tb = graph.node(e.to);
    out.push(draft({
      kind: 'database.cross-boundary-joins',
      title: `${ta?.name} and ${tb?.name} are joined although written by different packages`,
      scope: scopeOf(ta, tb, graph.node(e.attrs?.module)),
      key: pair,
      evidence: [
        evidence(e.from, `written by ${[...a.keys()].join(', ')}`, 'observed'),
        evidence(e.to, `written by ${[...b.keys()].join(', ')}`, 'observed'),
        evidence(e.attrs?.module ?? e.from, `JOINS_WITH at line ${e.attrs?.line ?? '?'}`, 'observed'),
      ],
      measurements: { 'boundary.cross_joins': 1, 'table.writers': a.size + b.size },
      why_accidental: 'A join across data owned by different boundaries couples their schemas and removes the autonomy the boundary was meant to give.',
      essential_considerations: ['Reporting or read-model queries may legitimately read across boundaries on a replica.', 'Reference data (countries, currencies) joined by many packages is not coupling.'],
      smallest_simplification: 'Replace the join with a call to the owner or a replicated read model with lineage and freshness stated; keep the join only for read-only reporting.',
      invariants: [INV.owner, INV.paths, INV.reconcile],
      risks: ['Replacing a join with calls adds latency and N+1 risk.', 'A replicated read model can go stale; define freshness and deletion propagation.'],
      verification: ['Measure the query before and after on production-like data.', 'Reconcile the read model against the source of truth.', NO_LIVE],
      recovery: { type: 'revert', notes: 'The join can be restored from version control while the owner interface remains.' },
      quality_impacts: { changeability: 'high', reliability: 'medium', security: 'low' },
      factors: { benefit: 3, evidence: 0.6, reversibility: 0.7, blast: 3, cost: 3, uncertainty: 3 },
      uncertainties: ['Ownership is resolved by package heuristics; confirm with the owning teams.'],
      patterns: ['database.owned-interface-for-cross-service-writes', 'anti-pattern.shared-database'],
    }));
  }
  return out;
});

const unboundedQuery = detector('unbounded-query', ({ graph }) => {
  const out = [];
  for (const e of graph.edges('QUERIES')) {
    const src = graph.node(e.from);
    const table = graph.node(e.to);
    if (!src || !table || table.type !== 'table' || ['plan', 'migration'].includes(src.type)) continue;
    const rows = rowsOf(graph, table.id);
    if (!isLarge(rows)) continue; // unknown size is not evidence of a problem
    let unbounded;
    if (src.type === 'query') {
      const text = String(src.attrs.text ?? '');
      unbounded = /^\s*select/i.test(text) && !/\bwhere\b/i.test(text) && !/\blimit\b/i.test(text);
    } else {
      unbounded = e.attrs?.has_where === false && e.attrs?.has_limit !== true;
    }
    if (!unbounded) continue;
    out.push(draft({
      kind: 'database.unbounded-query',
      title: `${src.name} reads ${table.name} without WHERE or LIMIT (~${rows} rows)`,
      scope: scopeOf(src, table),
      key: `${src.id}>${table.id}:${e.attrs?.line ?? ''}`,
      evidence: [evidence(src.id, `SELECT without WHERE/LIMIT${e.attrs?.line ? ` at line ${e.attrs.line}` : ''}${src.attrs.calls ? `, ${src.attrs.calls} calls` : ''}`, 'inferred', src.path), evidence(table.id, `estimated_rows ${rows}`, 'observed', table.path)],
      measurements: { 'table.rows': rows },
      thresholds: { ...THRESHOLDS, flagged_when: 'SELECT with no WHERE and no LIMIT on a table with known estimated_rows >= large_table_rows' },
      why_accidental: 'The result size grows with the table, so latency, memory and network use grow without any code change.',
      essential_considerations: ['An export or batch job may deliberately scan everything, ideally with a cursor and on a replica.'],
      smallest_simplification: 'Add a keyset-paginated LIMIT (or streaming cursor) with a stable order, or an explicit predicate.',
      invariants: [INV.paths, 'Callers see the same rows, ordering and completeness semantics they rely on.'],
      risks: ['Callers that assumed the full result will silently miss rows once paginated.', 'OFFSET pagination moves the cost rather than removing it; prefer keyset.'],
      verification: ['Compare query plans and latency before and after on a production-sized copy.', 'Test pagination boundaries and concurrent inserts.', NO_LIVE],
      recovery: { type: 'revert', notes: 'Application code change; no data is touched.' },
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
      factors: { benefit: 3, evidence: src.type === 'query' ? 0.7 : 0.55, reversibility: 0.9, blast: 2, cost: 2, uncertainty: 2 },
      uncertainties: ['The adapter sees a statement string; LIMIT added by an ORM layer or a wrapper view is not visible.'],
    }));
  }
  return out;
});

const fullScanOnHotPath = detector('full-scan-on-hot-path', ({ graph }) => {
  const out = [];
  for (const plan of graph.nodes('plan')) {
    for (const s of plan.attrs.seq_scans ?? []) {
      const tid = tableId(s.table);
      const rows = rowsOf(graph, tid) ?? num(s.rows);
      if (!isLarge(rows)) continue;
      // Hot = some statement export shows the same table queried often. Without one, say so.
      const hotCalls = graph.in(tid, 'QUERIES').map((e) => graph.node(e.from)).filter((n) => n?.type === 'query').reduce((m, n) => Math.max(m, num(n.attrs.calls) ?? 0), 0);
      const hot = hotCalls >= HOT_QUERY_CALLS;
      out.push(draft({
        kind: 'database.full-scan-on-hot-path',
        title: `Plan seq-scans ${s.table} (~${rows} rows)${s.filter ? ' with a filter' : ''}`,
        scope: scopeOf(plan, graph.node(tid)),
        key: `${plan.id}:${s.table}`,
        evidence: [evidence(plan.id, `Seq Scan on ${s.table}, cost ${s.cost}${s.filter ? `, filter ${s.filter}` : ''}`, 'observed', plan.path), ...(hot ? [evidence(tid, `queried ${hotCalls} times in the statement export`, 'corroborated')] : [])],
        measurements: { 'table.rows': rows },
        thresholds: { ...THRESHOLDS, hot_query_calls: HOT_QUERY_CALLS, hot_is_heuristic: true },
        why_accidental: 'A filter on a large table with no usable index reads every row on each execution.',
        essential_considerations: ['A planner may rightly pick a seq scan when the predicate matches most rows.', 'Analytics queries may be better served by a replica or warehouse than an index.'],
        smallest_simplification: 'Add the narrowest supporting index (CREATE INDEX CONCURRENTLY) for the filter, or tighten the predicate; check it before dropping any other index.',
        invariants: [INV.paths, INV.constraints],
        risks: ['A new index adds write amplification and a long CONCURRENTLY build that lags replicas.', 'Plans differ with statistics; an EXPLAIN without ANALYZE is an estimate.'],
        verification: ['EXPLAIN (ANALYZE) on a production-sized copy before and after.', 'Measure write latency and index size impact.', 'Check replica lag during the index build.', NO_LIVE],
        recovery: { type: 'roll_forward', procedure: 'Drop the new index CONCURRENTLY if it does not help.' },
        quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
        factors: { benefit: 3, evidence: hot ? 0.8 : 0.45, reversibility: 0.7, blast: 2, cost: 2, uncertainty: hot ? 2 : 3 },
        uncertainties: hot ? [] : ['Hot-path status is unproven: no statement export shows how often this query runs.'],
        alternatives: [{ id: 'index', summary: 'Add a supporting index.' }, { id: 'narrow-query', summary: 'Narrow or paginate the query.' }],
      }));
    }
  }
  return out;
});

const missingConstraintCandidates = detector('missing-constraint-candidates', ({ graph }) => {
  const out = [];
  for (const table of graph.nodes('table')) {
    const refEdges = graph.out(table.id, 'REFERENCES');
    const fkCols = new Set(refEdges.flatMap((e) => e.attrs?.columns ?? []));
    for (const c of graph.children(table.id, 'constraint')) {
      if (c.attrs.kind === 'foreign_key') (c.attrs.columns ?? []).forEach((x) => fkCols.add(x));
    }
    const candidates = [];
    for (const col of graph.children(table.id, 'column')) {
      const m = /^(.+)_id$/.exec(col.name);
      if (!m || fkCols.has(col.name)) continue;
      const schema = table.id.slice(6).includes('.') ? `${table.id.slice(6).split('.')[0]}.` : '';
      const target = [`${m[1]}s`, m[1], `${m[1]}es`].map((n) => `table:${schema}${n}`).find((id) => graph.node(id) && id !== table.id);
      if (target) candidates.push({ col, target });
    }
    if (!candidates.length) continue;
    out.push(draft({
      kind: 'database.missing-constraint-candidates',
      title: `${table.name} has ${candidates.length} *_id column(s) without a foreign key (${candidates.map((c) => c.col.name).join(', ')})`,
      scope: scopeOf(table),
      key: table.id,
      evidence: candidates.map((c) => evidence(c.col.id, `${c.col.name} looks like a reference to ${c.target} but no FOREIGN KEY is declared`, 'inferred', c.col.path)),
      measurements: { 'data.reconciliation_tooling': 0 },
      thresholds: { ...THRESHOLDS, naming_rule: '<name>_id with a sibling table <name>, <name>s or <name>es' },
      why_accidental: 'Referential integrity enforced only by application code is re-implemented inconsistently by each writer.',
      essential_considerations: ['Polymorphic or cross-service ids intentionally have no foreign key.', 'Soft-deleted or archived parents may be removed on purpose.', 'A column named *_id may not reference that table at all.'],
      smallest_simplification: 'For confirmed references, add the constraint as NOT VALID, clean orphans, then VALIDATE CONSTRAINT.',
      invariants: [INV.constraints, INV.compat, INV.paths],
      risks: ['Existing orphan rows make VALIDATE fail and writers that tolerate orphans start erroring.', 'ADD FOREIGN KEY takes locks on both tables; NOT VALID then VALIDATE limits the blocking time.', 'Cascade settings change delete behaviour.'],
      verification: ['Count orphans per candidate on a copy.', 'Rehearse ADD ... NOT VALID and VALIDATE and record lock time.', 'Run the application test suite against the constraint.', NO_LIVE],
      recovery: { type: 'revert', procedure: 'DROP CONSTRAINT; no data is changed by adding a constraint.' },
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
      factors: { benefit: 2, evidence: 0.35, reversibility: 0.8, blast: 2, cost: 2, uncertainty: 3 },
      uncertainties: ['Low confidence: inferred from column and table names only.'],
      patterns: ['database.replace-app-validation-with-constraint'],
    }));
  }
  return out;
});

const backupsNotRestoreTested = detector('backups-not-restore-tested', ({ graph }) => {
  const out = [];
  for (const db of graph.nodes('database')) {
    if (db.attrs.data) continue;
    if (restoreTested(graph, db.id) === 1) continue;
    const a = db.attrs;
    const retention = num(a.backup_retention_period);
    const hasPolicy = graph.nodes('backup_policy').length > 0 || graph.in(db.id, 'BACKED_UP_BY').length > 0 || graph.out(db.id, 'BACKED_UP_BY').length > 0;
    const state = retention === 0 ? 'backup retention is 0 (automated backups disabled)' : retention === null ? (hasPolicy ? 'a backup policy exists in the graph but retention for this database is not declared' : 'no backup retention or backup policy is declared') : `backups retained ${retention} day(s) but no restore test is recorded`;
    out.push(draft({
      kind: 'database.backups-not-restore-tested',
      title: `${db.name}: ${state}`,
      scope: scopeOf(db),
      key: db.id,
      evidence: [evidence(db.id, `${state}; restore_test nodes in graph: 0`, 'observed', db.path)],
      measurements: { 'backup.restore_tested': 0, ...(retention !== null ? { 'data.reconciliation_tooling': 0 } : {}) },
      thresholds: { ...THRESHOLDS, restore_tested: 'any restore_test node or RESTORED_BY edge' },
      why_accidental: 'A backup that has never been restored is an unverified assumption; replication is not a backup and neither is a snapshot in the same account.',
      essential_considerations: ['Managed services may run restore tests the repository does not record.', 'An ephemeral or derived database may need no backup.', 'Evidence of tests may live in a runbook or ticket outside the graph.'],
      smallest_simplification: retention === 0 || retention === null ? 'Declare a backup retention matching the stated RPO, then schedule and record an isolated restore test.' : 'Record a periodic isolated restore test (and a PITR rehearsal for critical stores) as an owned runbook step.',
      invariants: [INV.recovery, INV.owner, INV.tenant],
      risks: ['Enabling backups on a live instance can cause a short I/O pause or reboot depending on the engine.', 'Restore tests copy production data: control access and delete the copy to respect retention and residency.', 'Enabling or changing retention is a recovery-posture change and needs data-owner approval.'],
      verification: ['Create a backup and restore it into an isolated instance; compare row counts and checksums.', 'Measure actual restore time against RTO and data age against RPO.', 'Rehearse point-in-time recovery for critical stores.', 'Confirm backups sit outside the compromise boundary of the primary.'],
      recovery: { type: 'restore', procedure: 'The finding is about the ability to restore; the fix itself is additive and reverts by removing the schedule.', notes: 'No live database is touched by Unknot.' },
      blast_radius: 'high',
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'medium' },
      factors: { benefit: 5, evidence: retention === 0 ? 0.9 : 0.6, reversibility: 0.8, blast: 3, cost: 2, uncertainty: 2 },
      uncertainties: ['Restore tests recorded outside the repository are invisible; supply them as restore_test evidence.'],
      alternatives: [{ id: 'record-evidence', summary: 'If restore tests already happen, record them as evidence instead of changing infrastructure.' }],
    }));
  }
  return out;
});

export default [
  unusedIndex,
  duplicateIndex,
  hazardousMigration,
  destructiveMigration,
  backfillWithoutBatching,
  multipleWriters,
  crossBoundaryJoins,
  unboundedQuery,
  fullScanOnHotPath,
  missingConstraintCandidates,
  backupsNotRestoreTested,
];
