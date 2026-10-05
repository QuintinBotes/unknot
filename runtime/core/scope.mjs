// One scope language for every command (map, diagnose, decompose, graph). An entry is:
//
//   src/billing             a path: everything under it
//   src/**/*Invoice*/**     a glob, anchored at the repository root (see glob.mjs)
//   ns:Shop.Billing         modules whose declared namespace or package is Shop.Billing or
//                           below it (Shop.Billing.Invoices, not Shop.BillingReports)
//   seed:InvoiceService~2   a seed module, named by path, glob or a type it declares, plus
//                           every module within N import hops of it in either direction
//                           (default 1, at most 3)
//
// Mapping only narrows by path entries: namespaces and neighbourhoods need a graph, so they
// apply to the commands that read one.

import { matchAny } from './glob.mjs';

const MAX_HOPS = 3;
const GLOB = /[*?[{]/;

/** Split raw entries into path globs, namespace prefixes and seeds. */
export function parseScope(entries = []) {
  const paths = [];
  const namespaces = [];
  const seeds = [];
  for (const raw of entries.map((e) => String(e).trim()).filter(Boolean)) {
    if (raw.startsWith('ns:')) {
      const ns = raw.slice(3).replace(/\.\*?$/, '');
      if (ns) namespaces.push(ns);
    } else if (raw.startsWith('seed:')) {
      const m = /^seed:(.+?)(?:~(\d+))?$/.exec(raw);
      if (m) seeds.push({ target: m[1], hops: Math.min(MAX_HOPS, m[2] === undefined ? 1 : Number(m[2])) });
    } else {
      const p = raw.replace(/^\.\//, '');
      paths.push(GLOB.test(p) ? p : `${p.replace(/\/$/, '')}/**`, ...(GLOB.test(p) ? [] : [p.replace(/\/$/, '')]));
    }
  }
  return { paths, namespaces, seeds, empty: !paths.length && !namespaces.length && !seeds.length, raw: entries };
}

/** Globs for the census. Null when no entry narrows by path (map everything). */
export function pathGlobs(entries = []) {
  const { paths } = parseScope(entries);
  return paths.length ? paths : null;
}

const nodePath = (n) => n.path ?? (n.id.startsWith('module:') ? n.id.slice(7) : null);

function namespacesOf(n) {
  const a = n.attrs ?? {};
  return [a.namespace, ...(Array.isArray(a.namespaces) ? a.namespaces : []), a.package].filter((s) => typeof s === 'string' && s);
}

const underNamespace = (ns, prefix) => ns === prefix || ns.startsWith(`${prefix}.`);

function seedModules(graph, modules, target) {
  if (GLOB.test(target)) return modules.filter((n) => nodePath(n) && matchAny(nodePath(n), [target]));
  const exact = modules.filter((n) => nodePath(n) === target.replace(/^\.\//, ''));
  if (exact.length) return exact;
  const byType = modules.filter((n) => Array.isArray(n.attrs?.types) && n.attrs.types.includes(target));
  if (byType.length) return byType;
  // A bare file name: InvoiceService.cs, or the stem without its extension.
  return modules.filter((n) => {
    const base = (nodePath(n) ?? '').split('/').pop();
    return base === target || base.replace(/\.[^.]+$/, '') === target;
  });
}

/**
 * Resolve a scope against the graph's modules.
 * @returns {{all: boolean, ids: Set<string>, matched: number, total: number, unresolved: string[], describe: string}}
 *   `all` is true when the scope is empty (everything is in scope).
 */
export function resolveScope(graph, entries = [], { nodeType = 'module', edgeTypes = ['IMPORTS'] } = {}) {
  const parsed = parseScope(entries);
  const modules = graph.nodes(nodeType);
  if (parsed.empty) return { all: true, ids: new Set(modules.map((n) => n.id)), matched: modules.length, total: modules.length, unresolved: [], describe: 'everything' };
  const ids = new Set();
  for (const n of modules) {
    const p = nodePath(n);
    if (parsed.paths.length && p && matchAny(p, parsed.paths)) ids.add(n.id);
    else if (parsed.namespaces.length && namespacesOf(n).some((ns) => parsed.namespaces.some((pre) => underNamespace(ns, pre)))) ids.add(n.id);
  }
  const unresolved = [];
  for (const seed of parsed.seeds) {
    const start = seedModules(graph, modules, seed.target);
    if (!start.length) {
      unresolved.push(seed.target);
      continue;
    }
    let frontier = start.map((n) => n.id);
    for (const id of frontier) ids.add(id);
    for (let hop = 0; hop < seed.hops && frontier.length; hop++) {
      const next = [];
      for (const id of frontier) {
        for (const e of graph.out(id, edgeTypes)) if (!ids.has(e.to) && graph.node(e.to)?.type === nodeType) next.push(e.to);
        for (const e of graph.in(id, edgeTypes)) if (!ids.has(e.from) && graph.node(e.from)?.type === nodeType) next.push(e.from);
      }
      frontier = [...new Set(next)];
      for (const id of frontier) ids.add(id);
    }
  }
  return { all: false, ids, matched: ids.size, total: modules.length, unresolved, describe: entries.join(' ') };
}

/**
 * A predicate over graph nodes: modules by the resolved set, any other node with a path by
 * the path entries (namespace and seed entries select modules only).
 */
export function scopePredicate(graph, entries = [], opts) {
  const res = resolveScope(graph, entries, opts);
  if (res.all) return Object.assign(() => true, { scope: res });
  const { paths } = parseScope(entries);
  const fn = (n) => {
    if (!n) return false;
    if (res.ids.has(n.id)) return true;
    const p = nodePath(n);
    return Boolean(paths.length && p && matchAny(p, paths));
  };
  return Object.assign(fn, { scope: res });
}

/** True when a repository path is in scope (for artifacts that carry paths, such as findings). */
export const pathInScope = (path, predicate) => predicate({ id: `module:${path}`, path });

/** The warning to show when a scope selects nothing, or null. */
export function emptyScopeWarning(res, noun = 'modules') {
  if (res.all || res.matched > 0) return res.unresolved?.length ? `seed not found: ${res.unresolved.join(', ')}` : null;
  const seeds = res.unresolved?.length ? `; seed not found: ${res.unresolved.join(', ')}` : '';
  return `scope "${res.describe}" matched 0 of ${res.total} ${noun}${seeds}`;
}
