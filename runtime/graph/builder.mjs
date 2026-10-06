// The map pipeline (spec §9.4, §9.5): census → per-file extraction (cached by path, blob,
// adapter version and options digest; parallel in workers) → cross-file linking →
// whole-repository discovery (evidence imports) → git history → projection.
//
// Failure is explicit (spec §22.2): a file an adapter could not process is listed, and the
// map reports `partial` rather than pretending to be complete.

import { checkoutNotice, checkoutState } from './checkout.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { canonicalJSON, digest } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { matchAny } from '../core/glob.mjs';
import { parseScope } from '../core/scope.mjs';
import { resolveScopes } from './mapped-scopes.mjs';
import { isSecretPath, resolveInside } from '../core/paths.mjs';
import { redactDeep } from '../core/redact.mjs';
import { loadAdapters } from '../../adapters/registry.mjs';
import { git } from '../apply/git.mjs';
import { adapterExec } from '../broker/broker.mjs';
import { charge } from '../policy/budget.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { analysable, census, readEntry } from './census.mjs';
import { assertFact, edgeFact, edgeId, factId, NODE_TYPES, nodeFact, prov } from './facts.mjs';
import { writeDerived } from './derived.mjs';
import { Graph } from './graph.mjs';
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
async function mapRepositoryInner(ctx, { config, configDigest, run = null, scope: givenScope = [], replace = false, only = null, history = true, adapters = null, branchOk = null }) {
  const t0 = Date.now();
  const scopes = resolveScopes(ctx, { scope: givenScope, replace });
  const scope = scopes.effective;
  // Wall time per phase, so a slow map says where the time went (docs/benchmarks.md).
  const phases = {};
  let mark = t0;
  const lap = (name) => {
    const now = Date.now();
    phases[name] = now - mark;
    mark = now;
  };
  const observedAt = nowISO();
  const cen = census(ctx.root, { config, scope });
  lap('census_ms');
  const commit = cen.commit;
  // `adapters` replaces the registry; tests use it to stand in a failing extractor.
  const { loaded, unavailable } = adapters ? { loaded: adapters, unavailable: [] } : await loadAdapters(config, only);
  const notes = []; // degraded-but-working conditions the person should know about
  const workers = defaultWorkers(config.limits.workers);
  const perFile = new Map(); // path → facts (all adapters)
  const failures = [];
  const stats = { files: cen.files.filter((f) => !f.context).length, by_kind: cen.byKind, cached: 0, extracted: 0, adapters: {} };
  const filesByPath = new Map(cen.files.map((f) => [f.path, f]));
  const getIndex = ctx.store.db.prepare('SELECT blob, adapter_version, config_digest, facts FROM file_index WHERE path = ? AND adapter = ?');
  const putIndex = ctx.store.db.prepare('INSERT OR REPLACE INTO file_index(path, adapter, adapter_version, config_digest, blob, facts) VALUES (?, ?, ?, ?, ?, ?)');

  const moduleBy = new Map(); // path → adapter id that produced its module fact
  const addFacts = (path, facts, adapterId) => {
    if (adapterId && !moduleBy.has(path) && facts.some((f) => f.kind === 'node' && f.type === 'module')) moduleBy.set(path, adapterId);
    let list = perFile.get(path);
    if (!list) perFile.set(path, (list = []));
    list.push(...facts);
  };

  // Too big for the run's read budget: say so before reading anything, naming the setting.
  const charged = new Set();
  if (run) {
    const budget = config.limits?.max_files_read;
    const analysed = cen.files.filter((f) => analysable(f) && !f.context).length;
    if (Number.isFinite(budget) && analysed > budget) {
      throw new UnknotError('UK_BUDGET_EXCEEDED', `${analysed} files to analyse is above limits.max_files_read (${budget}): raise it in .unknot/config.yaml (a person accepts the change), or map a scope`, { details: { files: analysed, limit: budget } });
    }
  }
  for (const adapter of loaded) {
    if (!adapter.extract && !adapter.extractBatch) continue;
    const od = optionsDigest(adapter, config);
    // Facts depend on how the census classified the file (a test, a context file), not only on
    // its bytes: a file that becomes test code under a newer rule must be extracted again.
    const keyOf = (f) => `${od}|${f?.kind ?? ''}${f?.is_test ? '|test' : ''}${f?.context ? '|context' : ''}`;
    const options = config.adapters?.[adapter.id] ?? {};
    // Repository-level context files (kept outside the scope) go only to adapters that declare them.
    const files = cen.files.filter((f) => analysable(f) && matchAny(f.path, (f.context ? adapter.capabilities?.context_files : adapter.capabilities?.files) ?? []));
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
      if (hit && hit.blob === f.blob && hit.adapter_version === adapter.version && hit.config_digest === keyOf(f)) {
        addFacts(f.path, JSON.parse(hit.facts), adapter.id);
        stats.cached++;
      } else misses.push(f);
    }
    if (run) {
      // A file read by several adapters is still one file read.
      const fresh = misses.filter((f) => !charged.has(f.path));
      for (const f of fresh) charged.add(f.path);
      charge(ctx, run, 'files_read', fresh.length);
      charge(ctx, run, 'bytes_read', fresh.reduce((n, f) => n + f.size, 0));
    }
    // Extract and commit in chunks, so an interrupted cold map resumes from the per-file
    // cache instead of redoing a whole adapter pass (spec §28: resumable at 100k files).
    let extracted = 0;
    for (let at = 0; at < misses.length; at += COMMIT_CHUNK) {
      const chunk = misses.slice(at, at + COMMIT_CHUNK);
      let results = [];
      // A batch that raised a notice ran degraded (e.g. a lexical fallback): its facts serve
      // this map but are not cached, so the next map retries and recovers or says so again.
      // Cached degraded facts hid the problem from every later map.
      let degraded = false;
      if (adapter.extractBatch) {
        const items = chunk.map((file) => ({ file, text: readEntry(ctx.root, file) }));
        const exec = adapterExec(ctx, { run, config });
        const before = notes.length;
        const out = await adapter.extractBatch(items, { commit, options, exec, notes });
        degraded = notes.length > before;
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
          if (!degraded) putIndex.run(r.path, adapter.id, adapter.version, keyOf(entry), r.blob ?? entry?.blob ?? 'unknown', canonicalJSON(facts));
          addFacts(r.path, facts, adapter.id);
          stats.extracted++;
          extracted++;
        }
      });
    }
    stats.adapters[adapter.id] = { files: files.length, extracted, cached: files.length - misses.length };
  }

  // Census order, whatever the order cache hits and extractions arrived in, so a re-map merges
  // facts exactly as a cold map of the same tree does.
  const arrived = new Map(perFile);
  perFile.clear();
  for (const f of cen.files) if (arrived.has(f.path)) perFile.set(f.path, arrived.get(f.path));
  for (const [path, facts] of arrived) if (!perFile.has(path)) perFile.set(path, facts);

  // The census decides what is test code (test projects included); an adapter's own path rule
  // only adds to it, so every command sees one classification.
  for (const [path, facts] of perFile) {
    if (filesByPath.get(path)?.kind !== 'test') continue;
    for (const f of facts) if (f.kind === 'node' && f.type === 'module' && f.attrs) f.attrs.is_test = true;
  }
  // Cached files were added before fresh ones, and fresh ones in whatever order extraction
  // finished; every later step (linking, dedupe, tie-breaks) sees the files in path order.
  const ordered = [...perFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  perFile.clear();
  for (const [path, facts] of ordered) perFile.set(path, facts);
  lap('extraction_ms');
  const fileFacts = [...perFile.values()].flat();
  const global = [];
  for (const adapter of loaded) {
    if (!adapter.link) continue;
    try {
      pushAll(global, (adapter.link({ files: filesByPath, factsByFile: perFile, options: config.adapters?.[adapter.id] ?? {}, notes, stats }) ?? []).map(assertFact));
    } catch (err) {
      failures.push({ path: '<link>', adapter: adapter.id, error: String(err?.message ?? err) });
    }
  }
  lap('link_ms');
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
  lap('discovery_ms');
  let historyStats = null;
  if (history && cen.repo) {
    try {
      const sources = new Set(cen.files.filter((f) => f.kind === 'source' || f.kind === 'test').map((f) => f.path));
      const hkey = digest({ commit, days: config.decomposition.history_days, floor: config.decomposition.history_min_commits, max: config.decomposition.max_changeset, min: config.decomposition.min_shared_commits, sources: [...sources].sort() });
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

  lap('history_ms');
  notes.push(...scopes.notes);
  const ps = parseScope(givenScope);
  if (ps.namespaces.length || ps.seeds.length) notes.push('scope entries ns: and seed: apply to graph commands (diagnose, decompose, graph); map narrows only by path entries');
  const coverage = languageCoverage(cen.files, perFile, moduleBy);
  const totalSource = coverage.reduce((n, c) => n + c.files, 0);
  coverage.forEach((c, i) => {
    if (c.quality !== 'lexical') return;
    const dominant = i === 0;
    const reason = `no dedicated adapter for ${c.language} (${c.files} of ${totalSource} source files): lexical extraction; imports and type references are matched by name, not resolved by a compiler, and most calls are not seen`;
    if (dominant) unavailable.push({ id: `language:${c.language}`, adapter: `language:${c.language}`, reason });
    else notes.push(`language coverage: ${c.language} (${c.files} source files) is read lexically, without a dedicated adapter`);
  });

  const all = [...fileFacts, ...global];
  lap('coverage_ms');
  // What was mapped, and whether it is behind what the team works on.
  const checkout = checkoutState(ctx.root);
  const stale = checkoutNotice(checkout, { expected: branchOk });
  if (stale) notes.push(stale);
  if (checkout) ctx.store.meta('mapped_checkout', JSON.stringify(checkout));
  const projection = project(ctx, all, { commit, observedAt });
  lap('projection_ms');
  ctx.store.meta('mapped_scopes', JSON.stringify(scopes.record));
  ctx.store.meta('constants', JSON.stringify(stats.constants ?? null));
  // Derived facts are a function of the graph: an unchanged graph keeps the stored ones.
  const derivedDone = ctx.store.get("SELECT 1 AS ok FROM derived WHERE kind = '_done' AND generation = ?", projection.generation);
  if (projection.changed || !derivedDone) writeDerived(ctx, Graph.fromStore(ctx.store), projection.generation);
  lap('derived_ms');
  const summary = {
    commit,
    generation: projection.generation,
    status: failures.length || unavailable.length ? 'partial' : 'complete',
    scope: { whole: scopes.record.whole, covered: scopes.record.scopes, kept: scopes.kept, dropped: scopes.dropped, missing: scopes.missing },
    files: stats.files,
    by_kind: stats.by_kind,
    cache: { hits: stats.cached, extracted: stats.extracted, hit_rate: stats.cached + stats.extracted ? +(stats.cached / (stats.cached + stats.extracted)).toFixed(3) : null },
    adapters: stats.adapters,
    unavailable,
    coverage,
    ...(checkout && { checkout }),
    ...(notes.length && { notices: [...new Set(notes)] }),
    failures: failures.slice(0, 200),
    failure_count: failures.length,
    facts: all.length,
    nodes: projection.nodes,
    edges: projection.edges,
    ...(stats.constants && { constants: stats.constants }),
    history: historyStats,
    duration_ms: Date.now() - t0,
    phases,
    config_digest: configDigest,
  };
  appendEvent(ctx, { type: 'map.generation', run_id: run?.id, actor: 'runtime:mapper', payload: { ...summary, failures: undefined } });
  return summary;
}

/**
 * Source files per language with the adapter that handled them and how: `syntax_tree`
 * (parsed), `degraded` (parsed with fallbacks) or `lexical` (name matching only). Most files first.
 */
export function languageCoverage(files, perFile, moduleBy) {
  const by = new Map();
  for (const f of files) {
    if (f.kind !== 'source' || f.context) continue;
    const mod = (perFile.get(f.path) ?? []).find((x) => x.kind === 'node' && x.type === 'module');
    const pq = mod?.attrs?.parse_quality;
    const quality = !mod ? 'none' : pq === 'lexical' ? 'lexical' : pq === 'degraded' ? 'degraded' : 'syntax_tree';
    const g = by.get(f.language) ?? { language: f.language, files: 0, adapters: new Map(), quals: new Map() };
    g.files++;
    const a = moduleBy.get(f.path) ?? 'none';
    g.adapters.set(a, (g.adapters.get(a) ?? 0) + 1);
    g.quals.set(quality, (g.quals.get(quality) ?? 0) + 1);
    by.set(f.language, g);
  }
  const top = (m) => [...m].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
  return [...by.values()].sort((a, b) => b.files - a.files || (a.language < b.language ? -1 : 1)).map((g) => ({ language: g.language, files: g.files, adapter: top(g.adapters), quality: top(g.quals) }));
}

function historyFacts(root, config, sourcePaths) {
  const d = config.decomposition;
  const log = (args) => parseGitLog(git(root, [...GIT_LOG_ARGS, ...args], { check: false, maxBuffer: 512 * 1024 * 1024 }).stdout);
  let commits = log([`--since=${d.history_days} days ago`]);
  // A quiet repository has too few recent commits for co-change to say anything (an
  // unknown-repository test: 116 commits in a year, no pairs). Read the most recent
  // history_min_commits instead, and say so.
  const floor = d.history_min_commits ?? 0;
  let extended = false;
  if (floor > commits.length) {
    const more = log([`-n${floor}`]);
    if (more.length > commits.length) {
      commits = more;
      extended = true;
    }
  }
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
  const oldest = commits.reduce((m, c) => Math.min(m, c.time ?? Infinity), Infinity);
  return { facts, stats: { commits: commits.length, ignored_large_commits: cc.ignoredCommits ?? 0, co_change_pairs: cc.pairs.length, window: extended ? `extended to the latest ${commits.length} commits (fewer than ${floor} in ${d.history_days} days)` : `${d.history_days} days`, ...(Number.isFinite(oldest) && { oldest_commit_at: new Date(oldest * 1000).toISOString() }) } };
}

const PLACEHOLDER_TYPE = (id) => {
  const t = id.slice(0, id.indexOf(':'));
  return t !== 'constant' && NODE_TYPES.has(t) ? t : null; // a constant exists only if its adapter kept it (the cap)
};

// Bump when how facts merge into nodes and edges changes: stored rows are only trusted while
// the fact signatures (which include this) match.
const PROJECTION_VERSION = 1;

const labelOf = (sources) => {
  if (sources.some((s) => s.contradicts?.length)) return 'contradicted';
  const kinds = new Set(sources.map((s) => s.source_type));
  if (kinds.size === 1 && kinds.has('inference')) return 'inferred';
  kinds.delete('inference');
  return kinds.size >= 2 ? 'corroborated' : 'observed';
};

/** What a fact row holds beyond what its id (key, source, extractor, attrs) already pins down. */
const sigOf = (f, p) => createHash('sha1').update(JSON.stringify([PROJECTION_VERSION, p.source_type, p.confidence, p.scope ?? [], p.contradicts ?? [], f.type, f.name ?? null, f.path ?? null])).digest('base64').slice(0, 16);
const ID_LEN = 26; // `f-` and 24 hex digits (facts.mjs factId)

/**
 * Bring the facts, nodes and edges tables to this fact set, writing only what differs.
 * Facts are matched by id and a signature of their content; nodes and edges merge several
 * facts, so only those a changed (inserted, updated or deleted) fact touches are recomputed
 * and compared with their stored rows. With nothing changed the tables are not written and
 * the generation stays; otherwise it advances. The result is the one a full rewrite gives
 * (spec §10.3): corroborated when independent source types agree, inferred when every source
 * is inference, contradicted when any fact declares a contradiction.
 */
export function project(ctx, facts, { commit, observedAt }) {
  const { store } = ctx;
  const gen0 = store.meta('generation');
  const generation0 = Number(gen0 ?? 0);
  const stored = new Map(); // id + signature → whether this fact set holds it
  for (const r of store.db.prepare("SELECT id || COALESCE(digest, '') AS k FROM facts").iterate()) stored.set(r.k, 0);
  // Pass 1: which facts are new or changed. A matching id and signature is unchanged; stored
  // entries nothing matched are stale.
  const fresh = []; // indexes of facts to write
  const ids = new Map(); // index → id and signature, for those
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    const id = factId(f);
    const sig = sigOf(f, f.provenance);
    const key = id + sig;
    if (stored.has(key)) {
      stored.set(key, 1);
      continue;
    }
    fresh.push(i);
    ids.set(i, { id, sig });
  }
  const touchedNodes = new Set();
  const touchedEdges = new Set();
  const ends = new Set(); // endpoints of touched edges: their placeholders may appear or go
  const touch = (kind, subject, predicate, object) => {
    if (kind === 'node') touchedNodes.add(subject);
    else {
      touchedEdges.add(edgeId(predicate, subject, object));
      ends.add(subject).add(object);
    }
  };
  for (const i of fresh) {
    const f = facts[i];
    touch(f.kind, f.kind === 'node' ? f.id : f.from, f.type, f.to);
  }
  const staleIds = [];
  for (const [key, hit] of stored) if (!hit) staleIds.push(key.slice(0, ID_LEN));
  const getStale = store.db.prepare('SELECT kind, subject, predicate, object FROM facts WHERE id = ?');
  for (const id of staleIds) {
    const r = getStale.get(id);
    if (r) touch(r.kind, r.subject, r.predicate, r.object);
  }
  const changed = !!(fresh.length || staleIds.length) || gen0 == null;
  if (!changed) {
    store.tx(() => {
      store.meta('mapped_commit', commit ?? '');
      store.meta('mapped_at', observedAt);
    });
    return { generation: generation0, changed: false, nodes: store.get('SELECT COUNT(*) AS n FROM nodes').n, edges: store.get('SELECT COUNT(*) AS n FROM edges').n };
  }
  const generation = generation0 + 1;

  // Pass 2: merge the facts of every touched node and edge, in fact order (the merge depends on it).
  const invalidEnd = (id) => !PLACEHOLDER_TYPE(id); // an edge to one exists only while a real node does
  const nodes = new Map();
  const edges = new Map();
  const referenced = new Set(); // ids in `recheck` some edge fact (touched or not) still names
  const recheck = new Set([...touchedNodes, ...ends]); // nodes to rebuild and compare
  const idAt = (i, f) => ids.get(i)?.id ?? factId(f);
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    if (f.kind === 'node') {
      if (!recheck.has(f.id)) continue;
      let n = nodes.get(f.id);
      if (!n) nodes.set(f.id, (n = { id: f.id, type: f.type, name: f.name, path: f.path, attrs: {}, sources: [], fact_ids: [] }));
      Object.assign(n.attrs, f.attrs);
      if (!n.path && f.path) n.path = f.path;
      n.sources.push(f.provenance);
      n.fact_ids.push(idAt(i, f));
    } else {
      if (recheck.has(f.from)) referenced.add(f.from);
      if (recheck.has(f.to)) referenced.add(f.to);
      const eid = edgeId(f.type, f.from, f.to);
      if (!touchedEdges.has(eid) && !(touchedNodes.has(f.from) && invalidEnd(f.from)) && !(touchedNodes.has(f.to) && invalidEnd(f.to))) continue;
      let e = edges.get(eid);
      if (!e) edges.set(eid, (e = { id: eid, type: f.type, from: f.from, to: f.to, attrs: {}, sources: [], fact_ids: [] }));
      const count = (e.attrs.count ?? 0) + (f.attrs?.count ?? 1);
      Object.assign(e.attrs, f.attrs, { count });
      e.sources.push(f.provenance);
      e.fact_ids.push(idAt(i, f));
    }
  }
  const db = store.db;
  const insertFact = db.prepare(
    'INSERT OR REPLACE INTO facts(id, generation, kind, subject, predicate, object, attrs, source_type, source_ref, extractor, observed_at, commit_sha, confidence, scope, contradicts, path, expires_at, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const getNode = db.prepare('SELECT * FROM nodes WHERE id = ?');
  const getEdge = db.prepare('SELECT * FROM edges WHERE id = ?');
  const putNode = db.prepare('INSERT OR REPLACE INTO nodes(id, type, name, path, attrs, label, fact_ids) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const putEdge = db.prepare('INSERT OR REPLACE INTO edges(id, type, src, dst, attrs, label, fact_ids) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const exists = db.prepare('SELECT 1 AS ok FROM nodes WHERE id = ?');
  store.tx(() => {
    const delFact = db.prepare('DELETE FROM facts WHERE id = ?');
    for (const id of staleIds) delFact.run(id);
    for (const i of fresh) {
      const f = facts[i];
      const { id, sig } = ids.get(i);
      const p = f.provenance;
      const path = p.source_ref ? String(p.source_ref).split(/[:#]/)[0] : null;
      insertFact.run(id, generation, f.kind, f.kind === 'node' ? f.id : f.from, f.kind === 'edge' ? f.type : null, f.kind === 'edge' ? f.to : null, canonicalJSON(f.attrs ?? {}), p.source_type, p.source_ref ?? null, p.extractor, observedAt, commit, p.confidence, canonicalJSON(p.scope ?? []), canonicalJSON(p.contradicts ?? []), path, f.attrs?.expires_at ?? null, sig);
    }
    // Nodes: a touched id, or an endpoint of a touched edge, may now be real, a placeholder, or gone.
    const ofNode = (id) => {
      const n = nodes.get(id);
      if (n) return { type: n.type, name: n.name ?? null, path: n.path ?? null, attrs: canonicalJSON(n.attrs), label: labelOf(n.sources), fact_ids: JSON.stringify(n.fact_ids.slice(0, 50)) };
      const type = referenced.has(id) ? PLACEHOLDER_TYPE(id) : null;
      return type && { type, name: id.slice(type.length + 1), path: null, attrs: canonicalJSON({ placeholder: true }), label: 'inferred', fact_ids: '[]' };
    };
    for (const id of recheck) {
      const want = ofNode(id);
      const have = getNode.get(id);
      if (!want) {
        if (have) store.run('DELETE FROM nodes WHERE id = ?', id);
      } else if (!have || have.type !== want.type || have.name !== want.name || have.path !== want.path || have.attrs !== want.attrs || have.label !== want.label || have.fact_ids !== want.fact_ids) {
        putNode.run(id, want.type, want.name, want.path, want.attrs, want.label, want.fact_ids);
      }
    }
    // Edges: those a changed fact touched, and those to a real node with an unprefixed id that came or went.
    for (const eid of new Set([...touchedEdges, ...edges.keys()])) {
      const e = edges.get(eid);
      const have = getEdge.get(eid);
      if (!e || !exists.get(e.from) || !exists.get(e.to)) {
        if (have) store.run('DELETE FROM edges WHERE id = ?', eid);
        continue;
      }
      const want = { type: e.type, src: e.from, dst: e.to, attrs: canonicalJSON(e.attrs), label: labelOf(e.sources), fact_ids: JSON.stringify(e.fact_ids.slice(0, 50)) };
      if (!have || have.type !== want.type || have.src !== want.src || have.dst !== want.dst || have.attrs !== want.attrs || have.label !== want.label || have.fact_ids !== want.fact_ids) {
        putEdge.run(eid, want.type, want.src, want.dst, want.attrs, want.label, want.fact_ids);
      }
    }
    store.meta('generation', generation);
    store.meta('mapped_commit', commit ?? '');
    store.meta('mapped_at', observedAt);
  });
  return { generation, changed: true, nodes: store.get('SELECT COUNT(*) AS n FROM nodes').n, edges: store.get('SELECT COUNT(*) AS n FROM edges').n };
}

/** Instrumented entry point (spec §27); a no-op span when telemetry is disabled. */
export async function mapRepository(ctx, opts) {
  const { withSpan } = await import('../telemetry/otel.mjs');
  return withSpan('map', {}, () => mapRepositoryInner(ctx, opts));
}
