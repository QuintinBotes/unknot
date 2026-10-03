# Database adapter

Parses DDL, migration files, ORM schema files and user-exported catalog metadata into
graph facts (spec §14). It never connects to a database, never runs SQL and makes no
network calls. Production catalog access is the user's job (spec §14.3): export, then
point `config.evidence.db_metadata` at the files.

## Layout

| File | Purpose |
|---|---|
| `sql/lexer.mjs` | Tolerant tokenizer and statement splitter (dollar quotes, `E''`, nested comments, MySQL `DELIMITER`, T-SQL `GO`, trigger bodies) |
| `sql/parser.mjs` | DDL/DML parser, `parseSql(text, {dialect})`; unknown statements become `{kind: 'unknown', text}`, never an exception |
| `forecast.mjs` | Lock/rewrite/duration forecast per engine and version |
| `migrations.mjs` | Framework detection, ordering, per-framework statement recovery |
| `index.mjs` | The adapter: `extract`, `link`, `discover` |

## Supported engines

PostgreSQL (rules by major version: 9.x to 18), MySQL 5.7/8.0 (InnoDB online DDL),
MariaDB 10.x (shares the MySQL rules; version-specific differences are marked
medium/low confidence) and SQLite (3.25+/3.35+ ALTER limits). Any other engine is parsed
but forecast with `confidence: 'low'`.

## Supported migration frameworks

Flyway (`V`/`R`/`U`), Liquibase (XML, YAML, JSON, formatted SQL), Rails
(`db/migrate`, `db/schema.rb`), Django, Alembic (`down_revision` chain), Prisma
(`schema.prisma` and `migrations/*/migration.sql`), golang-migrate (`.up.sql`/`.down.sql`
pairs, a missing down file raises a `finding`), Knex, TypeORM, Sequelize, Atlas
(`*.hcl` schemas and `atlas.sum` directories).

DSL frameworks are read with small regex readers; each recognised operation is rewritten
as SQL and handled by the same parser and forecast, so facts from those files carry
`confidence: medium` and `source_type: inference`. Dynamic migrations (loops, helper
methods, computed table names) are invisible.

Each migration becomes `migration:<path>` with `{framework, version, order_key, has_down,
statements: [{kind, table, line, forecast}], destructive, irreversible}` and `MIGRATES`
edges to the tables it touches. `link()` restates a migration node when the answer needs
sibling files (Flyway `U` undo files, golang-migrate `down` pairs, Alembic chain depth,
Atlas directories).

## Graph produced

Nodes: `table:<schema.name>` (MySQL/SQLite: `table:<name>`), `column:`, `index:`,
`constraint:`, `view:`, `trigger:`, `routine:`, `sequence:`, `type:`, `policy:`,
`grant:`, `db_role:`, `migration:`, and from catalog exports `engine:`, `query:`, `plan:`.
Unquoted identifiers fold to lower case; quoted ones keep their case. The default
schema is `public` for PostgreSQL.

Edges: `CONTAINS`, `INDEXED_BY`, `REFERENCES` (`{columns, ref_columns, on_delete,
on_update, constraint, not_valid}`), `DERIVED_FROM`, `MIGRATES`, `AUTHORIZED_FOR`,
`DEPENDS_ON` (trigger to routine), and from `link()`: `QUERIES` / `MUTATES`
(`{line, kind, has_where}`) from `module` nodes that record `attrs.sql = [{text, line}]`,
and `JOINS_WITH` between tables joined in one statement. ORM table ids from language
adapters (`table:orders`) are re-emitted as `table:public.orders` with
`attrs.aliases = ['table:orders']`.

## Exported metadata (`discover`)

`config.evidence.db_metadata` lists files. The adapter recognises them by content; every
fact has `source_type: 'catalog'`.

### 1. PostgreSQL catalog export (JSON)

```json
{
  "engine": "postgresql",
  "version": "16.2",
  "tables": [{
    "schema": "public", "name": "orders", "estimated_rows": 52000000, "size_bytes": 41000000000,
    "columns":     [{"name": "id", "type": "bigint", "nullable": false, "default": null}],
    "indexes":     [{"name": "orders_pkey", "definition": "CREATE UNIQUE INDEX ...", "idx_scan": 90000,
                     "size_bytes": 1100000000, "unique": true, "primary": true, "valid": true}],
    "constraints": [{"name": "orders_pkey", "type": "p", "definition": "PRIMARY KEY (id)"}]
  }],
  "roles":  [{"name": "app_rw", "superuser": false, "login": true}],
  "grants": [{"grantee": "app_rw", "privilege": "SELECT", "schema": "public", "table": "orders"}]
}
```

Constraint `type` is the `pg_constraint.contype` letter (`p`, `u`, `f`, `c`, `x`);
`definition` is `pg_get_constraintdef()` output, which is parsed for columns, referenced
table and `ON DELETE`. Index analysis marks `unused_candidate` (`idx_scan = 0`, not
unique, not primary, valid), `invalid`, `duplicate_of` (same table, method, columns,
predicate and uniqueness) and `redundant_to` (a non-unique btree whose columns are a
strict prefix of another). `idx_scan` counts since the last statistics reset, so treat
`unused_candidate` as a prompt to observe over a window (spec §14.10), not a verdict.

Read-only queries a human can run, then assemble into the JSON above (for example with
`psql -At -c "select json_agg(t) from (...) t"`):

```sql
-- tables: schema, name, estimated rows, size
SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS estimated_rows,
       pg_total_relation_size(c.oid) AS size_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema');

-- columns
SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
       format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
       pg_get_expr(d.adbin, d.adrelid) AS default
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');

-- indexes with usage and size
SELECT s.schemaname AS schema, s.relname AS table, s.indexrelname AS name,
       pg_get_indexdef(s.indexrelid) AS definition, s.idx_scan,
       pg_relation_size(s.indexrelid) AS size_bytes, i.indisunique AS unique,
       i.indisprimary AS primary, i.indisvalid AS valid
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid;

-- constraints
SELECT n.nspname AS schema, c.relname AS table, k.conname AS name, k.contype AS type,
       pg_get_constraintdef(k.oid) AS definition
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema');

-- roles and table grants
SELECT rolname AS name, rolsuper AS superuser, rolcanlogin AS login FROM pg_roles
WHERE rolname !~ '^pg_';
SELECT grantee, privilege_type AS privilege, table_schema AS schema, table_name AS table,
       is_grantable
FROM information_schema.role_table_grants WHERE table_schema NOT IN ('pg_catalog', 'information_schema');
```

### 2. `pg_stat_statements` (CSV or JSON)

CSV with a header containing at least `query` and `calls` (`queryid`,
`total_exec_time` or `total_time`, `mean_exec_time` or `mean_time`, `rows` are used when
present), or a JSON array / `{"pg_stat_statements": [...]}` of the same rows. Produces
`query:<queryid>` nodes (`calls`, `mean_exec_time_ms`, `total_exec_time_ms`, `rows`,
normalised text capped at 500 characters) with `QUERIES` / `MUTATES` edges to tables.

```sql
SELECT queryid, query, calls, total_exec_time, mean_exec_time, rows
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 200;
```

Statement text is normalised by the server (`$1` placeholders) but can still be
sensitive; review before committing an export.

### 3. `EXPLAIN (FORMAT JSON)` plans

A plan file (`[{"Plan": {...}}]`) produces `plan:<path>#<n>` with
`{total_cost, startup_cost, estimated_rows, has_seq_scan, seq_scans: [{table, rows, cost,
filter}], node_types}` and `QUERIES` edges to every scanned relation
(`attrs.scan` = node type). `EXPLAIN` without `ANALYZE` plans without executing; do not
export `EXPLAIN ANALYZE` of writes from production.

## Forecast

`forecast(statement, {engine, version, table})` answers the spec §14.7 questions for one
statement: `lock_mode`, `blocks` (reads/writes), `metadata_lock_risk`, `rewrite`, `scan`,
`transactional`, `online`, `concurrently_available`, `duration`, `temporary_disk`,
`replication_lag_risk`, `cancellation`, `safer_alternative`, `rule_id`, `confidence`,
`notes` and `sources`, plus `destructive` and `breaks_old_readers`. MySQL results add
`algorithm` and `explicit_clause` (`honoured` | `rejected` | `overridden` | `null`).

Optional `table` facts sharpen the answer: `estimated_rows`, `size_bytes`,
`columns: {name: type}` (needed to decide binary-coercible type changes),
`indexed_columns`, `partitioned`, `has_valid_not_null_check`.

Covered: PostgreSQL ADD/DROP/RENAME COLUMN, defaults (volatile, stable, pre-11), ALTER
COLUMN TYPE (binary-coercible cases), SET/DROP NOT NULL (PG 12 CHECK shortcut), CHECK /
FOREIGN KEY / PRIMARY KEY / UNIQUE (plain, `NOT VALID`, `VALIDATE`, `USING INDEX`),
CREATE/DROP INDEX and REINDEX (plain vs `CONCURRENTLY`, PG 12/14 gates), partitions,
SET LOGGED/UNLOGGED, tablespaces, materialized view refresh, enum `ADD VALUE`, DROP
TABLE, TRUNCATE, VACUUM FULL, CLUSTER, DML without `WHERE`. MySQL/MariaDB online DDL:
INSTANT / INPLACE / COPY by version (8.0.12, 8.0.28, 8.0.29 thresholds), explicit
`ALGORITHM=`/`LOCK=` checks. SQLite: ADD COLUMN limits, rebuild requirements.

### Confidence model

* `high`: engine and version known, statement fully parsed, rule documented for that version.
* `medium`: the rule is documented but depends on something we may not know (current column
  type, charset, journal mode, an unspecified version for a version-stable rule), or the
  statement comes from a regex-read DSL.
* `low`: unknown engine, unknown version on a version-sensitive rule, or an unmodelled
  statement. The answer is then deliberately pessimistic.

"Online" never means "zero impact": every ALTER still queues for a metadata or table
lock, and replicas replay the same DDL, so `online: true` results still carry
`metadata_lock_risk` and `replication_lag_risk`.

Two details worth knowing: `now()` / `CURRENT_TIMESTAMP` defaults are STABLE in
PostgreSQL (evaluated once), so they are flagged `stable_function` rather than
`volatile` and do not force a rewrite on PG 11+; `gen_random_uuid()`, `random()`,
`clock_timestamp()`, `nextval()` and `serial` do.

## Known gaps

No SQL Server, Oracle or non-relational classes yet; stored-procedure bodies are not
analysed; MariaDB-specific online-DDL differences beyond instant add column are
approximated; PostgreSQL 17/18 additions are not modelled beyond what is listed above.
