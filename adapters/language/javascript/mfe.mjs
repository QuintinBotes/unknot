// Micro-frontend integration recognised from configuration code (spec §15A.10): Module
// Federation (webpack/rspack plugins, @module-federation packages), single-spa
// registrations and Next.js multi-zone rewrites. Text patterns only, so medium confidence.

const NAME = /\bname\s*:\s*['"]([\w@/.-]+)['"]/;

function objectKeys(text, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*\\{([^}]*)\\}`).exec(text);
  if (!m) return [];
  // Top-level keys only: drop nested objects and quoted values (which contain colons).
  const body = m[1].replace(/\{[^}]*/g, '').replace(/:\s*(['"`])(?:(?!\1).)*\1/g, ': ""');
  return [...body.matchAll(/(?:^|[,{])\s*['"]?([\w@./-]+)['"]?\s*:/g)].map((x) => x[1]).slice(0, 50);
}

/** @returns {null | {kind: string, name?: string, remotes?: string[], exposes?: string[], apps?: string[], zones?: string[]}} */
export function detectMicroFrontends(text) {
  if (/ModuleFederationPlugin\s*\(|@module-federation\/|withModuleFederation|federation\s*\(\s*\{/.test(text)) {
    return { kind: 'module-federation', name: NAME.exec(text)?.[1] ?? null, remotes: objectKeys(text, 'remotes'), exposes: objectKeys(text, 'exposes'), shared: objectKeys(text, 'shared') };
  }
  if (/\bregisterApplication\s*\(/.test(text)) {
    const apps = [...text.matchAll(/registerApplication\s*\(\s*(?:\{\s*name\s*:\s*)?['"]([\w@/.-]+)['"]/g)].map((m) => m[1]);
    return { kind: 'single-spa', apps: [...new Set(apps)].slice(0, 50) };
  }
  if (/\brewrites\s*\(/.test(text) && /destination\s*:\s*[`'"]https?:\/\//.test(text)) {
    const zones = [...text.matchAll(/destination\s*:\s*[`'"](https?:\/\/[^`'"/]+)/g)].map((m) => m[1].replace(/^https?:\/\//, ''));
    return { kind: 'multi-zone', zones: [...new Set(zones)].slice(0, 20) };
  }
  return null;
}
