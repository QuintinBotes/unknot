// Semantic facts from a SCIP index. A person may supply an index as before; with the
// explicit `adapters.scip.run` opt-in, this adapter can also ask the broker to create a
// short-lived, language-table-selected cache entry. It never chooses a tool or command
// shape itself: that information lives in indexers.mjs.

import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UnknotError } from '../../../runtime/core/errors.mjs';
import { resolveInside } from '../../../runtime/core/paths.mjs';
import { git, isRepo } from '../../../runtime/apply/git.mjs';
import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { analyzeIndex } from './analyze.mjs';
import { coveredPaths, indexLanguages, indexTrustProblem, locateIndexes } from './locate.mjs';
import { INDEXERS, executableOnPath, indexerArgv, indexersForPaths, presentLanguages, runBudgets } from './indexers.mjs';
import { matchAny } from '../../../runtime/core/glob.mjs';

const MAX_TEMPLATE_BYTES = 1_000_000;

const VERSION = '0.3.1';
const EXTRACTOR = `scip@${VERSION}`;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const MAX_LISTED = 50;

const pv = (path, line) => prov({ source_type: 'lsp', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence: 'high' });
const cacheRel = (entry) => `.unknot/state/adapter-cache/scip/${entry.language}.scip`;

function cacheTarget(ctx, entry) {
  // Derive this from the context path too: the broker independently checks the same exact
  // target before it gives an indexer any write access.
  const wanted = join(ctx.paths.state, 'adapter-cache', 'scip', `${entry.language}.scip`);
  const target = resolveInside(ctx.root, wanted);
  if (target.abs !== target.real || target.isSymlink) throw new UnknotError('UK_POLICY_DENIED', `${cacheRel(entry)} resolves through a symlink`);
  return target;
}

function regularEntry(root, rel) {
  const target = resolveInside(root, rel);
  if (target.abs !== target.real || target.isSymlink) return null;
  try {
    const stat = lstatSync(target.abs);
    if (!stat.isFile()) return null;
    return { rel: target.rel, abs: target.abs, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function trackedCachePaths(root) {
  if (!isRepo(root)) return [];
  const result = git(root, ['ls-files', '--', '.unknot/state/adapter-cache/scip'], { check: false });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean).sort() : [];
}

function removeFile(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // A failed cleanup cannot turn a failed indexer into semantic evidence.
  }
}

/** Make a fresh, regular cache output before entering the sandbox. */
function freshOutput(ctx, entry) {
  let target;
  try {
    target = cacheTarget(ctx, entry);
    mkdirSync(dirname(target.abs), { recursive: true, mode: 0o700 });
    target = cacheTarget(ctx, entry);
    try {
      const old = lstatSync(target.abs);
      if (!old.isFile()) return { problem: `${cacheRel(entry)} is not a regular file` };
      rmSync(target.abs);
    } catch (err) {
      if (err.code !== 'ENOENT') return { problem: `cannot prepare ${cacheRel(entry)}: ${err.message}` };
    }
    writeFileSync(target.abs, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    target = cacheTarget(ctx, entry);
    return { target, entry: { rel: target.rel, abs: target.abs, size: 0, mtimeMs: statSync(target.abs).mtimeMs } };
  } catch (err) {
    return { problem: `${cacheRel(entry)} is not a private cache path: ${err.message}` };
  }
}

function outputProblem(entry, output, limit) {
  try {
    const stat = lstatSync(output.abs);
    if (!stat.isFile() || output.isSymlink) return `${cacheRel(entry)} is not a regular file`;
    if (stat.size === 0) return `${entry.executable} produced an empty SCIP index`;
    if (stat.size > limit) return `${cacheRel(entry)} is ${stat.size} bytes, over adapters.scip.max_index_bytes (${limit})`;
    // Decode the lightweight document stream here, before making it evidence. At least one
    // document is required: an empty protobuf is not useful semantic coverage.
    if (!indexLanguages({ abs: output.abs }).size) return `${entry.executable} produced no SCIP documents`;
    return null;
  } catch (err) {
    return `${entry.executable} produced an unreadable SCIP index: ${err.message}`;
  }
}

function failureReason(entry, result) {
  if (result?.record?.memory_exceeded) return `${entry.executable} exceeded adapters.scip.memory_mb (${result.record.memory_limit_mb} MiB)`;
  if (result?.record?.timed_out) return `${entry.executable} exceeded adapters.scip.timeout_ms`;
  const status = result?.exitCode;
  const suffix = entry.needsNetwork ? '; network remains disabled, so restore dependencies locally before enabling this indexer' : '';
  return `${entry.executable} failed${status == null ? '' : ` with exit code ${status}`}${suffix}`;
}

/** Add a note once without requiring every direct adapter-link caller to supply one. */
function note(ctx, text) {
  if (ctx.notes) ctx.notes.push(text);
}

function sourceLanguages(entries) {
  const languages = new Set();
  for (const entry of entries) for (const language of indexLanguages(entry)) languages.add(language);
  return languages;
}

/**
 * The existing importer, extended with opt-in cache generation. `ctx.exec` is supplied only by
 * the mapping runtime; verification can still import a supplied or existing local cache but
 * never starts an indexer.
 */
async function link(ctx) {
  const options = ctx.options ?? {};
  const found = locateIndexes(ctx.root, options);
  if (found.missing.length) throw new UnknotError('UK_NOT_FOUND', `adapters.scip.index names ${found.missing.join(', ')}, which does not exist; produce it with an indexer (see \`unknot doctor\`) or remove the setting`);
  const limit = Number.isFinite(options.max_index_bytes) ? options.max_index_bytes : DEFAULT_MAX_BYTES;
  for (const entry of found.entries) {
    if (entry.size > limit) throw new UnknotError('UK_BUDGET_EXCEEDED', `${entry.rel} is ${entry.size} bytes, over adapters.scip.max_index_bytes (${limit})`);
  }

  // Trust person-supplied indices exactly as before. An untrusted one is not allowed to
  // suppress a fresh brokered index for its language.
  const supplied = [];
  for (const entry of found.entries) {
    const problem = indexTrustProblem(ctx.root, entry, coveredPaths(ctx.root, entry));
    if (problem) {
      note(ctx, `SCIP index not used: ${problem}`);
      continue;
    }
    supplied.push(entry);
  }
  const suppliedLanguages = sourceLanguages(supplied);

  const marked = indexersForPaths([...ctx.files.keys()], options);
  const coverage = new Map();
  const setCoverage = (entry, quality, reason) => {
    for (const language of presentLanguages(entry, ctx.files)) coverage.set(language, { quality, reason });
  };
  const cachePoison = trackedCachePaths(ctx.root);
  if (cachePoison.length) note(ctx, `SCIP cache not used: git tracks ${cachePoison.join(', ')}`);

  const cacheEntries = [];
  const state = new Map();
  for (const entry of marked) {
    const hasSupplied = entry.languages.some((language) => suppliedLanguages.has(language));
    if (hasSupplied) {
      state.set(entry.language, { kind: 'supplied', entry: null });
      setCoverage(entry, 'semantic', 'person-supplied SCIP index is preferred');
      continue;
    }
    if (cachePoison.length) {
      const reason = `SCIP cache is tracked by git (${cachePoison.join(', ')})`;
      state.set(entry.language, { kind: 'blocked', reason });
      setCoverage(entry, 'lexical', reason);
      continue;
    }
    if (options.run === true) continue; // A requested run never relies on a stale cache.
    let cached = null;
    try {
      cached = regularEntry(ctx.root, cacheRel(entry));
    } catch (err) {
      const reason = `${cacheRel(entry)} is not a private cache path: ${err.message}`;
      state.set(entry.language, { kind: 'blocked', reason });
      setCoverage(entry, 'lexical', reason);
      continue;
    }
    if (!cached) continue;
    if (cached.size > limit) {
      const reason = `${cached.rel} is ${cached.size} bytes, over adapters.scip.max_index_bytes (${limit})`;
      state.set(entry.language, { kind: 'blocked', reason });
      setCoverage(entry, 'lexical', reason);
      continue;
    }
    const problem = indexTrustProblem(ctx.root, cached, coveredPaths(ctx.root, cached));
    if (problem) {
      note(ctx, `SCIP index not used: ${problem}`);
      state.set(entry.language, { kind: 'blocked', reason: problem });
      setCoverage(entry, 'lexical', problem);
      continue;
    }
    cacheEntries.push(cached);
    state.set(entry.language, { kind: 'cache', entry: cached });
    setCoverage(entry, 'semantic', 'local SCIP cache');
  }

  if (options.run !== true) {
    for (const entry of marked) {
      if (state.has(entry.language)) continue;
      const reason = 'SCIP indexing is disabled (adapters.scip.run is false)';
      state.set(entry.language, { kind: 'blocked', reason });
      setCoverage(entry, 'lexical', reason);
    }
  }

  if (options.run === true) {
    const budgets = runBudgets(options);
    for (const entry of marked) {
      if (state.has(entry.language)) continue;
      if (typeof ctx.exec !== 'function') {
        const reason = 'SCIP indexing is enabled, but this verification pass does not execute indexers';
        state.set(entry.language, { kind: 'blocked', reason });
        setCoverage(entry, 'lexical', reason);
        continue;
      }
      if (!executableOnPath(entry.executable)) {
        const reason = `${entry.executable} is not installed on PATH`;
        state.set(entry.language, { kind: 'blocked', reason });
        setCoverage(entry, 'lexical', reason);
        continue;
      }
      const fresh = freshOutput(ctx, entry);
      if (fresh.problem) {
        state.set(entry.language, { kind: 'blocked', reason: fresh.problem });
        setCoverage(entry, 'lexical', fresh.problem);
        continue;
      }
      let result;
      try {
        result = await ctx.exec(indexerArgv(entry, fresh.target.abs), {
          timeoutMs: budgets.timeoutMs,
          memoryMb: budgets.memoryMb,
          writable: [fresh.target.abs],
        });
      } catch (err) {
        removeFile(fresh.target.abs);
        const reason = `${entry.executable} was not run: ${err.message}`;
        state.set(entry.language, { kind: 'blocked', reason });
        setCoverage(entry, 'lexical', reason);
        continue;
      }
      if (result.exitCode !== 0 || result.record?.timed_out || result.record?.memory_exceeded) {
        removeFile(fresh.target.abs);
        const reason = failureReason(entry, result);
        state.set(entry.language, { kind: 'blocked', reason });
        setCoverage(entry, 'lexical', reason);
        continue;
      }
      const problem = outputProblem(entry, fresh.target, limit);
      if (problem) {
        removeFile(fresh.target.abs);
        state.set(entry.language, { kind: 'blocked', reason: problem });
        setCoverage(entry, 'lexical', problem);
        continue;
      }
      const output = regularEntry(ctx.root, cacheRel(entry));
      if (!output) {
        removeFile(fresh.target.abs);
        const reason = `${cacheRel(entry)} was not a regular file after indexing`;
        state.set(entry.language, { kind: 'blocked', reason });
        setCoverage(entry, 'lexical', reason);
        continue;
      }
      cacheEntries.push(output);
      state.set(entry.language, { kind: 'generated', entry: output });
      setCoverage(entry, 'semantic', `${entry.executable} generated a SCIP index`);
    }
  }

  const entries = [...supplied, ...cacheEntries];
  // Preserve the former no-index behaviour for the default (`run: false`): no SCIP section
  // and no new coverage noise when there is no person-supplied or safe cache index.
  if (!entries.length) {
    if (options.run === true && marked.length) {
      ctx.stats.scip = {
        indexes: [], documents: 0, covered: 0, symbols_defined: 0, ms: 0,
        coverage: Object.fromEntries([...coverage].sort(([a], [b]) => (a < b ? -1 : 1))),
      };
    }
    return [];
  }
  for (const entry of entries) {
    if (entry.size > limit) throw new UnknotError('UK_BUDGET_EXCEEDED', `${entry.rel} is ${entry.size} bytes, over adapters.scip.max_index_bytes (${limit})`);
  }

  const mods = new Map();
  const typeIds = new Map(); // path\0name → id of a type node another adapter already made
  for (const [path, facts] of ctx.factsByFile) {
    for (const fact of facts) {
      if (fact.kind !== 'node') continue;
      if (fact.type === 'module' && !mods.has(path)) mods.set(path, fact);
      else if ((fact.type === 'class' || fact.type === 'interface') && !typeIds.has(`${path}\0${fact.name}`)) typeIds.set(`${path}\0${fact.name}`, fact.id);
    }
  }
  // The names a language's templates mention: the index does not cover them, so a member named
  // there may be read (a Razor view reads `Model.SearchModel`) and is never reported unused.
  const templateNames = new Map();
  for (const row of INDEXERS.filter((r) => r.templates)) {
    const names = new Set();
    for (const [path, file] of ctx.files ?? []) {
      if (!matchAny(path, row.templates) || (file?.size ?? 0) > MAX_TEMPLATE_BYTES) continue;
      let text;
      try { text = readFileSync(resolveInside(ctx.root, path).real, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/[A-Za-z_]\w*/g)) names.add(m[0]);
    }
    if (names.size) for (const language of row.languages) templateNames.set(language, names);
  }
  const res = analyzeIndex(entries.map((entry) => entry.abs), { root: ctx.root, hasFile: (path) => mods.has(path), templateNames });
  const tool = res.tools.join(', ');
  const out = [];

  for (const [path, info] of [...res.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const mod = mods.get(path);
    mod.attrs.parse_quality = 'semantic'; // the coverage report reads the module fact as extracted
    const unref = info.members.filter((member) => !member.refs).map((member) => `${member.owner ? `${member.owner}.` : ''}${member.name}`).sort();
    out.push(nodeFact('module', path, {
      name: path,
      path,
      attrs: {
        parse_quality: 'semantic',
        semantic: { definitions: info.definitions, types: info.types, members: info.members.length, unreferenced: unref.slice(0, MAX_LISTED), unreferenced_count: unref.length, ...(tool && { indexer: tool }) },
      },
    }, pv(path, 1)));
    ctx.semantic?.set(path, { declared: new Map((res.deps.get(path) ?? []).map((dependency) => [dependency.to, dependency])) });
  }

  // A row can cover several source languages. Only call it semantic when this map actually
  // matched a file of that language; otherwise the lexical fallback and its reason stay visible.
  const resolvedLanguages = new Set([...res.files.keys()].map((path) => String(ctx.files.get(path)?.language ?? '').toLowerCase()));
  for (const entry of marked) {
    const source = state.get(entry.language);
    if (!source || !['supplied', 'cache', 'generated'].includes(source.kind)) continue;
    for (const language of presentLanguages(entry, ctx.files)) {
      if (!resolvedLanguages.has(language)) coverage.set(language, { quality: 'lexical', reason: `${coverage.get(language)?.reason ?? 'SCIP index'} did not cover a mapped ${language} file` });
    }
  }

  // Types: one node per defined type (made here only when no other adapter named it), then inheritance.
  const idOf = new Map();
  const typeNode = (typeInfo) => {
    const key = `${typeInfo.path}\0${typeInfo.name}`;
    if (idOf.has(key)) return idOf.get(key);
    let id = typeIds.get(key);
    if (!id) {
      const type = typeInfo.interface ? 'interface' : 'class';
      const typeKey = `${typeInfo.path}#${typeInfo.name}`;
      id = `${type}:${typeKey}`;
      out.push(nodeFact(type, typeKey, { name: typeInfo.name, path: typeInfo.path, attrs: { language: res.files.get(typeInfo.path)?.language ?? null, start_line: typeInfo.line } }, pv(typeInfo.path, typeInfo.line)));
      out.push(edgeFact('CONTAINS', `module:${typeInfo.path}`, id, {}, pv(typeInfo.path, typeInfo.line)));
    }
    idOf.set(key, id);
    return id;
  };
  for (const typeInfo of res.types) typeNode(typeInfo);
  for (const relation of res.inherits) out.push(edgeFact(relation.edge, typeNode(relation.from), typeNode(relation.to), { via: 'scip' }, pv(relation.from.path, relation.from.line)));

  for (const relation of res.links) {
    if (relation.refs) out.push(edgeFact('REFERENCES', `module:${relation.from}`, `module:${relation.to}`, { via: 'scip', count: relation.refs }, pv(relation.from, relation.line)));
    if (relation.calls) out.push(edgeFact('CALLS', `module:${relation.from}`, `module:${relation.to}`, { via: 'scip', count: relation.calls }, pv(relation.from, relation.callLine)));
  }

  ctx.stats.scip = {
    indexes: entries.map((entry) => entry.rel),
    documents: res.stats.documents,
    covered: res.stats.matched,
    symbols_defined: res.stats.symbols_defined,
    ms: res.stats.ms,
    ...(marked.length && { coverage: Object.fromEntries([...coverage].sort(([a], [b]) => (a < b ? -1 : 1))) }),
    ...(tool && { indexer: tool }),
  };
  if (res.stats.unmatched) note(ctx, `scip: ${res.stats.unmatched} of ${res.stats.documents} index documents matched no mapped file (generated, ignored, outside the scope or the index is for another checkout)`);
  return out;
}

export default {
  id: 'scip',
  version: VERSION,
  kind: 'language',
  capabilities: { files: [], executes: [], network: false },
  link,
};
