// Text search with the map's context. Runbooks, alerts and settings are made of strings
// (metric names, setting keys, role names, feature flags, durations) that a dependency graph
// does not index. `searchText` finds where a string occurs in the files the map covers, tells a
// definition (a constant or config key holding it) from a use, follows a constant one hop to
// where its name is used, and attributes each hit to its module, kind and owners.

import { readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { census, censusPlan, readEntry } from './census.mjs';

const KINDS = new Set(['source', 'test', 'config', 'doc', 'other']);
const MAX_FILE_HITS = 50;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A line that binds the string to a name: `const string Name = "x"`, `NAME = 'x'`,
 * `static final String NAME = "x"`, `name: "x"`, or a JSON/YAML/INI key `"x":` / `x:` / `x =`.
 * @returns {{kind: 'constant'|'key', name: string}|null}
 */
export function definitionOn(line, text) {
  const q = `["'\`]${escapeRe(text)}["'\`]`;
  const constant = new RegExp(`([A-Za-z_$][\\w$]*)\\s*(?::\\s*[\\w<>\\[\\]?, .]+)?\\s*[:=]\\s*(?:[@$]?)${q}`).exec(line);
  if (constant && !/^(if|while|return|case|when)$/.test(constant[1])) return { kind: 'constant', name: constant[1] };
  if (new RegExp(`^\\s*(?:-\\s*)?(?:${q}|${escapeRe(text)})\\s*[:=]`).test(line)) return { kind: 'key', name: text };
  return null;
}

const MAX_CONSTANTS = 20;

/**
 * The constant nodes whose string is `text` (first) or starts with it, with each definition and use site
 * (the facts behind the edges, one per line), or null when none is indexed. An exact match does not
 * hide the constants that extend it. Exact and prefix matches only: an answer from the graph never looks at files, so it cannot say a string is absent.
 */
function fromGraph(root, { text, graph, store, scope, limit }) {
  const exact = graph.node(`constant:${text}`);
  const longer = graph.nodes('constant').filter((n) => n.name !== text && n.name.startsWith(text)).sort((a, b) => (a.name < b.name ? -1 : 1));
  const matches = exact ? [exact, ...longer] : longer;
  if (!matches.length) return null;
  const shown = matches.slice(0, MAX_CONSTANTS);
  const lines = new Map();
  const lineAt = (path, line) => {
    if (!lines.has(path)) {
      try {
        lines.set(path, readFileSync(join(root, path), 'utf8').split('\n'));
      } catch {
        lines.set(path, []);
      }
    }
    return (lines.get(path)[line - 1] ?? '').trim().slice(0, 240);
  };
  const inScope = (path) => !scope.length || scope.some((s) => path === s || path.startsWith(s.endsWith('/') ? s : `${s}/`));
  const context = (path) => {
    const id = `module:${path}`;
    const owners = graph.out(id, 'OWNED_BY').map((e) => graph.node(e.to)?.name ?? e.to);
    const n = graph.node(id);
    return { module: n ? id : null, ...(owners.length && { owners }), ...(n?.attrs?.language && { language: n.attrs.language }) };
  };
  const definitions = [];
  const uses = [];
  const via_constants = [];
  const constants = shown.map((n) => {
    const rows = store.all("SELECT subject, predicate, source_ref, attrs FROM facts WHERE kind = 'edge' AND object = ? AND predicate IN ('DEFINES', 'REFERENCES') ORDER BY source_ref", n.id);
    const sites = rows.map((r) => {
      const a = JSON.parse(r.attrs);
      const path = r.subject.replace(/^module:/, '');
      return { path, line: a.line ?? Number(r.source_ref?.split(':').pop()) ?? 1, form: a.form, name: a.name, via: a.via, type: r.predicate };
    }).filter((x) => inScope(x.path));
    for (const x of sites) {
      const hit = { path: x.path, line: x.line, kind: graph.node(`module:${x.path}`)?.attrs?.is_test ? 'test' : 'source', text: lineAt(x.path, x.line), constant: n.name, ...context(x.path) };
      if (x.type === 'DEFINES') definitions.push({ ...hit, definition: x.form === 'constant' ? { kind: 'constant', name: x.name } : { kind: 'key', name: n.name } });
      else if (x.form === 'name') via_constants.push({ ...hit, constant: x.via });
      else uses.push(hit);
    }
    const a = n.attrs;
    return { value: n.name, subkind: a.subkind, subkind_basis: a.subkind_basis, subkind_evidence: a.subkind_evidence, defined: a.defined, definitions: sites.filter((x) => x.type === 'DEFINES').length, uses: sites.filter((x) => x.type !== 'DEFINES').length };
  });
  const n = definitions.length + uses.length + via_constants.length;
  return {
    text,
    regex: false,
    answered_by: 'graph',
    answered_by_note: `answered from ${exact ? `the constant node${longer.length ? ` and ${longer.length} constant(s) that start with the text` : ''}` : `${matches.length} constant node(s) starting with the text`}; docs and strings that are not constants are not in the index (use scan: true to scan the files)`,
    constants,
    constants_matched: matches.length,
    constants_left_out: matches.length - shown.length,
    files_searched: 0,
    definitions: definitions.slice(0, limit),
    uses: uses.slice(0, limit),
    via_constants: via_constants.slice(0, limit),
    counts: { hits: n, definitions: definitions.length, uses: uses.length, via_constants: via_constants.length, by_kind: {} },
    truncated: matches.length > shown.length || definitions.length > limit || uses.length > limit || via_constants.length > limit,
  };
}

const SCAN_BUDGET_MS = 60_000;
const SCAN_CONCURRENCY = 64;
const CACHE_BYTES = 256 * 1024 * 1024;
const PROGRESS_AFTER_MS = 3000;
const PROGRESS_EVERY_MS = 1000;

/** The occurrences of the text in a file's lines (at most MAX_FILE_HITS), as scan hits. */
function hitsIn(f, body, m) {
  if (!m.body(body)) return [];
  const out = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_FILE_HITS; i++) {
    if (!m.line(lines[i])) continue;
    out.push({ path: f.path, line: i + 1, kind: f.kind, text: lines[i].trim().slice(0, 240), definition: m.regex ? null : definitionOn(lines[i], m.text) });
  }
  return out;
}

/** Lines of a file that use a constant's name without containing the text (one hop). */
function viaIn(f, body, word, m) {
  if (!word.test(body)) return [];
  const out = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_FILE_HITS; i++) {
    const hit = word.exec(lines[i]);
    if (!hit || m.line(lines[i])) continue;
    out.push({ path: f.path, line: i + 1, kind: f.kind, constant: hit[1], text: lines[i].trim().slice(0, 240) });
  }
  return out;
}

const matcherFor = (text, regex) => {
  const pattern = regex ? new RegExp(text) : null;
  return { text, regex, body: (b) => (pattern ? pattern.test(b) : b.includes(text)), line: (l) => (pattern ? pattern.test(l) : l.includes(text)) };
};

const constantNames = (hits) => [...new Set(hits.filter((h) => h.definition?.kind === 'constant').map((h) => h.definition.name))].filter((n) => n.length >= 3);
const wordFor = (names) => new RegExp(`\\b(${names.map(escapeRe).join('|')})\\b`);

/**
 * The scan's result. `budget` says how far the scan got: the files in scope, and how many the
 * time budget cut off (`via_unscanned` for the second pass, which looks for uses of a
 * constant's name).
 */
function scanResult({ text, regex, scan, graph, files, hits, via, limit, budget }) {
  const context = (path) => {
    if (!graph) return {};
    const id = `module:${path}`;
    const owners = graph.out(id, 'OWNED_BY').map((e) => graph.node(e.to)?.name ?? e.to);
    const n = graph.node(id);
    return { module: n ? id : null, ...(owners.length && { owners }), ...(n?.attrs?.language && { language: n.attrs.language }) };
  };
  const withContext = (h) => ({ ...h, ...context(h.path) });
  const byKind = (list) => list.reduce((m, h) => ((m[h.kind] = (m[h.kind] ?? 0) + 1), m), {});
  const partial = budget.unscanned > 0 || budget.via_unscanned > 0;
  const notice = partial
    ? `partial result: the ${budget.seconds} s time budget ran out; ${budget.unscanned} of ${budget.total} file(s) were not scanned${budget.via_unscanned ? `, and ${budget.via_unscanned} file(s) were not checked for uses of a matching constant's name` : ''}. Raise it with --budget-seconds, or narrow with a scope.`
    : null;
  return {
    text,
    regex,
    answered_by: 'scan',
    answered_by_note: scan ? 'scanned the files as asked' : regex ? 'a regex is always scanned for' : graph ? 'not an indexed constant (no constant node equals or starts with the text), so the files were scanned' : 'no map yet, so the files were scanned',
    files_searched: files,
    definitions: hits.filter((h) => h.definition).slice(0, limit).map(withContext),
    uses: hits.filter((h) => !h.definition).slice(0, limit).map(withContext),
    via_constants: via.slice(0, limit).map(withContext),
    counts: { hits: hits.length, definitions: hits.filter((h) => h.definition).length, uses: hits.filter((h) => !h.definition).length, via_constants: via.length, by_kind: byKind(hits) },
    truncated: hits.length > limit || via.length > limit,
    partial,
    ...(partial && { files_not_scanned: budget.unscanned + budget.via_unscanned, notice }),
  };
}

const scanKinds = (f) => KINDS.has(f.kind) && !f.too_large && !f.context;

/**
 * An exact or prefix match on an indexed constant is answered from the graph; anything else
 * (a regex, a string that is not a constant, docs) is scanned for in the files. This form reads
 * the files one after another, so it is for callers that cannot wait on a promise (the MCP
 * server); `searchTextConcurrent` is the same search for the CLI, reading files in parallel.
 * `budgetSeconds` bounds the scan; the result says how many files it did not reach.
 * @param {string} root
 * @param {{config: object, text: string, regex?: boolean, scope?: string[], graph?: import('./graph.mjs').Graph, store?: object, scan?: boolean, limit?: number, budgetSeconds?: number, now?: () => number}} opts
 */
export function searchText(root, { config, text, regex = false, scope = [], graph = null, store = null, scan = false, limit = 200, budgetSeconds = SCAN_BUDGET_MS / 1000, now = Date.now }) {
  if (!regex && !scan && graph && store) {
    const r = fromGraph(root, { text, graph, store, scope, limit });
    if (r) return r;
  }
  const m = matcherFor(text, regex);
  const deadline = now() + budgetSeconds * 1000;
  const files = census(root, { config, scope }).files.filter(scanKinds);
  const budget = { seconds: budgetSeconds, total: files.length, unscanned: 0, via_unscanned: 0 };
  const read = (f) => {
    try {
      return readEntry(root, f);
    } catch {
      return null;
    }
  };
  const hits = [];
  let i = 0;
  for (; i < files.length && now() < deadline; i++) {
    const body = read(files[i]);
    if (body !== null) hits.push(...hitsIn(files[i], body, m));
  }
  budget.unscanned = files.length - i;
  const via = [];
  const names = constantNames(hits);
  if (names.length) {
    const word = wordFor(names);
    let j = 0;
    for (; j < i && now() < deadline; j++) {
      const body = read(files[j]);
      if (body !== null) via.push(...viaIn(files[j], body, word, m));
    }
    budget.via_unscanned = i - j;
  }
  return scanResult({ text, regex, scan, graph, files: files.length, hits, via, limit, budget });
}

/** Run `work(item, index)` over `items` with at most `n` in flight; stops starting new ones when `stop()` is true. Resolves to how many ran. */
async function pool(items, n, work, stop) {
  let next = 0;
  let ran = 0;
  const lane = async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      await work(items[i], i);
      ran++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return ran;
}

/**
 * `searchText` for the CLI: the same answer, but the scan stats and reads files concurrently
 * (a serial loop waits out each file's I/O latency in turn, which on a slow or busy file system
 * is almost all of its time), classifies each file from the bytes it has already read instead of
 * opening it twice, and never opens a file the census excludes (secrets, binaries by extension,
 * vendored and generated paths, files over the size limit). It stops after `budgetSeconds` and
 * says how many files it did not reach, and calls `onProgress(done, total, phase)` at most once
 * a second once it has run longer than `progressAfterMs`.
 * @param {string} root
 * @param {Parameters<typeof searchText>[1] & {onProgress?: (done: number, total: number, phase: string) => void, progressAfterMs?: number, concurrency?: number}} opts
 */
export async function searchTextConcurrent(root, opts) {
  const { config, text, regex = false, scope = [], graph = null, store = null, scan = false, limit = 200, budgetSeconds = SCAN_BUDGET_MS / 1000, now = Date.now, onProgress = null, progressAfterMs = PROGRESS_AFTER_MS, concurrency = SCAN_CONCURRENCY } = opts;
  if (!regex && !scan && graph && store) {
    const r = fromGraph(root, { text, graph, store, scope, limit });
    if (r) return r;
  }
  const m = matcherFor(text, regex);
  const started = now();
  const deadline = started + budgetSeconds * 1000;
  const over = () => now() >= deadline;
  let lastReport = started;
  const report = (done, total, phase) => {
    const t = now();
    if (!onProgress || t - started < progressAfterMs || t - lastReport < PROGRESS_EVERY_MS) return;
    lastReport = t;
    onProgress(done, total, phase);
  };
  const plan = censusPlan(root, { config, scope, blobs: false });
  const cands = plan.candidates;
  const total = cands.length;
  const kept = new Array(total).fill(null); // the scannable entry of each candidate
  const found = new Array(total).fill(null); // hits per candidate, in path order
  const cache = new Map(); // bodies kept in memory (up to a limit) for the second pass
  let cached = 0;
  let finished = 0;
  const ran = await pool(cands, concurrency, async (c, i) => {
    try {
      const abs = join(root, c.path);
      const st = await lstat(abs);
      const fixed = plan.fixedKind(c.path, st);
      if (fixed !== undefined || st.size > plan.maxBytes) return;
      const buf = await readFile(abs);
      const f = plan.entry(c, st, buf.subarray(0, 4096), fixed);
      if (!f || !scanKinds(f)) return;
      kept[i] = f;
      const body = buf.toString('utf8');
      found[i] = hitsIn(f, body, m);
      if (cached + buf.length <= CACHE_BYTES) {
        cache.set(i, body);
        cached += buf.length;
      }
    } catch {
      // unreadable or vanished: not a hit, same as the serial scan
    } finally {
      report(++finished, total, 'scanning');
    }
  }, over);
  const hits = found.flat().filter(Boolean);
  const budget = { seconds: budgetSeconds, total, unscanned: total - ran, via_unscanned: 0 };
  const via = [];
  const names = constantNames(hits);
  const second = kept.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  if (names.length && second.length) {
    const word = wordFor(names);
    const out = new Array(kept.length).fill(null);
    let n = 0;
    const checked = await pool(second, concurrency, async (i) => {
      try {
        const body = cache.get(i) ?? (await readFile(join(root, kept[i].path))).toString('utf8');
        out[i] = viaIn(kept[i], body, word, m);
      } catch {
        // unreadable or vanished
      } finally {
        report(++n, second.length, 'following constant names');
      }
    }, over);
    budget.via_unscanned = second.length - checked;
    via.push(...out.flat().filter(Boolean));
  }
  return scanResult({ text, regex, scan, graph, files: kept.filter(Boolean).length, hits, via, limit, budget });
}
