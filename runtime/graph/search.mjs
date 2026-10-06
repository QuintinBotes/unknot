// Text search with the map's context. Runbooks, alerts and settings are made of strings
// (metric names, setting keys, role names, feature flags, durations) that a dependency graph
// does not index. `searchText` finds where a string occurs in the files the map covers, tells a
// definition (a constant or config key holding it) from a use, follows a constant one hop to
// where its name is used, and attributes each hit to its module, kind and owners.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { census, readEntry } from './census.mjs';

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
 * The constant nodes whose string is `text` or starts with it, with each definition and use site
 * (the facts behind the edges, one per line), or null when none is indexed. Exact and prefix
 * matches only: an answer from the graph never looks at files, so it cannot say a string is absent.
 */
function fromGraph(root, { text, graph, store, scope, limit }) {
  const exact = graph.node(`constant:${text}`);
  const matches = exact ? [exact] : graph.nodes('constant').filter((n) => n.name.startsWith(text)).sort((a, b) => (a.name < b.name ? -1 : 1));
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
    answered_by_note: `answered from ${exact ? 'the constant node' : `${matches.length} constant node(s) starting with the text`}; docs and strings that are not constants are not in the index (use scan: true to scan the files)`,
    constants,
    constants_matched: matches.length,
    files_searched: 0,
    definitions: definitions.slice(0, limit),
    uses: uses.slice(0, limit),
    via_constants: via_constants.slice(0, limit),
    counts: { hits: n, definitions: definitions.length, uses: uses.length, via_constants: via_constants.length, by_kind: {} },
    truncated: matches.length > shown.length || definitions.length > limit || uses.length > limit || via_constants.length > limit,
  };
}

/**
 * An exact or prefix match on an indexed constant is answered from the graph; anything else
 * (a regex, a string that is not a constant, docs) is scanned for in the files.
 * @param {string} root
 * @param {{config: object, text: string, regex?: boolean, scope?: string[], graph?: import('./graph.mjs').Graph, store?: object, scan?: boolean, limit?: number}} opts
 */
export function searchText(root, { config, text, regex = false, scope = [], graph = null, store = null, scan = false, limit = 200 }) {
  if (!regex && !scan && graph && store) {
    const r = fromGraph(root, { text, graph, store, scope, limit });
    if (r) return r;
  }
  const pattern = regex ? new RegExp(text) : null;
  const matches = (line) => (pattern ? pattern.test(line) : line.includes(text));
  const files = census(root, { config, scope }).files.filter((f) => KINDS.has(f.kind) && !f.too_large && !f.context);
  const hits = [];
  const walk = (want, push) => {
    for (const f of files) {
      let body;
      try {
        body = readEntry(root, f).toString('utf8');
      } catch {
        continue;
      }
      if (!want(body)) continue;
      let n = 0;
      const lines = body.split('\n');
      for (let i = 0; i < lines.length && n < MAX_FILE_HITS; i++) if (push(f, lines[i], i + 1)) n++;
    }
  };
  walk((body) => (pattern ? pattern.test(body) : body.includes(text)), (f, line, at) => {
    if (!matches(line)) return false;
    hits.push({ path: f.path, line: at, kind: f.kind, text: line.trim().slice(0, 240), definition: regex ? null : definitionOn(line, text) });
    return true;
  });
  // A constant holding the string is how code usually refers to it: follow its name once.
  const constants = [...new Set(hits.filter((h) => h.definition?.kind === 'constant').map((h) => h.definition.name))].filter((n) => n.length >= 3);
  const via = [];
  if (constants.length) {
    const word = new RegExp(`\\b(${constants.map(escapeRe).join('|')})\\b`);
    walk((body) => word.test(body), (f, line, at) => {
      const m = word.exec(line);
      if (!m || matches(line)) return false;
      via.push({ path: f.path, line: at, kind: f.kind, constant: m[1], text: line.trim().slice(0, 240) });
      return true;
    });
  }
  const context = (path) => {
    if (!graph) return {};
    const id = `module:${path}`;
    const owners = graph.out(id, 'OWNED_BY').map((e) => graph.node(e.to)?.name ?? e.to);
    const n = graph.node(id);
    return { module: n ? id : null, ...(owners.length && { owners }), ...(n?.attrs?.language && { language: n.attrs.language }) };
  };
  const withContext = (h) => ({ ...h, ...context(h.path) });
  const byKind = (list) => list.reduce((m, h) => ((m[h.kind] = (m[h.kind] ?? 0) + 1), m), {});
  return {
    text,
    regex,
    answered_by: 'scan',
    answered_by_note: scan ? 'scanned the files as asked' : regex ? 'a regex is always scanned for' : graph ? 'not an indexed constant (no constant node equals or starts with the text), so the files were scanned' : 'no map yet, so the files were scanned',
    files_searched: files.length,
    definitions: hits.filter((h) => h.definition).slice(0, limit).map(withContext),
    uses: hits.filter((h) => !h.definition).slice(0, limit).map(withContext),
    via_constants: via.slice(0, limit).map(withContext),
    counts: { hits: hits.length, definitions: hits.filter((h) => h.definition).length, uses: hits.filter((h) => !h.definition).length, via_constants: via.length, by_kind: byKind(hits) },
    truncated: hits.length > limit || via.length > limit,
  };
}
