// The map pipeline (spec §9.4, §9.5): census → per-file extraction (cached by path, blob,
// adapter version and options digest; parallel in workers) → cross-file linking →
// whole-repository discovery (evidence imports) → git history → projection.
//
// Failure is explicit (spec §22.2): a file an adapter could not process is listed, and the
// map reports `partial` rather than pretending to be complete.

import { readFileSync, statSync } from 'node:fs';
import { canonicalJSON, digest } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { matchAny } from '../core/glob.mjs';
import { isSecretPath, resolveInside } from '../core/paths.mjs';
import { redactDeep } from '../core/redact.mjs';
import { loadAdapters } from '../../adapters/registry.mjs';
import { git } from '../apply/git.mjs';
import { adapterExec } from '../broker/broker.mjs';
import { charge } from '../policy/budget.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { analysable, census, readEntry } from './census.mjs';
import { assertFact, edgeFact, edgeId, factId, NODE_TYPES, nodeFact, prov } from './facts.mjs';
import { churn, coChange, GIT_LOG_ARGS, parseGitLog } from './history.mjs';
import { defaultWorkers, extractParallel } from './pool.mjs';
import { pushAll } from '../core/arrays.mjs';

const PARALLEL_THRESHOLD = 400;
const MAX_FACTS_PER_FILE = 5000;
const COMMIT_CHUNK = 5000;

function optionsDigest(adapter, config) {
  return digest({ v: adapter.version, options: config.adapters?.[adapter.id] ?? {} });
}

/** Read an evidence file the user listed in config.evidence, refusing escapes and secrets. */
function evidenceReader(ctx, config) {
  return (path) => {
    const { abs, rel } = resolveInside(ctx.root, path);
    if (isSecretPath(rel)) throw new UnknotError('UK_POLICY_DENIED', `${rel} is a credential path`);
    const size = statSync(abs).size;
    const max = Math.max(config.limits.max_file_bytes ?? 0, 256 * 1024 * 1024);
    if (size > max) throw new UnknotError('UK_BUDGET_EXCEEDED', `${rel} is ${size} bytes, over ${max}`);
    return readFileSync(abs, 'utf8');
  };
}

/**
 * @param {object} ctx project context
 * @param {{config: object, configDigest: string, run?: object, scope?: string[], only?: string[], history?: boolean}} opts
 */
async function mapRepositoryInner(ctx, { config, configDigest, run = null, scope = [], only = null, history = true, adapters = null }) {
  const t0 = Date.now();
  const observedAt = nowISO();
  const cen = census(ctx.root, { config, scope });
  const commit = cen.commit;
  // `adapters` replaces the registry; tests use it to stand in a failing extractor.
  const { loaded, unavailable } = adapters ? { loaded: adapters, unavailable: [] } : await loadAdapters(config, only);
  const workers = defaultWorkers(config.limits.workers);
  const perFile = new Map(); // path → facts (all adapters)
  const failures = [];
  const stats = { files: cen.files.length, by_kind: cen.byKind, cached: 0, extracted: 0, adapters: {} };
  const filesByPath = new Map(cen.files.map((f) => [f.path, f]));
  const getIndex = ctx.store.db.prepare('SELECT blob, adapter_version, config_digest, facts FROM file_index WHERE path = ? AND adapter = ?');
  const putIndex = ctx.store.db.prepare('INSERT OR REPLACE INTO file_index(path, adapter, adapter_version, config_digest, blob, facts) VALUES (?, ?, ?, ?, ?, ?)');

  const addFacts = (path, facts) => {
    let list = perFile.get(path);
    if (!list) perFile.set(path, (list = []));
    list.push(...facts);
  };

  for (const adapter of loaded) {
    if (!adapter.extract && !adapter.extractBatch) continue;
    const od = optionsDigest(adapter, config);
    const options = config.adapters?.[adapter.id] ?? {};
    const files = cen.files.filter((f) => analysable(f) && matchAny(f.path, adapter.capabilities?.files ?? []));
    const misses = [];
    for (const f of files) {
      if (!f.blob) {
        try {
          readEntry(ctx.root, f);
        } catch (err) {
          failures.push({ path: f.path, adapter: adapter.id, error: err.message });
          continue;
        }
      }
      const hit = getIndex.get(f.path, adapter.id);
      if (hit && hit.blob === f.blob && hit.adapter_version === adapter.version && hit.config_digest === od) {
        addFacts(f.path, JSON.parse(hit.facts));
        stats.cached++;
      } else misses.push(f);
    }
    if (run) {
      charge(ctx, run, 'files_read', misses.length);
      charge(ctx, run, 'bytes_read', misses.reduce((n, f) => n + f.size, 0));
    }
    // Extract and commit in chunks, so an interrupted cold map resumes from the per-file
    // cache instead of redoing a whole adapter pass (spec §28: resumable at 100k files).
    let extracted = 0;
    for (let at = 0; at < misses.length; at += COMMIT_CHUNK) {
      const chunk = misses.slice(at, at + COMMIT_CHUNK);
      let results = [];
      if (adapter.extractBatch) {
        const items = chunk.map((file) => ({ file, text: readEntry(ctx.root, file) }));
        const exec = adapterExec(ctx, { run, config });
        const out = await adapter.extractBatch(items, { commit, options, exec });
        results = chunk.map((f) => (out.has(f.path) ? { path: f.path, blob: f.blob, facts: out.get(f.path) } : { path: f.path, error: 'no output from batch extractor' }));
      } else if (chunk.length >= PARALLEL_THRESHOLD && workers > 1 && adapter.moduleURL) {
        results = await extractParallel({ moduleURL: adapter.moduleURL, root: ctx.root, files: chunk, commit, options, workers });
      } else {
        for (const f of chunk) {
          try {
            const text = readEntry(ctx.root, f);
            results.push({ path: f.path, blob: f.blob, facts: adapter.extract(f, text, { commit, options }) });
          } catch (err) {
            results.push({ path: f.path, error: String(err?.message ?? err) });
          }
        }
      }
      ctx.store.tx(() => {
        for (const r of results) {
          if (r.error) {
            failures.push({ path: r.path, adapter: adapter.id, error: r.error });
            continue;
          }
          let facts = r.facts ?? [];
          if (facts.length > MAX_FACTS_PER_FILE) facts = facts.slice(0, MAX_FACTS_PER_FILE);
          facts = facts.map((f) => redactDeep(assertFact(f)));
          const entry = filesByPath.get(r.path);
          if (entry && !entry.blob) entry.blob = r.blob;
          putIndex.run(r.path, adapter.id, adapter.version, od, r.blob ?? entry?.blob ?? 'unknown', canonicalJSON(facts));
          addFacts(r.path, facts);
          stats.extracted++;
          extracted++;
        }
      });
    }
    stats.adapters[adapter.id] = { files: files.length, extracted, cached: files.length - misses.length };
  }

  const fileFacts = [...perFile.values()].flat();
  const global = [];
  for (const adapter of loaded) {
    if (!adapter.link) continue;
    try {
      pushAll(global, (adapter.link({ files: filesByPath, factsByFile: perFile, options: config.adapters?.[adapter.id] ?? {} }) ?? []).map(assertFact));
    } catch (err) {
      failures.push({ path: '<link>', adapter: adapter.id, error: String(err?.message ?? err) });
    }
  }
  const readText = evidenceReader(ctx, config);
  // Discovery is cached like extraction: keyed by everything its result can depend on
  // (adapter version and options, the blobs of the files it reads, the evidence files'
  // size and mtime). Rendering charts or importing traces is not repeated on a re-map.
  const evidenceStamp = Object.values(config.evidence ?? {}).flat().map((p) => {
    try {
      const st = statSync(resolveInside(ctx.root, p).abs);
      return `${p}:${st.size}:${st.mtimeMs}`;
    } catch {
      return `${p}:missing`;
    }
  });
  for (const adapter of loaded) {
    if (!adapter.discover) continue;
    const relevant = cen.files.filter((f) => matchAny(f.path, adapter.capabilities?.files ?? [])).map((f) => `${f.path}@${f.blob ?? f.size}`);
    const cacheKey = digest({ adapter: adapter.id, version: adapter.version, options: config.adapters?.[adapter.id] ?? {}, relevant, evidence: evidenceStamp });
    const cached = ctx.store.meta(`discover:${adapter.id}`);
    if (cached) {
      const { key, ref } = JSON.parse(cached);
      if (key === cacheKey) {
        try {
          pushAll(global, JSON.parse((await import('../state/cas.mjs')).casGet(ctx, ref).toString('utf8')));
          stats.discover_cached = (stats.discover_cached ?? 0) + 1;
          continue;
        } catch {
          // Cache blob missing or unreadable: rediscover.
        }
      }
    }
    try {
      const out = await adapter.discover({
        root: ctx.root,
        census: cen.files,
        readText,
        exec: adapterExec(ctx, { run, config }),
        options: config.adapters?.[adapter.id] ?? {},
        evidence: config.evidence,
        now: observedAt,
        factsByFile: perFile,
      });
      const discovered = (out ?? []).map((f) => redactDeep(assertFact(f)));
      pushAll(global, discovered);
      const discFailures = out?.failures ?? [];
      for (const f of discFailures) failures.push({ path: f.path ?? f.file ?? '<evidence>', adapter: adapter.id, error: String(f.error ?? f.reason ?? f.message ?? 'failed') });
      if (!discFailures.length) {
        const { casPut } = await import('../state/cas.mjs');
        ctx.store.meta(`discover:${adapter.id}`, JSON.stringify({ key: cacheKey, ref: casPut(ctx, JSON.stringify(discovered), { mediaType: 'application/json', label: `discover.${adapter.id}` }) }));
      }
    } catch (err) {
      failures.push({ path: '<discover>', adapter: adapter.id, error: String(err?.message ?? err) });
    }
  }
  let historyStats = null;
  if (history && cen.repo) {
    try {
      const sources = new Set(cen.files.filter((f) => f.kind === 'source' || f.kind === 'test').map((f) => f.path));
      const hkey = digest({ commit, days: config.decomposition.history_days, max: config.decomposition.max_changeset, min: config.decomposition.min_shared_commits, sources: [...sources].sort() });
      const hc = ctx.store.meta('history:cache');
      let h = null;
      if (hc) {
        const { key, ref, stats: st } = JSON.parse(hc);
        if (key === hkey) {
          try {
            h = { facts: JSON.parse((await import('../state/cas.mjs')).casGet(ctx, ref).toString('utf8')), stats: { ...st, cached: true } };
          } catch {
            h = null;
          }
        }
      }
      if (!h) {
        h = historyFacts(ctx.root, config, sources);
        const { casPut } = await import('../state/cas.mjs');
        ctx.store.meta('history:cache', JSON.stringify({ key: hkey, ref: casPut(ctx, JSON.stringify(h.facts), { mediaType: 'application/json', label: 'history' }), stats: h.stats }));
      }
      pushAll(global, h.facts);
      historyStats = h.stats;
    } catch (err) {
      failures.push({ path: '<history>', adapter: 'history', error: String(err?.message ?? err) });
    }
  }

  const all = [...fileFacts, ...global];
  const projection = project(ctx, all, { commit, observedAt });
  const summary = {
    commit,
    generation: projection.generation,
    status: failures.length || unavailable.length ? 'partial' : 'complete',
    files: stats.files,
    by_kind: stats.by_kind,
    cache: { hits: stats.cached, extracted: stats.extracted, hit_rate: stats.cached + stats.extracted ? +(stats.cached / (stats.cached + stats.extracted)).toFixed(3) : null },
    adapters: stats.adapters,
    unavailable,
    failures: failures.slice(0, 200),
    failure_count: failures.length,
    facts: all.length,
    nodes: projection.nodes,
    edges: projection.edges,
    history: historyStats,
    duration_ms: Date.now() - t0,
    config_digest: configDigest,
  };
  appendEvent(ctx, { type: 'map.generation', run_id: run?.id, actor: 'runtime:mapper', payload: { ...summary, failures: undefined } });
  return summary;
}

function historyFacts(root, config, sourcePaths) {
  const d = config.decomposition;
  const out = git(root, [...GIT_LOG_ARGS, `--since=${d.history_days} days ago`], { check: false, maxBuffer: 512 * 1024 * 1024 }).stdout;
  const commits = parseGitLog(out);
  const pv = prov({ source_type: 'vcs', source_ref: 'git log', extractor: 'history@0.1.0', confidence: 'high' });
  const facts = [];
  const cc = coChange(commits, { maxChangeset: d.max_changeset, minSharedCommits: d.min_shared_commits, pathFilter: (p) => sourcePaths.has(p) });
  for (const p of cc.pairs) {
    facts.push(edgeFact('CO_CHANGES', `module:${p.a}`, `module:${p.b}`, { shared: p.shared, degree: +p.degree.toFixed(3) }, pv));
  }
  for (const [path, c] of churn(commits)) {
    if (!sourcePaths.has(path)) continue;
    facts.push(nodeFact('module', path, { path, attrs: { churn_commits: c.commits, churn_lines: c.added + c.deleted, last_change: new Date(c.last_time * 1000).toISOString() } }, pv));
  }
  return { facts, stats: { commits: commits.length, ignored_large_commits: cc.ignoredCommits ?? 0, co_change_pairs: cc.pairs.length } };
}

const PLACEHOLDER_TYPE = (id) => {
  const t = id.slice(0, id.indexOf(':'));
  return NODE_TYPES.has(t) ? t : null;
};

/**
 * Replace the facts table with this generation and rebuild nodes/edges with evidence
 * labels (spec §10.3): corroborated when independent source types agree, inferred when
 * every source is inference, contradicted when any fact declares a contradiction.
 */
export function project(ctx, facts, { commit, observedAt }) {
  const generation = Number(ctx.store.meta('generation') ?? 0) + 1;
  const nodes = new Map();
  const edges = new Map();
  const insertFact = ctx.store.db.prepare(
    'INSERT OR REPLACE INTO facts(id, generation, kind, subject, predicate, object, attrs, source_type, source_ref, extractor, observed_at, commit_sha, confidence, scope, contradicts, path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const label = (sources) => {
    if (sources.some((s) => s.contradicts?.length)) return 'contradicted';
    const kinds = new Set(sources.map((s) => s.source_type));
    if (kinds.size === 1 && kinds.has('inference')) return 'inferred';
    kinds.delete('inference');
    return kinds.size >= 2 ? 'corroborated' : 'observed';
  };
  ctx.store.tx(() => {
    ctx.store.run('DELETE FROM facts');
    for (const f of facts) {
      const id = factId(f);
      const p = f.provenance;
      const path = p.source_ref ? String(p.source_ref).split(/[:#]/)[0] : null;
      insertFact.run(id, generation, f.kind, f.kind === 'node' ? f.id : f.from, f.kind === 'edge' ? f.type : null, f.kind === 'edge' ? f.to : null, canonicalJSON(f.attrs ?? {}), p.source_type, p.source_ref ?? null, p.extractor, observedAt, commit, p.confidence, canonicalJSON(p.scope ?? []), canonicalJSON(p.contradicts ?? []), path, f.attrs?.expires_at ?? null);
      if (f.kind === 'node') {
        let n = nodes.get(f.id);
        if (!n) nodes.set(f.id, (n = { id: f.id, type: f.type, name: f.name, path: f.path, attrs: {}, sources: [], fact_ids: [] }));
        Object.assign(n.attrs, f.attrs);
        if (!n.path && f.path) n.path = f.path;
        n.sources.push(p);
        n.fact_ids.push(id);
      } else {
        const eid = edgeId(f.type, f.from, f.to);
        let e = edges.get(eid);
        if (!e) edges.set(eid, (e = { id: eid, type: f.type, from: f.from, to: f.to, attrs: {}, sources: [], fact_ids: [] }));
        const count = (e.attrs.count ?? 0) + (f.attrs?.count ?? 1);
        Object.assign(e.attrs, f.attrs, { count });
        e.sources.push(p);
        e.fact_ids.push(id);
      }
    }
    for (const e of edges.values()) {
      for (const end of [e.from, e.to]) {
        if (nodes.has(end)) continue;
        const type = PLACEHOLDER_TYPE(end);
        if (!type) continue;
        nodes.set(end, { id: end, type, name: end.slice(type.length + 1), path: null, attrs: { placeholder: true }, sources: [{ source_type: 'inference' }], fact_ids: [] });
      }
    }
    ctx.store.run('DELETE FROM nodes');
    ctx.store.run('DELETE FROM edges');
    const insN = ctx.store.db.prepare('INSERT INTO nodes(id, type, name, path, attrs, label, fact_ids) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insE = ctx.store.db.prepare('INSERT INTO edges(id, type, src, dst, attrs, label, fact_ids) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const n of nodes.values()) insN.run(n.id, n.type, n.name ?? null, n.path ?? null, canonicalJSON(n.attrs), label(n.sources), JSON.stringify(n.fact_ids.slice(0, 50)));
    for (const e of edges.values()) {
      if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
      insE.run(e.id, e.type, e.from, e.to, canonicalJSON(e.attrs), label(e.sources), JSON.stringify(e.fact_ids.slice(0, 50)));
    }
    ctx.store.meta('generation', generation);
    ctx.store.meta('mapped_commit', commit ?? '');
    ctx.store.meta('mapped_at', observedAt);
  });
  return { generation, nodes: nodes.size, edges: ctx.store.get('SELECT COUNT(*) AS n FROM edges').n };
}

/** Instrumented entry point (spec §27); a no-op span when telemetry is disabled. */
export async function mapRepository(ctx, opts) {
  const { withSpan } = await import('../telemetry/otel.mjs');
  return withSpan('map', {}, () => mapRepositoryInner(ctx, opts));
}
