// Text search with the map's context. Runbooks, alerts and settings are made of strings
// (metric names, setting keys, role names, feature flags, durations) that a dependency graph
// does not index. `searchText` finds where a string occurs in the files the map covers, tells a
// definition (a constant or config key holding it) from a use, follows a constant one hop to
// where its name is used, and attributes each hit to its module, kind and owners.

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

/**
 * @param {string} root
 * @param {{config: object, text: string, regex?: boolean, scope?: string[], graph?: import('./graph.mjs').Graph, limit?: number}} opts
 */
export function searchText(root, { config, text, regex = false, scope = [], graph = null, limit = 200 }) {
  const pattern = regex ? new RegExp(text) : null;
  const matches = (line) => (pattern ? pattern.test(line) : line.includes(text));
  const files = census(root, { config, scope }).files.filter((f) => KINDS.has(f.kind) && !f.too_large && !f.context);
  const hits = [];
  const scan = (want, push) => {
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
  scan((body) => (pattern ? pattern.test(body) : body.includes(text)), (f, line, at) => {
    if (!matches(line)) return false;
    hits.push({ path: f.path, line: at, kind: f.kind, text: line.trim().slice(0, 240), definition: regex ? null : definitionOn(line, text) });
    return true;
  });
  // A constant holding the string is how code usually refers to it: follow its name once.
  const constants = [...new Set(hits.filter((h) => h.definition?.kind === 'constant').map((h) => h.definition.name))].filter((n) => n.length >= 3);
  const via = [];
  if (constants.length) {
    const word = new RegExp(`\\b(${constants.map(escapeRe).join('|')})\\b`);
    scan((body) => word.test(body), (f, line, at) => {
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
    files_searched: files.length,
    definitions: hits.filter((h) => h.definition).slice(0, limit).map(withContext),
    uses: hits.filter((h) => !h.definition).slice(0, limit).map(withContext),
    via_constants: via.slice(0, limit).map(withContext),
    counts: { hits: hits.length, definitions: hits.filter((h) => h.definition).length, uses: hits.filter((h) => !h.definition).length, via_constants: via.length, by_kind: byKind(hits) },
    truncated: hits.length > limit || via.length > limit,
  };
}
