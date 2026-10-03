// JSON service catalog -> service, team and slo nodes with OWNED_BY, DEPENDS_ON and
// DESCRIBED_BY edges. Backstage YAML is out of scope here and skipped by the caller.

import { edgeFact, nodeFact } from '../../runtime/graph/facts.mjs';
import { cleanCodeRoot, codeRootOf, safeName, sortFacts, stamper, toIso } from './util.mjs';

const MAX_SERVICES = 5000;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? safeName(v) : null);

export function deriveCatalogFacts(text, { file, options, now, ttlDays }) {
  const doc = JSON.parse(text);
  const list = Array.isArray(doc?.services) ? doc.services.slice(0, MAX_SERVICES) : [];
  // A catalog states when it was exported; that, not the read time, is its observation.
  const stamp = toIso(Date.parse(doc?.generated_at ?? '')) ?? now;
  const st = stamper({ file, sourceType: 'catalog', window: { start: stamp, end: stamp }, ttlDays });
  const nodes = new Map();
  const facts = [];
  const node = (type, key, name, attrs, conf, loc) => {
    const id = `${type}:${key}`;
    if (!nodes.has(id)) nodes.set(id, nodeFact(type, key, { name, attrs: st.attrs(attrs) }, st.prov(loc, conf)));
  };

  for (const s of list) {
    const name = str(s?.name);
    if (!name) continue;
    const slo = s.slo && typeof s.slo === 'object' ? {
      availability: num(s.slo.availability), latency_p95_ms: num(s.slo.latency_p95_ms),
    } : null;
    node('service', name, name, {
      owner: str(s.owner), system: str(s.system), lifecycle: str(s.lifecycle), tier: str(s.tier),
      slo: slo && (slo.availability !== null || slo.latency_p95_ms !== null) ? Object.fromEntries(Object.entries(slo).filter(([, v]) => v !== null)) : null,
      code_root: cleanCodeRoot(s.repo_path) ?? codeRootOf(options, name),
    }, 'high', `service/${name}`);
    const owner = str(s.owner);
    if (owner) {
      node('team', owner, owner, {}, 'high', `team/${owner}`);
      facts.push(edgeFact('OWNED_BY', `service:${name}`, `team:${owner}`, st.attrs(), st.prov(`owner/${name}`, 'high')));
    }
    for (const dep of Array.isArray(s.depends_on) ? s.depends_on : []) {
      const d = str(dep);
      if (d && d !== name) facts.push(edgeFact('DEPENDS_ON', `service:${name}`, `service:${d}`, st.attrs({ declared: true }), st.prov(`depends/${name}->${d}`, 'medium')));
    }
    if (slo && (slo.availability !== null || slo.latency_p95_ms !== null)) {
      node('slo', name, `${name} SLO`, Object.fromEntries(Object.entries(slo).filter(([, v]) => v !== null)), 'high', `slo/${name}`);
      facts.push(edgeFact('DESCRIBED_BY', `service:${name}`, `slo:${name}`, st.attrs(), st.prov(`slo/${name}`, 'high')));
    }
  }
  return sortFacts([...nodes.values(), ...facts]);
}
