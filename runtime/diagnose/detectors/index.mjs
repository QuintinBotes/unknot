// Detector registry. Each module default-exports one detector or an array of them
// (runtime/diagnose/README.md). Missing modules are reported by the engine, not fatal.

export const DETECTORS = Object.freeze([
  { id: 'local', module: './local.mjs' },
  { id: 'module', module: './module.mjs' },
  { id: 'service', module: './service.mjs' },
  { id: 'delivery', module: './delivery.mjs' },
  { id: 'security', module: './security.mjs' },
  { id: 'database', module: './database.mjs' },
  { id: 'infrastructure', module: './infrastructure.mjs' },
  { id: 'decomposition', module: './decomposition.mjs' },
  { id: 'frontend', module: './frontend.mjs' },
]);
