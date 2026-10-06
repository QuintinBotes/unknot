// Bundled discovery adapters, in the order they run. Order matters only for `link`:
// language adapters first, so later adapters (database, contracts, ownership) can read
// the module facts they produced.

export const ADAPTERS = Object.freeze([
  { id: 'javascript', module: './language/javascript/index.mjs' },
  { id: 'python', module: './language/python/index.mjs' },
  { id: 'generic', module: './language/generic/index.mjs' },
  { id: 'literals', module: './literals/index.mjs' },
  { id: 'quality', module: './quality/index.mjs' },
  { id: 'database', module: './database/index.mjs' },
  { id: 'iac', module: './infrastructure/iac/index.mjs' },
  { id: 'k8s', module: './infrastructure/k8s/index.mjs' },
  { id: 'delivery', module: './delivery/index.mjs' },
  { id: 'wiring', module: './delivery/wiring.mjs' },
  { id: 'contracts', module: './contracts/index.mjs' },
  { id: 'ownership', module: './ownership/index.mjs' },
  { id: 'runtime', module: './runtime/index.mjs' },
  { id: 'security', module: './security/index.mjs' },
]);

export function adapterModuleURL(entry) {
  return new URL(entry.module, import.meta.url);
}

/**
 * Load enabled adapters. A missing module is reported, not fatal: an adapter that is not
 * installed produces an explicit `unavailable` entry in the map summary.
 */
export async function loadAdapters(config, only = null) {
  const loaded = [];
  const unavailable = [];
  for (const entry of ADAPTERS) {
    if (only && !only.includes(entry.id)) continue;
    if (config?.adapters?.[entry.id]?.enabled === false) continue;
    try {
      const mod = await import(adapterModuleURL(entry));
      const adapter = mod.default;
      if (!adapter || adapter.id !== entry.id) throw new Error(`module does not export adapter ${entry.id}`);
      loaded.push({ ...adapter, moduleURL: adapterModuleURL(entry).href });
    } catch (err) {
      unavailable.push({ id: entry.id, reason: err.code === 'ERR_MODULE_NOT_FOUND' ? 'not installed' : err.message });
    }
  }
  return { loaded, unavailable };
}
