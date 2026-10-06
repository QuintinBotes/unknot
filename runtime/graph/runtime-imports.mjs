// Imported runtime tables (`unknot import runtime`) live in the store's meta table, one
// entry per source label, and are turned into graph facts on every map so a re-map keeps
// them. An import replaces the earlier one with the same source.

const KEY = 'runtime_imports';

/** @returns {{source: string, file: string, digest: string, imported_at: string, rows: object[]}[]} */
export function loadImports(store) {
  const raw = store.meta(KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Store `entry`, replacing the one with the same source. */
export function saveImport(store, entry) {
  const rest = loadImports(store).filter((e) => e.source !== entry.source);
  store.meta(KEY, JSON.stringify([...rest, entry].sort((a, b) => (a.source < b.source ? -1 : 1))));
}
