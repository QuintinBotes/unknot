// Scopes accumulate: the project records which scopes it has mapped, and a scoped map maps
// their union with the given ones, so edges between scopes stay (unchanged files come from the
// per-file cache). `replace` maps exactly the given scopes; no scope maps the whole repository.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const GLOB = /[*?[{]/;
const norm = (e) => String(e).trim().replace(/^\.\//, '').replace(/\/+$/, '');
const isPath = (e) => e && !e.startsWith('ns:') && !e.startsWith('seed:');

/** The recorded coverage: `{whole, scopes}`, or null for a store that never recorded one. */
export function readMappedScopes(store) {
  try {
    const v = JSON.parse(store.meta('mapped_scopes') ?? 'null');
    return v && typeof v.whole === 'boolean' && Array.isArray(v.scopes) ? v : null;
  } catch {
    return null;
  }
}

/**
 * @param {{root: string, store: object}} ctx
 * @param {{scope?: string[], replace?: boolean}} opts
 * @returns {{effective: string[], record: {whole: boolean, scopes: string[]}, kept: string[], dropped: string[], missing: string[], notes: string[]}}
 */
export function resolveScopes(ctx, { scope = [], replace = false }) {
  const given = [...new Set(scope.map(norm).filter(isPath))];
  const prev = readMappedScopes(ctx.store);
  const none = { kept: [], dropped: [], missing: [], notes: [] };
  if (!given.length) {
    const subsumed = prev && !prev.whole ? prev.scopes : [];
    return { effective: scope, record: { whole: true, scopes: [] }, ...none, notes: subsumed.length ? [`the whole repository now covers the earlier scopes: ${subsumed.join(', ')}`] : [] };
  }
  const label = given.join(', ');
  if (replace) {
    const dropped = prev ? (prev.whole ? ['the whole repository'] : prev.scopes.filter((s) => !given.includes(s))) : [];
    return { effective: scope, record: { whole: false, scopes: given }, ...none, dropped, notes: dropped.length ? [`--replace: the graph now covers only ${label}; dropped from earlier maps: ${dropped.join(', ')}`] : [] };
  }
  if (prev?.whole) {
    return { effective: [], record: { whole: true, scopes: [] }, ...none, kept: ['the whole repository'], notes: [`kept from earlier maps: the whole repository, so the graph still covers all of it; use --replace to map only ${label}`] };
  }
  const missing = [];
  const kept = [];
  for (const s of prev?.scopes ?? []) {
    if (given.includes(s)) continue;
    if (!GLOB.test(s) && !existsSync(join(ctx.root, s))) missing.push(s);
    else kept.push(s);
  }
  const notes = [];
  if (missing.length) notes.push(`scope no longer on disk, dropped: ${missing.join(', ')}`);
  if (kept.length) notes.push(`kept from earlier maps: ${kept.join(', ')}; use --replace to map only ${label}`);
  return { effective: [...kept, ...scope], record: { whole: false, scopes: [...kept, ...given] }, kept, dropped: [], missing, notes };
}
