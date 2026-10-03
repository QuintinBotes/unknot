// CODEOWNERS (GitHub and GitLab flavours) and Chromium-style OWNERS files.
//
// Extraction emits the owner nodes plus one `file:<path>` node carrying the ordered rule
// list (pattern, Unknot glob, owner ids, line). `link` evaluates those rules against every
// path-bearing node with last-match-wins semantics, so the rule order must be preserved.

import { nodeFact } from '../../runtime/graph/facts.mjs';
import {
  P, parseOwnerToken, ownerNode, ownerId, capFacts, clean, dirname, uniqSorted,
} from './util.mjs';

/**
 * gitignore-style pattern -> Unknot glob (anchored at the repo root).
 *   no slash        `*.js`      -> `**\/*.js`
 *   leading slash   `/docs/x`   -> `docs/x`
 *   trailing slash  `apps/`     -> `**\/apps/**`
 * Link additionally matches `<glob>/**` so a rule naming a directory covers its contents.
 */
export function patternToGlob(pattern) {
  let p = pattern.replace(/\\([# ])/g, '$1');
  const anchored = p.startsWith('/');
  if (anchored) p = p.replace(/^\/+/, '');
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.replace(/\/+$/, '');
  if (p === '') return '**';
  let g = !anchored && !p.includes('/') ? `**/${p}` : p;
  if (dirOnly) g += '/**';
  return g;
}

/** Split on unescaped whitespace; a token starting with `#` begins a comment. */
function tokens(line) {
  const out = [];
  for (const t of line.split(/(?<!\\)\s+/)) {
    if (t === '') continue;
    if (t.startsWith('#') && out.length > 0) break;
    out.push(t);
  }
  return out;
}

export function parseCodeowners(path, text) {
  const owners = new Map();
  const rules = [];
  let sectionDefault = [];
  const toIds = (list, line) => {
    const ids = [];
    for (const tok of list) {
      const o = parseOwnerToken(tok);
      if (!o) continue;
      const id = ownerId(o);
      if (!owners.has(id)) owners.set(id, ownerNode(o, P(path, line)));
      ids.push(id);
    }
    return ids;
  };
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const sec = /^\^?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (sec) {
      sectionDefault = toIds(tokens(sec[2]), idx + 1);
      return;
    }
    const [pattern, ...rest] = tokens(line);
    let ids = toIds(rest, idx + 1);
    // GitLab: a rule without owners inherits the section default.
    if (ids.length === 0 && rest.length === 0) ids = sectionDefault;
    rules.push({ line: idx + 1, pattern, glob: patternToGlob(pattern), owners: ids });
  });
  const facts = [
    nodeFact('file', path, {
      name: path,
      path,
      attrs: { codeowners: true, rule_count: rules.length, rules: rules.slice(0, 2000), ...(rules.length > 2000 ? { truncated: true } : {}) },
    }, P(path, 1)),
    ...[...owners].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, f]) => f),
  ];
  return capFacts(facts);
}

/** Chromium OWNERS: one directory's owners, `per-file` overrides, `set noparent`, `file://` includes. */
export function parseOwnersFile(path, text) {
  const owners = new Map();
  const direct = [];
  const perFile = [];
  const includes = [];
  let noparent = false;
  let anyone = false;
  const ids = (list, line) => {
    const out = [];
    for (const tok of list) {
      if (tok === '*') { anyone = true; continue; }
      const o = parseOwnerToken(tok);
      if (!o) continue;
      const id = ownerId(o);
      if (!owners.has(id)) owners.set(id, ownerNode(o, P(path, line)));
      out.push(id);
    }
    return out;
  };
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const n = idx + 1;
    if (/^set\s+noparent$/.test(line)) noparent = true;
    else if (line.startsWith('per-file ')) {
      const m = /^per-file\s+([^=]+?)\s*=\s*(.+)$/.exec(line);
      if (!m) return;
      const targets = m[2].split(',').map((s) => s.trim()).filter(Boolean);
      perFile.push({
        globs: m[1].split(',').map((s) => s.trim()).filter(Boolean),
        owners: ids(targets.filter((t) => !t.startsWith('file://')), n),
        includes: targets.filter((t) => t.startsWith('file://')).map((t) => t.slice(7).replace(/^\/+/, '')),
        noparent: targets.includes('set noparent') || undefined,
      });
    } else if (line.startsWith('file://')) includes.push(line.slice(7).replace(/^\/+/, ''));
    else direct.push(...ids(line.split(/[\s,]+/), n));
  });
  const dir = dirname(path);
  return capFacts([
    nodeFact('file', path, {
      name: path,
      path,
      attrs: clean({
        owners_file: true,
        dir,
        owners: uniqSorted(direct),
        noparent: noparent || undefined,
        anyone: anyone || undefined,
        includes: uniqSorted(includes),
        per_file: perFile.map((p) => clean({ ...p, owners: uniqSorted(p.owners) })),
      }),
    }, P(path, 1)),
    ...[...owners].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, f]) => f),
  ]);
}
