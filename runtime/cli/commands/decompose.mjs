// /unknot:decompose [scope] [--target backend|frontend|auto] [--driver id]... (spec §15A.11)
//   decompose list                 saved records, stale when the graph was rebuilt since
//   decompose show <DEC-id>        one record, with its readiness table
//   --summary                      one line per candidate
//   --dry-run                      compute and print; write nothing, allocate no ids
//   --driver-source / --driver-quote   where, and in whose words, the --driver was stated

import { UnknotError } from '../../core/errors.mjs';
import { decompose } from '../../decompose/index.mjs';
import { listRecords, showRecord, summaryLine } from '../../decompose/records.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

const BOOLEAN_FLAGS = ['json', 'full', 'summary', 'dry_run'];

const cell = (v) => (v === null || v === undefined ? 'unmeasured' : String(v));

function showText(rec) {
  const c = rec.candidate;
  const m = c.metrics ?? {};
  const lines = [
    `${rec.id}  ${c.name}  (${rec.target}, ${c.modules.length} modules, naming basis: ${c.name_basis ?? 'path'})${rec.stale ? '  STALE: the graph was rebuilt since this was written' : ''}`,
    `Treatment ${rec.treatment}, confidence ${rec.confidence}. ${rec.selection_reason ?? rec.retain_reason ?? ''}`,
    `Drivers: ${rec.driver.join(', ') || 'none recorded'}`,
  ];
  for (const p of rec.driver_provenance ?? []) lines.push(`  ${p.driver}: ${p.source ?? 'no source'}${p.quote ? ` - "${p.quote}"` : ' (no quote: the person\'s words are not recorded)'}`);
  if (rec.scope) lines.push(`Scope: ${rec.scope.entries.length ? rec.scope.entries.join(' ') : 'everything'} (${rec.scope.matched} of ${rec.scope.total} modules)`);
  lines.push('', `Top files: ${(c.top_files ?? []).join(', ') || '-'}`);
  lines.push(`Boundary: cohesion ${cell(m['boundary.cohesion'])}, coupling ${cell(m['boundary.coupling'])}, stability ${cell(m['boundary.stability'])}, reverse deps ${cell(m['boundary.reverse_deps'])} (tests: ${cell(m['boundary.reverse_deps_test'])})`);
  if (c.reverse_dependency_targets?.length) lines.push(`Reverse dependency targets: ${c.reverse_dependency_targets.map((t) => `${t.module.replace(/^module:/, '')} x${t.edges}`).join(', ')}`);
  if (rec.favoring_signals.length) {
    lines.push('', 'Favouring signals:');
    for (const f of rec.favoring_signals) lines.push(`  ${f.signal}=${f.value}  [${f.source}]  evidence: ${(f.evidence ?? []).slice(0, 5).map((e) => e.replace(/^module:/, '')).join(', ') || '-'}${(f.evidence ?? []).length > 5 ? ` (+${f.evidence.length - 5})` : ''}`);
  }
  if (rec.rejected_treatments.length) {
    lines.push('', 'Rejected:');
    for (const r of rec.rejected_treatments) lines.push(`  ${r.treatment}: ${r.reason}`);
  }
  // The full table is in the record (--json); the text view shows the two extraction steps.
  const rows = (rec.readiness ?? []).filter((r) => r.treatment === 'T3' || r.treatment === 'T2')
    .map((r) => ({ treatment: r.treatment, kind: r.kind, signal: r.signal, value: cell(r.value), need: `${r.op} ${r.threshold}`, met: r.met === null ? '?' : r.met ? 'yes' : 'no', missing_evidence: r.missing_evidence ?? '' }));
  if (rows.length) lines.push('', 'Readiness (contraindications are met when the predicate holds):', table(rows, ['treatment', 'kind', 'signal', 'value', 'need', 'met', 'missing_evidence']));
  if (rec.evidence_gaps.length) lines.push('', 'Evidence gaps:', ...rec.evidence_gaps.map((g) => `  ${g}`));
  return lines.join('\n');
}

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  const rest = [...positional];
  // A flag with no value takes the next word: `--summary src/x` must keep `src/x` as scope.
  for (const k of BOOLEAN_FLAGS) {
    if (typeof flags[k] === 'string' && flags[k] !== 'true' && flags[k] !== 'false') {
      rest.push(flags[k]);
      flags[k] = true;
    }
  }
  const sub = rest[0] === 'list' || rest[0] === 'show' ? rest.shift() : null;
  if (sub === 'list') {
    const rows = listRecords(ctx);
    if (flags.json) return output(rows, { json: true });
    return output(table(rows.map((r) => ({ ...r, stale: r.stale === null ? '?' : r.stale ? 'stale' : '' })), ['id', 'name', 'target', 'treatment', 'confidence', 'size', 'stale']));
  }
  if (sub === 'show') {
    if (!rest[0]) throw new UnknotError('UK_SCHEMA_INVALID', 'usage: unknot decompose show <DEC-id> [--json]');
    const rec = showRecord(ctx, rest[0]);
    return flags.json ? output(rec, { json: true }) : output(showText(rec));
  }
  const drivers = flags['driver[]'] ?? [];
  const opts = { config, scope: rest, target: flags.target ?? 'auto', drivers, driverProvenance: { source: typeof flags.driver_source === 'string' ? flags.driver_source : undefined, quote: typeof flags.driver_quote === 'string' ? flags.driver_quote : undefined }, dryRun: Boolean(flags.dry_run) };
  const res = opts.dryRun ? await decompose(ctx, opts) : await withRun(ctx, cfg, 'decompose', { actor, scope: rest }, (r) => decompose(ctx, { ...opts, run: r }));
  if (res.warning) process.stderr.write(`unknot: ${res.warning}\n`);
  if (flags.summary) {
    const lines = res.details.map(summaryLine);
    if (flags.json) return output(lines, { json: true });
    const out = lines.map((l) => `${l.id}  ${l.name}  ${l.size} modules  ${l.treatment}  ${l.confidence}${l.next_rejected ? `  | ${l.next_rejected}` : ''}`);
    return output([...(res.warning ? [res.warning] : []), ...(out.length ? out : ['(no candidates)'])].join('\n'));
  }
  if (flags.json) return output(flags.full ? res : { ...res, details: undefined }, { json: true });
  const lines = [];
  if (res.warning) lines.push(`Warning: ${res.warning}`, '');
  lines.push(`Targets: ${res.targets.join(', ') || 'none'} · drivers: ${res.drivers.join(', ') || 'none recorded (service extraction and micro-frontends will not be offered)'}${res.dry_run ? ' · dry run: nothing written' : ''}`);
  for (const [t, a] of Object.entries(res.analyses)) {
    lines.push(`${t}: ${a.modules} modules, modularity Q=${a.modularity}, ${a.robustness.robust}/${a.robustness.communities} candidates robust (weights are heuristics)`);
  }
  lines.push('', table(res.recommendations.map((r) => ({ ...r, sequence: r.sequence.join('→') })), ['id', 'target', 'candidate', 'size', 'treatment', 'sequence', 'confidence']));
  lines.push('', res.dry_run ? 'Dry run: ids shown are the records a real run would overwrite; "new" gets an id when written.' : 'Details: unknot decompose show <DEC-id> · .unknot/decompositions/<DEC-id>.json · Next: /unknot:plan "<objective>" to turn a recommendation into a campaign.');
  output(lines.join('\n'));
}
