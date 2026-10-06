// /unknot:decompose [scope] [--target backend|frontend|auto] [--driver id]... (spec §15A.11)
//   decompose list                 saved records: stale when the graph was rebuilt since, superseded when replaced
//   decompose show <DEC-id>        one record, with its readiness table
//   decompose prune [--dry-run]    remove superseded records (never one a campaign or slice references)
//   --summary                      one line per candidate
//   --dry-run                      compute and print; write nothing, allocate no ids
//   --driver-source <id>=<url> / --driver-quote <id>=<text>   where, and in whose words, a driver was stated (repeatable)
//   --drivers-file <json>          drivers with their source and quote

import { readFileSync } from 'node:fs';
import { UnknotError } from '../../core/errors.mjs';
import { decompose } from '../../decompose/index.mjs';
import { listRecords, pruneRecords, showRecord, summaryLine } from '../../decompose/records.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export const USAGE = 'usage: unknot decompose [scope] [--target backend|frontend|auto] [--driver id]... [--driver-source id=url]... [--driver-quote id=text]... [--drivers-file json] [--summary] | list | show <DEC-id> [--json] | prune [--dry-run]';

const BOOLEAN_FLAGS = ['json', 'full', 'summary', 'dry_run'];

const cell = (v) => (v === null || v === undefined ? 'unmeasured' : String(v));

/** The routes the candidate calls or serves, with the client interfaces per route and, from a workspace map, who serves it. */
function contractsText(c, m) {
  const head = `Contracts: contracts.present ${cell(m['contracts.present'])}, clients.count ${cell(m['clients.count'])} (distinct client interfaces)`;
  const routes = c.contracts ?? [];
  if (!routes.length) return `${head}; no route found`;
  const rows = routes.map((r) => `  ${r.route}  [${r.source}]  ${r.clients} client${r.clients === 1 ? '' : 's'}: ${r.interfaces.join(', ') || '-'}${r.served_by?.length ? `  served by ${r.served_by.join(', ')}` : ''}${r.client_repositories?.length ? `  called from ${r.client_repositories.join(', ')}` : ''}${r.workspace_mapped_at ? `  (workspace map ${r.workspace_mapped_at})` : ''}`);
  return [head, ...rows].join('\n');
}

function showText(rec) {
  const c = rec.candidate;
  const m = c.metrics ?? {};
  const lines = [
    `${rec.id}  ${c.name}  (${rec.target}, ${c.modules.length} modules, naming basis: ${c.name_basis ?? 'path'})${rec.stale ? '  STALE: the graph was rebuilt since this was written' : ''}${rec.superseded ? `  SUPERSEDED: ${rec.superseded}` : ''}${rec.supersedes ? `  (replaces ${rec.supersedes}, ${Math.round((rec.supersedes_overlap ?? 0) * 100)}% of members shared)` : ''}`,
    `Treatment ${rec.treatment}, confidence ${rec.confidence}. ${rec.selection_reason ?? rec.retain_reason ?? ''}`,
    `Drivers: ${rec.driver.join(', ') || 'none recorded'}`,
  ];
  for (const p of rec.driver_provenance ?? []) lines.push(`  ${p.driver}: ${p.source ?? 'no source'}${p.quote ? ` - "${p.quote}"` : ' (no quote: the person\'s words are not recorded)'}${p.carried_from ? ` (carried from ${p.carried_from})` : ''}`);
  if (rec.scope) lines.push(`Scope: ${rec.scope.entries.length ? rec.scope.entries.join(' ') : 'everything'} (${rec.scope.matched} of ${rec.scope.total} modules)`);
  lines.push('', `Top files: ${(c.top_files ?? []).join(', ') || '-'}`);
  if (c.folded_siblings?.length) lines.push(`Folded siblings: ${c.folded_siblings.map((f) => `${f.module.replace(/^module:/, '')} (${f.reason})`).join('; ')}`);
  if (c.owners?.length) lines.push(`Owners (${c.owners.length}${m['owners.count'] > c.owners.length ? ` of ${m['owners.count']}` : ''}): ${c.owners.map((o) => `${o.owner} ${o.modules} modules, ${Math.round(o.share * 100)}%`).join(', ')}${c.unowned_modules ? `; ${c.unowned_modules} unowned` : ''}`);
  if (c.robustness_detail) lines.push(`Not robust (stability ${c.robustness_detail.stability}, need ${c.robustness_detail.threshold}): ${c.robustness_detail.broken_by.map((b) => `${b.run} (seed ${b.seed}) moved ${b.moved_total}: ${b.moved.slice(0, 3).map((x) => x.replace(/^module:/, '')).join(', ')}${b.moved_total > 3 ? ', ...' : ''}`).join('; ') || 'no single run isolates it'}`);
  lines.push(`Boundary: cohesion ${cell(m['boundary.cohesion'])}, coupling ${cell(m['boundary.coupling'])}, stability ${cell(m['boundary.stability'])}, outbound dependencies ${cell(m['boundary.outbound_dependencies'] ?? m['boundary.reverse_deps'])} (import edges from the candidate into the rest, the number treatment selection uses; into tests: ${cell(m['boundary.outbound_dependencies_test'] ?? m['boundary.reverse_deps_test'])}), reaching ${cell(m['boundary.outbound_dependency_modules'])} distinct modules (boundary.outbound_dependency_modules)`);
  const outbound = c.outbound_dependency_targets ?? c.reverse_dependency_targets;
  if (outbound?.length) lines.push(`The candidate depends on (outbound): ${outbound.map((t) => `${t.module.replace(/^module:/, '')} x${t.edges}`).join(', ')}`);
  lines.push('', contractsText(c, m));
  if (rec.drivers_not_served?.length) {
    lines.push('', 'Drivers not served:');
    for (const d of rec.drivers_not_served) lines.push(`  ${d.driver}: ${d.reason}`);
  }
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

const ENTRY = /^([A-Za-z][A-Za-z0-9_]*)=([\s\S]*)$/;

/** A repeatable `--driver-source` / `--driver-quote` value: `<id>=<text>`, or bare text for every --driver without an entry. */
function splitEntries(values, flag) {
  const byDriver = {};
  let bare;
  for (const v of values ?? []) {
    if (typeof v !== 'string' || v === 'true') throw new UnknotError('UK_SCHEMA_INVALID', `--${flag} needs a value: <id>=<text>`);
    const m = ENTRY.exec(v);
    if (m) byDriver[m[1]] = m[2];
    else bare = v;
  }
  return { byDriver, bare };
}

/** A `--drivers-file`: `[{driver, source?, quote?}]` or `{<id>: {source?, quote?}}`. */
function readDriversFile(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UnknotError('UK_SCHEMA_INVALID', `--drivers-file ${path}: ${e.code === 'ENOENT' ? 'no such file' : `not valid JSON (${e.message})`}`);
  }
  const rows = Array.isArray(data) ? data.map((d) => [d?.driver ?? d?.id, d]) : data && typeof data === 'object' ? Object.entries(data) : [];
  const out = {};
  for (const [id, d] of rows) {
    if (typeof id !== 'string' || !id || !d || typeof d !== 'object') throw new UnknotError('UK_SCHEMA_INVALID', `--drivers-file ${path}: expected [{"driver": "<id>", "source": "...", "quote": "..."}] or {"<id>": {"source": "...", "quote": "..."}}`);
    for (const k of ['source', 'quote']) if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'string') throw new UnknotError('UK_SCHEMA_INVALID', `--drivers-file ${path}: ${id}.${k} must be a string`);
    out[id] = { source: d.source ?? undefined, quote: d.quote ?? undefined };
  }
  return out;
}

/**
 * The drivers of this run and where each came from: `--driver` (repeatable), the drivers of a
 * `--drivers-file`, and `--driver-source` / `--driver-quote` as `<id>=<text>` (a bare value
 * applies to every --driver that has no entry). Flags override the file.
 */
function driversFrom(flags, config) {
  const file = flags.drivers_file === undefined ? {} : readDriversFile(typeof flags.drivers_file === 'string' ? flags.drivers_file : '');
  const drivers = [...new Set([...(flags['driver[]'] ?? []), ...Object.keys(file)])];
  const known = new Set([...drivers, ...(config.decomposition?.drivers ?? []).map((d) => d.id)]);
  const sources = splitEntries(flags['driver_source[]'], 'driver-source');
  const quotes = splitEntries(flags['driver_quote[]'], 'driver-quote');
  const byDriver = { ...file };
  for (const [kind, parts] of [['source', sources], ['quote', quotes]]) {
    for (const [id, text] of Object.entries(parts.byDriver)) {
      if (!known.has(id)) throw new UnknotError('UK_SCHEMA_INVALID', `--driver-${kind} names ${id}, which is not a driver of this run; pass --driver ${id}`);
      byDriver[id] = { ...byDriver[id], [kind]: text };
    }
  }
  return { drivers, driverProvenance: { source: sources.bare, quote: quotes.bare, byDriver } };
}

/** The line printed first when a driver's words are recorded nowhere, or null. */
const provenanceNotice = (res) => (res.driver_provenance_missing?.length
  ? `Notice: no source or quote is recorded for driver${res.driver_provenance_missing.length > 1 ? 's' : ''} ${res.driver_provenance_missing.join(', ')}, and none could be carried from an earlier record. Evidence that a driver came from the person is the safeguard behind treatment selection: pass --driver-source <id>=<url> and --driver-quote <id>=<their words> (repeatable), or --drivers-file <json>.`
  : null);

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
  const sub = ['list', 'show', 'prune'].includes(rest[0]) ? rest.shift() : null;
  if (sub === 'list') {
    const rows = listRecords(ctx);
    if (flags.json) return output(rows, { json: true });
    return output(table(rows.map((r) => ({ ...r, stale: r.stale === null ? '?' : r.stale ? 'stale' : '', superseded: r.superseded ? 'superseded' : '', replaces: r.supersedes ?? '', why: r.superseded ?? '' })), ['id', 'name', 'target', 'treatment', 'confidence', 'size', 'stale', 'superseded', 'replaces', 'why']));
  }
  if (sub === 'prune') {
    const res = pruneRecords(ctx, { dryRun: Boolean(flags.dry_run) });
    if (flags.json) return output(res, { json: true });
    const lines = [...res.removed.map((r) => `${res.dry_run ? 'would remove' : 'removed'} ${r.id}  ${r.name}: ${r.reason}`), ...res.kept.map((r) => `kept ${r.id}  ${r.name}: ${r.reason} (superseded: ${r.superseded})`)];
    return output(lines.length ? lines.join('\n') : 'nothing superseded');
  }
  if (sub === 'show') {
    if (!rest[0]) throw new UnknotError('UK_SCHEMA_INVALID', 'usage: unknot decompose show <DEC-id> [--json]');
    const rec = showRecord(ctx, rest[0]);
    return flags.json ? output(rec, { json: true }) : output(showText(rec));
  }
  const { drivers, driverProvenance } = driversFrom(flags, config);
  const opts = { config, scope: rest, target: flags.target ?? 'auto', drivers, driverProvenance, dryRun: Boolean(flags.dry_run) };
  const res = opts.dryRun ? await decompose(ctx, opts) : await withRun(ctx, cfg, 'decompose', { actor, scope: rest }, (r) => decompose(ctx, { ...opts, run: r }));
  if (res.warning) process.stderr.write(`unknot: ${res.warning}\n`);
  if (flags.summary) {
    const lines = res.details.map(summaryLine);
    if (flags.json) return output(lines, { json: true });
    const out = lines.map((l) => `${l.id}  ${l.name}  ${l.size} modules  ${l.treatment}  ${l.confidence}${l.next_rejected ? `  | ${l.next_rejected}` : ''}`);
    return output([...(provenanceNotice(res) ? [provenanceNotice(res)] : []), ...(res.warning ? [res.warning] : []), ...(out.length ? out : ['(no candidates)'])].join('\n'));
  }
  if (flags.json) return output(flags.full ? res : { ...res, details: undefined }, { json: true });
  const lines = [];
  if (provenanceNotice(res)) lines.push(provenanceNotice(res), '');
  if (res.warning) lines.push(`Warning: ${res.warning}`, '');
  lines.push(`Targets: ${res.targets.join(', ') || 'none'} · drivers: ${res.drivers.join(', ') || 'none recorded (service extraction and micro-frontends will not be offered)'}${res.dry_run ? ' · dry run: nothing written' : ''}`);
  for (const [t, a] of Object.entries(res.analyses)) {
    lines.push(`${t}: ${a.modules} modules, modularity Q=${a.modularity}, ${a.robustness.robust}/${a.robustness.communities} candidates robust (weights are heuristics)`);
  }
  lines.push('', table(res.recommendations.map((r) => ({ ...r, sequence: r.sequence.join('→') })), ['id', 'target', 'candidate', 'size', 'treatment', 'sequence', 'confidence']));
  lines.push('', res.dry_run ? 'Dry run: ids shown are the records a real run would overwrite; "new" gets an id when written.' : 'Details: unknot decompose show <DEC-id> · .unknot/decompositions/<DEC-id>.json · Next: /unknot:plan "<objective>" to turn a recommendation into a campaign.');
  output(lines.join('\n'));
}
