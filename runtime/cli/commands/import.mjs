// unknot import runtime <file> [--source <label>]
// unknot import database-stats <file> [--format pg|sqlserver|mysql|normalised] [--source <label>] [--window <w>]
// Reads a table of call volumes, latency and errors (docs/runtime-evidence.md, "Import
// table"), matches each caller and callee to graph nodes, stores the rows with their
// window, source and import time, and re-projects the graph so decompose sees them.
// Reading a named file is not a human-only act; the file must lie inside the repository,
// outside `.unknot/`, and not be a credential path.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import { UnknotError } from '../../core/errors.mjs';
import { nowISO } from '../../core/clock.mjs';
import { isSecretPath, resolveInside, toPosix } from '../../core/paths.mjs';
import { mapRepository } from '../../graph/builder.mjs';
import { Graph } from '../../graph/graph.mjs';
import { loadImports, loadStatsImports, saveImport, saveStatsImport } from '../../graph/runtime-imports.mjs';
import { STATS_COLUMNS, STATS_FORMATS, readStats } from '../../../adapters/database/stats/format.mjs';
import { matchReport } from '../../../adapters/database/stats/imports.mjs';
import { IMPORT_COLUMNS, SOURCE_LABEL, matchRows, parseImport } from '../../../adapters/runtime/imports.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export const USAGE = `usage: unknot import runtime <file> [--source <label>] [--json]
       unknot import database-stats <file> [--format ${STATS_FORMATS.join('|')}] [--source <label>] [--window <w>] [--json]
  file    CSV or JSON rows with the columns ${IMPORT_COLUMNS.join(', ')} (see docs/runtime-evidence.md)
  --source  names the data's origin; importing again with the same source replaces the earlier import (default: the file name)
  database-stats reads query statistics exported from a database (columns ${STATS_COLUMNS.join(', ')}; see docs/runtime-evidence.md)
  --format  which reader to use (default: detected from the columns)
  --window  the window of rows that carry none: an ISO interval a/b or a duration such as P7D`;

const MAX_BYTES = 64 * 1024 * 1024;
const LISTED = 20;

/** The repository-relative path of a file the person named, or a refusal. */
function inputPath(ctx, file) {
  const { abs, rel } = resolveInside(ctx.root, file);
  const state = toPosix(relative(ctx.root, ctx.paths.base));
  const inState = rel === '.unknot' || rel.startsWith('.unknot/') || (!state.startsWith('..') && !isAbsolute(state) && state !== '' && (rel === state || rel.startsWith(`${state}/`)));
  if (inState) throw new UnknotError('UK_POLICY_DENIED', `${rel} is inside Unknot's own state directory; import a file you exported elsewhere in the repository`);
  if (isSecretPath(rel)) throw new UnknotError('UK_POLICY_DENIED', `${rel} is a credential path`);
  return { abs, rel };
}

export async function run({ positional, flags }) {
  const [what, file, ...extra] = positional;
  if (what === 'database-stats' && file && !extra.length) return runStats({ file, flags });
  if (what !== 'runtime' || !file || extra.length) throw new UnknotError('UK_CONFIG_INVALID', USAGE);
  const source = flags.source === undefined || flags.source === true ? null : String(flags.source);
  if (source !== null && !SOURCE_LABEL.test(source)) throw new UnknotError('UK_CONFIG_INVALID', '--source must be 1-64 characters from A-Z a-z 0-9 . _ @ -');
  const { ctx, cfg, config, actor } = open(flags);
  const { abs, rel } = inputPath(ctx, file);
  const size = statSync(abs).size;
  if (size > MAX_BYTES) throw new UnknotError('UK_BUDGET_EXCEEDED', `${rel} is ${size} bytes, over ${MAX_BYTES}`);
  const text = readFileSync(abs, 'utf8');
  const label = source ?? basename(rel).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 64);
  const now = nowISO();
  let parsed;
  try {
    parsed = parseImport(text, { now });
  } catch (err) {
    throw new UnknotError('UK_SCHEMA_INVALID', `${rel}: ${err.message}`);
  }
  if (parsed.invalid.length) {
    const shown = parsed.invalid.slice(0, LISTED).map((r) => `row ${r.row}: ${r.error}`).join('\n  ');
    throw new UnknotError('UK_SCHEMA_INVALID', `${rel}: ${parsed.invalid.length} of ${parsed.total} rows are invalid; nothing was imported.\n  ${shown}${parsed.invalid.length > LISTED ? `\n  (+${parsed.invalid.length - LISTED} more)` : ''}`, { details: { invalid: parsed.invalid.slice(0, LISTED), invalid_count: parsed.invalid.length } });
  }
  if (!parsed.rows.length) throw new UnknotError('UK_SCHEMA_INVALID', `${rel} has no rows`);
  if (!ctx.store.meta('generation')) throw new UnknotError('UK_NOT_INITIALIZED', 'there is no graph to match against; run unknot map first');

  const digest = createHash('sha256').update(text).digest('hex');
  const earlier = loadImports(ctx.store).find((e) => e.source === label);
  const unchanged = earlier?.digest === digest;
  const entry = unchanged ? earlier : { source: label, file: rel, digest, imported_at: now, rows: parsed.rows };
  if (!unchanged) saveImport(ctx.store, entry);

  // Re-project so the graph holds the rows, unless the same file was already imported.
  if (!unchanged) {
    await withRun(ctx, cfg, 'map', { actor, scope: [] }, (r) => mapRepository(ctx, { config, configDigest: cfg.digest, run: r, scope: [], history: true }));
  }
  const options = config.adapters?.runtime ?? {};
  const { matched, unmatched } = matchRows(Graph.fromStore(ctx.store), entry.rows, { serviceMap: options.service_map });
  const edges = new Set(matched.map((m) => `${m.from}\0${m.to}`));
  const summary = {
    source: label,
    file: rel,
    status: unchanged ? 'unchanged' : earlier ? 'replaced' : 'imported',
    imported_at: entry.imported_at,
    rows: entry.rows.length,
    matched: matched.length,
    unmatched: unmatched.length,
    edges: edges.size,
    calls_matched: matched.reduce((n, m) => n + m.count, 0),
    unmatched_rows: unmatched.slice(0, LISTED).map((u) => ({ row: u.row.line, caller: u.row.caller, callee: u.row.callee, why: u.why })),
  };
  if (flags.json) return output(summary, { json: true });
  const lines = [
    `${unchanged ? 'Already imported (unchanged)' : earlier ? 'Replaced the earlier import of' : 'Imported'} ${rel} as source "${label}": ${summary.rows} rows, ${summary.matched} matched onto ${summary.edges} graph edge(s) (${summary.calls_matched} calls), ${summary.unmatched} unmatched.`,
  ];
  if (unmatched.length) {
    lines.push('', `Unmatched rows${unmatched.length > LISTED ? ` (first ${LISTED} of ${unmatched.length})` : ''}:`, table(summary.unmatched_rows, ['row', 'caller', 'callee', 'why']));
  }
  output(lines.join('\n'));
}

/** unknot import database-stats: validate, store, re-project, and report what matched. */
async function runStats({ file, flags }) {
  const source = flags.source === undefined || flags.source === true ? null : String(flags.source);
  if (source !== null && !SOURCE_LABEL.test(source)) throw new UnknotError('UK_CONFIG_INVALID', '--source must be 1-64 characters from A-Z a-z 0-9 . _ @ -');
  const format = flags.format === undefined || flags.format === true ? 'auto' : String(flags.format);
  if (format !== 'auto' && !STATS_FORMATS.includes(format)) throw new UnknotError('UK_CONFIG_INVALID', `--format must be one of ${STATS_FORMATS.join(', ')}`);
  const window = flags.window === undefined || flags.window === true ? null : String(flags.window);
  const { ctx, cfg, config, actor } = open(flags);
  const { abs, rel } = inputPath(ctx, file);
  const size = statSync(abs).size;
  if (size > MAX_BYTES) throw new UnknotError('UK_BUDGET_EXCEEDED', `${rel} is ${size} bytes, over ${MAX_BYTES}`);
  const text = readFileSync(abs, 'utf8');
  const label = source ?? basename(rel).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 64);
  const now = nowISO();
  let parsed;
  try {
    parsed = readStats(text, { format, now, window });
  } catch (err) {
    throw new UnknotError('UK_SCHEMA_INVALID', `${rel}: ${err.message}`);
  }
  const noWindow = parsed.rows.filter((r) => !r.window);
  for (const r of noWindow) parsed.invalid.push({ row: r.line, error: 'window is missing (give the column or --window)' });
  if (parsed.invalid.length) {
    const bad = parsed.invalid.sort((a, b) => a.row - b.row);
    const shown = bad.slice(0, LISTED).map((r) => `row ${r.row}: ${r.error}`).join('\n  ');
    throw new UnknotError('UK_SCHEMA_INVALID', `${rel}: ${bad.length} of ${parsed.total} rows are invalid; nothing was imported.\n  ${shown}${bad.length > LISTED ? `\n  (+${bad.length - LISTED} more)` : ''}`, { details: { invalid: bad.slice(0, LISTED), invalid_count: bad.length } });
  }
  if (!parsed.rows.length) throw new UnknotError('UK_SCHEMA_INVALID', `${rel} has no rows`);
  if (!ctx.store.meta('generation')) throw new UnknotError('UK_NOT_INITIALIZED', 'there is no graph to match against; run unknot map first');

  const digest = createHash('sha256').update(text).update(`\0${format}\0${window ?? ''}`).digest('hex');
  const earlier = loadStatsImports(ctx.store).find((e) => e.source === label);
  const unchanged = earlier?.digest === digest;
  const entry = unchanged ? earlier : { source: label, file: rel, digest, imported_at: now, format: parsed.format, rows: parsed.rows, transactions: parsed.transactions };
  if (!unchanged) {
    saveStatsImport(ctx.store, entry);
    await withRun(ctx, cfg, 'map', { actor, scope: [] }, (r) => mapRepository(ctx, { config, configDigest: cfg.digest, run: r, scope: [], history: true }));
  }
  const report = matchReport(entry, Graph.fromStore(ctx.store));
  const unparsed = entry.rows.filter((r) => !r.parsed).length;
  const summary = {
    source: label,
    file: rel,
    format: entry.format,
    status: unchanged ? 'unchanged' : earlier ? 'replaced' : 'imported',
    imported_at: entry.imported_at,
    statements: entry.rows.length,
    statements_matched: report.statements,
    tables_matched: report.tables_matched,
    tables_unmatched: report.tables_unmatched.slice(0, LISTED),
    tables_unmatched_count: report.tables_unmatched.length,
    statements_unparsed: unparsed,
    transaction_table_pairs: report.transaction_pairs,
  };
  if (flags.json) return output(summary, { json: true });
  const lines = [
    `${unchanged ? 'Already imported (unchanged)' : earlier ? 'Replaced the earlier import of' : 'Imported'} ${rel} as source "${label}" (${summary.format}): ${summary.statements} statements, ${summary.statements_matched} touch a table in the graph (${summary.tables_matched.length} table(s)), ${summary.tables_unmatched_count} table name(s) unmatched, ${unparsed} statement(s) the extractor could not read, ${summary.transaction_table_pairs} table pair(s) written in one transaction.`,
  ];
  if (report.tables_unmatched.length) {
    lines.push('', `Unmatched tables${report.tables_unmatched.length > LISTED ? ` (first ${LISTED} of ${report.tables_unmatched.length})` : ''}:`, table(summary.tables_unmatched, ['table', 'statements']));
  }
  output(lines.join('\n'));
}
