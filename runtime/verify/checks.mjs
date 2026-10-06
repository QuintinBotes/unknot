// Built-in proof obligations (spec §19.1): checks the runtime executes itself, over the
// slice's staged patch and a before/after graph pair. Both graphs are built the same way
// (per-file cache plus fresh extraction of changed files, then every adapter's link), so
// a difference between them is a difference the change made.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAdapters } from '../../adapters/registry.mjs';
import { matchAny } from '../core/glob.mjs';
import { guidanceFor, loadGuidance, protectedByGuidance } from '../core/guidance.mjs';
import { isSecretPath } from '../core/paths.mjs';
import { findSecrets } from '../core/redact.mjs';
import { git } from '../apply/git.mjs';
import { diffStat } from '../apply/worktree.mjs';
import { derivedFor, sccsOf } from '../graph/derived.mjs';
import { languageOf } from '../graph/census.mjs';
import { Graph } from '../graph/graph.mjs';
import { checkDiffBudget } from '../policy/budget.mjs';
import { DEP_MANIFESTS } from '../policy/risk.mjs';
import { pushAll } from '../core/arrays.mjs';

/** Paths changed between the baseline and the staged worktree, with their status. */
export function changedPaths(worktree, base) {
  const out = git(worktree, ['diff', '--cached', '--name-status', '-z', '--no-renames', base]).stdout.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < out.length; i += 2) changes.push({ status: out[i], path: out[i + 1] });
  return changes;
}

async function extractAll(adapters, files, readText) {
  const byFile = new Map();
  const errors = [];
  for (const f of files) {
    const text = readText(f.path);
    if (text === null) continue;
    const entry = { path: f.path, size: text.length, language: languageOf(f.path), kind: 'source', blob: null };
    for (const a of adapters) {
      if (!a.extract || !matchAny(f.path, a.capabilities?.files ?? [])) continue;
      try {
        const facts = a.extract(entry, text, { options: {} }) ?? [];
        byFile.set(f.path, [...(byFile.get(f.path) ?? []), ...facts]);
        if (facts.some((x) => x.attrs?.parse_quality === 'degraded')) errors.push({ path: f.path, adapter: a.id, error: 'parse degraded' });
      } catch (err) {
        errors.push({ path: f.path, adapter: a.id, error: String(err?.message ?? err) });
      }
    }
  }
  return { byFile, errors };
}

/**
 * Build the before/after graphs for a slice.
 * @returns {Promise<{before: Graph, after: Graph, parseErrors: object[], notes: string[]}>}
 */
export async function graphPair(ctx, { config, worktree, base, changes }) {
  const { loaded } = await loadAdapters(config);
  const adapters = loaded.filter((a) => a.kind === 'language' || a.id === 'database');
  const notes = [];
  if ((ctx.store.meta('mapped_commit') || null) !== base) notes.push(`the cached graph was mapped at ${ctx.store.meta('mapped_commit') || 'unknown'}, not the baseline ${base}; unchanged files use cached facts`);
  const cached = new Map();
  for (const r of ctx.store.db.prepare('SELECT path, facts FROM file_index').iterate()) {
    cached.set(r.path, [...(cached.get(r.path) ?? []), ...JSON.parse(r.facts)]);
  }
  const touched = changes.filter((c) => !isSecretPath(c.path));
  const beforeFiles = touched.filter((c) => c.status !== 'A');
  const afterFiles = touched.filter((c) => c.status !== 'D');
  const showBase = (p) => {
    const r = git(ctx.root, ['show', `${base}:${p}`], { check: false });
    return r.status === 0 ? r.stdout : null;
  };
  const readWt = (p) => {
    try {
      return readFileSync(join(worktree, p), 'utf8');
    } catch {
      return null;
    }
  };
  const b = await extractAll(adapters, beforeFiles, showBase);
  const a = await extractAll(adapters, afterFiles, readWt);
  const build = (overrides, removed) => {
    const byFile = new Map(cached);
    for (const p of removed) byFile.delete(p);
    for (const c of touched) byFile.delete(c.path);
    for (const [p, f] of overrides) byFile.set(p, f);
    const facts = [...byFile.values()].flat();
    for (const ad of loaded) {
      if (!ad.link) continue;
      try {
        pushAll(facts, (ad.link({ files: new Map([...byFile.keys()].map((p) => [p, { path: p, language: languageOf(p) }])), factsByFile: byFile, options: config.adapters?.[ad.id] ?? {} }) ?? []));
      } catch (err) {
        notes.push(`${ad.id} link failed during verification: ${err.message}`);
      }
    }
    return Graph.fromFacts(facts);
  };
  return {
    before: build(b.byFile, touched.filter((c) => c.status === 'A').map((c) => c.path)),
    after: build(a.byFile, touched.filter((c) => c.status === 'D').map((c) => c.path)),
    parseErrors: a.errors,
    notes,
  };
}

const sccKey = (c) => [...c].sort().join('|');

/** Each check returns {verdict: 'pass'|'fail'|'inconclusive', detail, data}. */
export const CHECKS = {
  scope({ ctx, slice, config, changes }) {
    const bad = [];
    const guide = loadGuidance(ctx.root);
    const inc = slice.body.scope.include;
    const exc = slice.body.scope.exclude;
    for (const c of changes) {
      if (matchAny(c.path, exc) || (inc.length && !matchAny(c.path, inc))) bad.push(`${c.path}: outside slice scope`);
      else if (matchAny(c.path, config.generated_paths ?? []) || matchAny(c.path, ['**/vendor/**', '**/node_modules/**', '**/dist/**'])) bad.push(`${c.path}: generated or vendored`);
      else if (matchAny(c.path, config.protected_paths ?? [], { nocase: true }) && !['high', 'critical'].includes(slice.risk)) bad.push(`${c.path}: protected path in a ${slice.risk}-risk slice`);
      for (const h of protectedByGuidance(guidanceFor(ctx.root, c.path, guide), [c.path])) bad.push(`${c.path}: ${h.file}:${h.line} says not to edit it ("${h.sentence}")`);
      if (isSecretPath(c.path)) bad.push(`${c.path}: credential path`);
      if (matchAny(c.path, DEP_MANIFESTS)) {
        if (config.security.dependency_changes === 'forbidden') bad.push(`${c.path}: dependency changes are forbidden (security.dependency_changes)`);
        else if (config.security.dependency_changes === 'approval_required' && !(slice.body.changes ?? []).some((x) => x.path === c.path)) {
          bad.push(`${c.path}: dependency change not declared in the approved plan`);
        }
      }
    }
    return bad.length ? { verdict: 'fail', detail: bad.join('; '), data: { violations: bad } } : { verdict: 'pass', detail: `${changes.length} changed path(s) within scope`, data: { paths: changes.map((c) => c.path) } };
  },
  'diff-budget'({ slice, config }) {
    const stat = diffStat(slice.worktree);
    const v = checkDiffBudget({ ...config.limits, ...slice.body.budgets }, stat);
    return { verdict: v.ok ? 'pass' : 'fail', detail: v.ok ? `${stat.files} files, ${stat.lines} lines` : v.problems.join('; '), data: stat };
  },
  secrets({ patch, config }) {
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    const hits = findSecrets(added, { extraPatterns: config.security.redact_patterns });
    return hits.length ? { verdict: 'fail', detail: `${hits.length} credential-like value(s) added (${[...new Set(hits.map((h) => h.kind))].join(', ')})`, data: { kinds: hits.map((h) => h.kind) } } : { verdict: 'pass', detail: 'no credential-like values in added lines', data: {} };
  },
  parse({ pair }) {
    return pair.parseErrors.length ? { verdict: 'fail', detail: pair.parseErrors.map((e) => `${e.path} [${e.adapter}]: ${e.error}`).join('; '), data: pair.parseErrors } : { verdict: 'pass', detail: 'changed files extract cleanly', data: {} };
  },
  cycles({ pair }) {
    const before = new Set(sccsOf(pair.before).map((c) => sccKey(c.members)));
    const after = sccsOf(pair.after).map((c) => c.members);
    const added = after.filter((c) => !before.has(sccKey(c)) && ![...before].some((k) => c.every((x) => k.split('|').includes(x))));
    return added.length ? { verdict: 'fail', detail: `new dependency cycle(s): ${added.map((c) => c.slice(0, 6).join(' → ')).join('; ')}`, data: { cycles: added } } : { verdict: 'pass', detail: `no new cycles (${after.length} pre-existing)`, data: {} };
  },
  api({ pair, changes }) {
    const removed = [];
    const unused = [];
    for (const c of changes) {
      const id = `module:${c.path}`;
      const was = pair.before.node(id);
      if (!was) continue;
      const now = pair.after.node(id);
      // The stored public surface; a public member the graph marks declared-only was unused anywhere in this repository.
      const surface = (g) => derivedFor(g, 'public_surface').find((r) => r.key === id)?.body;
      const exported = new Set(surface(pair.after)?.exports ?? []);
      for (const name of surface(pair.before)?.exports ?? []) if (!exported.has(name)) removed.push(`${c.path}: export ${name}`);
      const free = new Set(derivedFor(pair.before, 'declared_only').filter((r) => r.body.from === id && r.body.visibility === 'public').flatMap((r) => String(r.body.member ?? '').split(', ')));
      const kept = new Set(surface(pair.after)?.public_members ?? []);
      for (const name of surface(pair.before)?.public_members ?? []) {
        if (kept.has(name)) continue;
        (free.has(name) ? unused : removed).push(`${c.path}: member ${name}`);
      }
      const eps = (g) => new Set(g.out(id, 'EXPOSES').map((e) => e.to));
      const after = now ? eps(pair.after) : new Set();
      for (const ep of eps(pair.before)) if (!after.has(ep)) removed.push(`${c.path}: endpoint ${ep.slice(9)}`);
    }
    const note = unused.length ? `public but unused in this repository; consumers outside it are not visible: ${unused.slice(0, 10).join('; ')}` : null;
    if (removed.length) return { verdict: 'fail', detail: `public surface removed: ${removed.slice(0, 10).join('; ')}`, data: { removed, ...(unused.length && { unused_public: unused }) } };
    return { verdict: 'pass', detail: note ? `only unused public members removed (${note})` : 'exports and endpoints of changed modules preserved', data: unused.length ? { unused_public: unused, note } : {} };
  },
  complexity({ pair, changes, config }) {
    const allowed = config.quality.max_complexity_increase ?? 0;
    const worse = [];
    let delta = 0;
    for (const c of changes) {
      for (const n of pair.after.nodes().filter((x) => (x.type === 'function' || x.type === 'method') && x.id.includes(`:${c.path}#`))) {
        const was = pair.before.node(n.id);
        if (!was) continue;
        const d = (n.attrs.cyclomatic ?? 0) - (was.attrs.cyclomatic ?? 0);
        delta += d;
        if (d > allowed) worse.push(`${n.id.split('#')[1]} +${d}`);
      }
    }
    return worse.length ? { verdict: 'fail', detail: `complexity increased: ${worse.join(', ')}`, data: { worse, net: delta } } : { verdict: 'pass', detail: `net cyclomatic change ${delta}`, data: { net: delta } };
  },
  async 'infra-plan'({ ctx, slice }) {
    const infra = slice.body.infra;
    if (!infra?.plan_path) return { verdict: 'inconclusive', detail: 'no saved plan attached to the slice (infra.plan_path)', data: {} };
    const { normalizePlan } = await import('../../adapters/infrastructure/iac/plan.mjs');
    const n = normalizePlan(JSON.parse(readFileSync(join(ctx.root, infra.plan_path), 'utf8')), { workspace: infra.workspace, environment: infra.environment, state_serial: infra.state_serial });
    const problems = [];
    if (infra.plan_hash && n.plan_hash !== infra.plan_hash) problems.push(`plan hash ${n.plan_hash} differs from the approved ${infra.plan_hash}`);
    if ((n.actions.delete || n.actions.replace) && !slice.body.surfaces?.destructive_infra) problems.push(`plan deletes ${n.actions.delete} and replaces ${n.actions.replace} resource(s) but the slice was not approved as destructive`);
    return { verdict: problems.length ? 'fail' : 'pass', detail: problems.join('; ') || `plan ${n.plan_hash.slice(0, 19)}…: ${JSON.stringify(n.actions)}`, data: { plan_hash: n.plan_hash, actions: n.actions, blast_radius: n.blast_radius } };
  },
};
