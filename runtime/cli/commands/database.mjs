// /unknot:database [scope] — read-only: database ownership, schema, migration and recovery
// analysis (spec §14). Detector findings plus an inventory read from the graph. Required
// invariants (§14.5) are listed as declared or missing; Unknot never invents a missing one.

import { runDomainReport, kv } from '../../artifacts/domain-report.mjs';
import { catalogEvidenceAge, databaseInventory } from '../../artifacts/reports.mjs';
import { table } from '../util.mjs';

function render(inv) {
  const out = [];
  out.push(`Engines: ${inv.engines.length ? inv.engines.map((e) => `${e.name}${e.version ? ` ${e.version}` : ''}`).join(', ') : 'none declared in the graph'}`);
  out.push(`Migrations: ${inv.migrations.total}`, kv(inv.migrations.by_framework));
  out.push('', `Tables: ${inv.tables.total} (${inv.tables.with_writers} with recorded writers)`);
  const groups = Object.entries(inv.writers_by_group);
  if (groups.length) out.push('Writers by module group:', ...groups.map(([g, t]) => `  ${g}: ${t.slice(0, 8).join(', ')}${t.length > 8 ? `, +${t.length - 8} more` : ''}`));
  out.push('', `Shared-writer tables: ${inv.shared_writer_tables.length}`);
  if (inv.shared_writer_tables.length) out.push(table(inv.shared_writer_tables.map((t) => ({ table: t.table, writers: t.writers.join(', ') })), ['table', 'writers']));
  out.push('', `Hazardous migrations: ${inv.hazardous_migrations.length}`);
  for (const m of inv.hazardous_migrations.slice(0, 15)) {
    out.push(`  ${m.path ?? m.id} [${m.framework ?? 'unknown framework'}]: ${m.hazards.join('; ')}`);
    for (const f of m.forecasts.slice(0, 3)) out.push(`    ${f.statement}${f.table ? ` on ${f.table}` : ''}: lock ${f.lock_mode ?? 'unknown'}, rewrite ${f.rewrite ?? 'unknown'}, scan ${f.scan ?? 'unknown'}${f.safer_alternative ? `; safer: ${f.safer_alternative}` : ''}`);
  }
  const c = inv.catalog_evidence;
  out.push('', c.facts ? `Catalog evidence: ${c.facts} fact(s), newest ${c.newest} (${c.age_days} day(s) old)` : 'Catalog evidence: none imported (statistics, row counts and index usage are unknown)');
  out.push('', `Required invariants (spec 14.5): ${inv.invariants.filter((i) => i.status === 'declared').length} declared, ${inv.missing_invariants.length} missing`);
  out.push(table(inv.invariants.map((i) => ({ invariant: i.title, status: i.status, source: i.source ?? '-' })), ['invariant', 'status', 'source']));
  if (inv.missing_invariants.length) out.push('Missing objectives must be stated by a human before a persistent-data campaign; Unknot does not infer them.');
  return out.join('\n');
}

export async function run(args) {
  return runDomainReport({
    command: 'database',
    domain: 'database',
    args,
    build: ({ graph, ctx, config }) => databaseInventory(graph, { config, catalog: catalogEvidenceAge(ctx) }),
    render,
  });
}
