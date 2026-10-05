// Ownership adapter: CODEOWNERS, OWNERS, Backstage catalogs and ADRs (spec §9.4 step 11).
// Extraction reads each file in isolation; `link` joins the rules and records to the node
// set the other adapters produced (OWNED_BY, SUPERSEDES, DESCRIBED_BY).
//
// Privacy: e-mail owners are stored only as a sha256 prefix (see util.mjs). ADR titles and
// summaries have e-mail addresses redacted before they reach a fact.

import { nodeFact, edgeFact } from '../../runtime/graph/facts.mjs';
import { matchAny } from '../../runtime/core/glob.mjs';
import { parseCodeowners, parseOwnersFile } from './codeowners.mjs';
import { parseCatalog } from './catalog.mjs';
import { parseAdr, isAdrCandidate } from './adr.mjs';
import {
  ID, VERSION, P, basename, dirname, keyOf, uniqSorted,
} from './util.mjs';

const ADR_GLOBS = ['docs/adr/**', 'docs/decisions/**', 'doc/adr/**', 'doc/architecture/decisions/**', 'adr/**', '**/*.adr.md'];
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'];
// Node types that can be owned when they carry a path (or a service's code_root).
const OWNABLE = new Set(['module', 'file', 'package', 'workload', 'service', 'resource']);
const DOCUMENTED = new Set(['module', 'service', 'package', 'workload']);

const nodesOf = (factsByFile) => {
  const out = [];
  for (const path of [...factsByFile.keys()].sort()) for (const f of factsByFile.get(path)) if (f.kind === 'node') out.push(f);
  return out;
};

/** The repo path an ownable node stands for: its path, else a service's code root. */
const pathOf = (n) => n.path ?? (typeof n.attrs?.code_root === 'string' ? n.attrs.code_root : null);

export default {
  id: ID,
  version: VERSION,
  kind: 'ownership',
  capabilities: {
    files: [
      'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS', '**/catalog-info.{yaml,yml}', '**/OWNERS',
      'docs/adr/**', 'docs/decisions/**', 'doc/adr/**', 'doc/architecture/decisions/**', 'adr/**', '**/*.adr.md',
    ],
    // Read even when the scope excludes them (see census CONTEXT_FILES).
    context_files: CODEOWNERS_PATHS,
    executes: [],
    network: false,
  },

  extract(file, text) {
    const { path } = file;
    const base = basename(path);
    if (CODEOWNERS_PATHS.includes(path)) return parseCodeowners(path, text);
    if (base === 'OWNERS') return parseOwnersFile(path, text);
    if (/^catalog-info\.ya?ml$/.test(base)) return parseCatalog(path, text);
    if (matchAny(path, ADR_GLOBS) && isAdrCandidate(path)) return parseAdr(path, text);
    return [];
  },

  link(ctx) {
    const nodes = nodesOf(ctx.factsByFile);
    const out = [];
    const ownable = new Map();
    for (const n of nodes) {
      if (!OWNABLE.has(n.type) || n.attrs?.codeowners || n.attrs?.owners_file) continue;
      if (pathOf(n) !== null && !ownable.has(n.id)) ownable.set(n.id, n);
    }
    const ownerName = new Map(nodes.filter((n) => n.type === 'team' || n.type === 'owner').map((n) => [n.id, n]));

    // -- CODEOWNERS: last matching rule wins; the first file in GitHub's precedence order is used --
    const coFile = CODEOWNERS_PATHS.map((p) => nodes.find((n) => n.type === 'file' && n.id === `file:${p}` && n.attrs.codeowners)).find(Boolean);
    if (coFile) {
      const rules = coFile.attrs.rules;
      for (const n of [...ownable.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const p = pathOf(n);
        let hit = null;
        for (let i = rules.length - 1; i >= 0 && !hit; i--) {
          const g = rules[i].glob;
          if (matchAny(p, g.endsWith('/**') ? [g] : [g, `${g}/**`])) hit = rules[i];
        }
        if (!hit || hit.owners.length === 0) continue;
        const prov = P(coFile.path, hit.line, 'high', 'config');
        out.push(nodeFact(n.type, keyOf(n.id), {
          name: n.name,
          path: n.path,
          attrs: { owners: uniqSorted(hit.owners), rule_line: hit.line, rule_pattern: hit.pattern, owners_source: coFile.path },
        }, prov));
        for (const o of uniqSorted(hit.owners)) {
          out.push(edgeFact('OWNED_BY', n.id, o, { rule_line: hit.line, rule_pattern: hit.pattern, source: coFile.path }, prov));
        }
      }
    }

    // -- OWNERS: nearest directory first, inheriting upward until `set noparent` ----------------
    const ownersFiles = new Map(nodes.filter((n) => n.type === 'file' && n.attrs.owners_file).map((n) => [n.attrs.dir, n]));
    const includeOwners = (f, seen = new Set()) => {
      const acc = [...f.attrs.owners];
      for (const inc of f.attrs.includes ?? []) {
        const target = nodes.find((n) => n.type === 'file' && n.id === `file:${inc}`);
        if (target && !seen.has(target.id) && seen.size < 5) acc.push(...includeOwners(target, new Set([...seen, f.id, target.id])));
      }
      return acc;
    };
    if (ownersFiles.size) {
      for (const n of [...ownable.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const p = pathOf(n);
        const isDir = n.type === 'service' || n.type === 'workload' || typeof n.attrs?.code_root === 'string';
        let dir = isDir ? p : dirname(p);
        const owners = [];
        let via = null;
        for (;;) {
          const f = ownersFiles.get(dir);
          if (f) {
            via ??= f.path;
            owners.push(...includeOwners(f));
            for (const pf of f.attrs.per_file ?? []) {
              const rel = dir === '.' ? p : p.slice(dir.length + 1);
              if (pf.globs.some((g) => matchAny(rel, [g, `**/${g}`]))) owners.push(...pf.owners);
            }
            if (f.attrs.noparent) break;
          }
          if (dir === '.') break;
          dir = dirname(dir);
        }
        const ids = uniqSorted(owners).filter((o) => ownerName.has(o));
        if (!ids.length) continue;
        const prov = P(via, 1, 'medium', 'config');
        out.push(nodeFact(n.type, keyOf(n.id), { name: n.name, path: n.path, attrs: { owners_file_owners: ids, owners_file: via } }, prov));
        for (const o of ids) out.push(edgeFact('OWNED_BY', n.id, o, { source: 'OWNERS', owners_file: via }, prov));
      }
    }

    // -- ADRs: supersession and path mentions ---------------------------------------------------
    const adrs = nodes.filter((n) => n.type === 'adr');
    if (adrs.length) {
      const byPath = new Map(adrs.map((a) => [a.path, a]));
      const byNumber = new Map();
      for (const a of adrs) {
        if (a.attrs.number === null) continue;
        byNumber.set(a.attrs.number, byNumber.has(a.attrs.number) ? null : a); // null marks ambiguous
      }
      const resolve = (ref) => (ref.startsWith('#') ? byNumber.get(Number(ref.slice(1))) : byPath.get(ref)) ?? null;
      const pairs = new Map(); // "newer|older" -> newer
      const supersededBy = new Map();
      for (const a of adrs) {
        for (const ref of a.attrs.supersedes ?? []) {
          const old = resolve(ref);
          if (old && old.id !== a.id) pairs.set(`${a.id}|${old.id}`, [a, old]);
        }
        for (const ref of a.attrs.superseded_by ?? []) {
          const nw = resolve(ref);
          if (nw && nw.id !== a.id) pairs.set(`${nw.id}|${a.id}`, [nw, a]);
        }
      }
      for (const [, [nw, old]] of [...pairs].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        out.push(edgeFact('SUPERSEDES', nw.id, old.id, {}, P(nw.path, 1, 'medium', 'inference')));
        if (!supersededBy.has(old.id)) supersededBy.set(old.id, []);
        supersededBy.get(old.id).push(nw.path);
      }
      for (const [id, by] of [...supersededBy].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        const old = adrs.find((a) => a.id === id);
        out.push(nodeFact('adr', keyOf(id), { name: old.name, path: old.path, attrs: { status: 'superseded', superseded_by: uniqSorted(by) } }, P(old.path, 1, 'medium', 'inference')));
      }

      const mentions = new Map();
      for (const a of adrs) for (const m of a.attrs.mentioned_paths ?? []) {
        if (!mentions.has(m)) mentions.set(m, []);
        mentions.get(m).push(a);
      }
      for (const n of [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (!DOCUMENTED.has(n.type)) continue;
        const keys = uniqSorted([n.path, n.attrs?.code_root].filter((k) => typeof k === 'string' && k !== '.'));
        const hits = new Map();
        for (const k of keys) for (const a of mentions.get(k) ?? []) hits.set(a.id, a);
        for (const [id, a] of [...hits].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
          out.push(edgeFact('DESCRIBED_BY', n.id, id, { via: 'path_mention' }, P(a.path, 1, 'medium', 'inference')));
        }
      }
    }
    return out;
  },
};
