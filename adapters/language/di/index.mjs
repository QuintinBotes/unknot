// Dependency-injection adapter: container registrations as graph facts. `extract` reads
// one file's registrations (adapters/language/di-ops.mjs, one table-driven rule) into a
// link-only module attribute; `link` resolves the service and implementation names to the
// class/interface nodes the language adapters emitted and states what the container
// decides: the service type RESOLVES_TO its implementation, and the registering module
// DEPENDS_ON the module holding that implementation (runtime wiring, so a registered
// implementation nothing imports is not dead code). Resolution is by simple name: a type
// declared in the registering file wins, otherwise the name must match exactly one type
// in the repository. No match, or several, means unresolved and no edge for that side.

import { assertFact, edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { codeLanguageIds, globsFor, languageForPath } from '../../../runtime/graph/languages.mjs';
import { MAX_TEXT } from '../contract-scan.mjs';
import { diCandidates, simpleTypeName } from '../di-ops.mjs';

const ID = 'di';
const VERSION = '0.1.0';
const EXTRACTOR = `${ID}@${VERSION}`;
const MAX_FACTS = 5000;

const P = (path, line, confidence) => prov({ source_type: 'inference', source_ref: `${path}:${line || 1}`, extractor: EXTRACTOR, confidence });

function capFacts(facts) {
  if (facts.length <= MAX_FACTS) return facts;
  const out = facts.slice(0, MAX_FACTS);
  const i = out.findIndex((f) => f.kind === 'node');
  if (i !== -1) out[i] = { ...out[i], attrs: { ...out[i].attrs, truncated: true } };
  return out;
}

/** Class/interface nodes by simple name, repository-wide and per declaring file. */
function typeIndex(factsByFile) {
  const byName = new Map();
  const byFile = new Map();
  const add = (map, key, entry) => {
    const list = map.get(key) ?? [];
    if (!list.some((e) => e.id === entry.id)) list.push(entry);
    map.set(key, list);
  };
  for (const path of [...factsByFile.keys()].sort()) {
    for (const f of factsByFile.get(path)) {
      if (f.kind !== 'node' || (f.type !== 'class' && f.type !== 'interface')) continue;
      const simple = simpleTypeName(String(f.name ?? '').split('#').pop());
      if (!simple || !/^[A-Za-z_$][\w$]*$/.test(simple)) continue;
      const entry = { id: f.id, path: f.path ?? path };
      add(byName, simple, entry);
      if (!byFile.has(entry.path)) byFile.set(entry.path, new Map());
      add(byFile.get(entry.path), simple, entry);
    }
  }
  return { byName, byFile };
}

export default {
  id: ID,
  version: VERSION,
  kind: 'framework',
  capabilities: {
    get files() { return globsFor(codeLanguageIds()); },
    executes: [],
    network: false,
  },

  extract(file, text) {
    const { path } = file;
    const lang = languageForPath(path)?.id;
    if (!lang || !codeLanguageIds().includes(lang)) return [];
    const candidates = diCandidates(path, text, lang);
    if (!candidates.length) return [];
    return capFacts([nodeFact('module', path, {
      path,
      attrs: { di_candidates: candidates, ...(text.length > MAX_TEXT ? { truncated: true } : {}) },
    }, P(path, 1, 'medium'))]);
  },

  link(ctx) {
    const { byName, byFile } = typeIndex(ctx.factsByFile);
    const resolve = (raw, registeringPath) => {
      const simple = simpleTypeName(raw);
      if (!simple || !/^[A-Za-z_$][\w$]*$/.test(simple)) return null;
      const local = byFile.get(registeringPath)?.get(simple);
      if (local?.length) return local.length === 1 ? local[0] : null;
      const all = byName.get(simple);
      return all?.length === 1 ? all[0] : null;
    };
    const out = [];
    const seen = new Set();
    let registrations = 0;
    let unresolved = 0;
    const emit = (fact) => {
      const key = `${fact.type}|${fact.from}|${fact.to}|${JSON.stringify(fact.attrs)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(assertFact(fact));
    };
    for (const path of [...ctx.factsByFile.keys()].sort()) {
      const facts = ctx.factsByFile.get(path);
      const module = facts.find((f) => f.kind === 'node' && f.type === 'module'
        && f.provenance.extractor === EXTRACTOR && f.attrs?.di_candidates);
      if (!module) continue;
      const candidates = [...module.attrs.di_candidates].sort((a, b) => (a.index - b.index)
        || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0)
        || (a.implementation < b.implementation ? -1 : a.implementation > b.implementation ? 1 : 0));
      for (const c of candidates) {
        registrations++;
        const svc = resolve(c.service, path);
        const impl = resolve(c.implementation, path);
        if (!svc || !impl) unresolved++;
        const pv = P(path, c.line, c.scanned ? 'low' : 'medium');
        if (svc && impl && svc.id !== impl.id) {
          emit(edgeFact('RESOLVES_TO', svc.id, impl.id, {
            via: 'container', container: c.container, lifetime: c.lifetime, registered_in: path, line: c.line,
          }, pv));
        }
        if (impl && impl.path && impl.path !== path) {
          emit(edgeFact('DEPENDS_ON', `module:${path}`, `module:${impl.path}`, {
            via: 'container', container: c.container, service: c.service, implementation: c.implementation, lifetime: c.lifetime,
          }, pv));
        }
      }
      delete module.attrs.di_candidates;
    }
    if (ctx.stats && registrations) ctx.stats.di = { registrations, unresolved };
    if (ctx.notes && unresolved) {
      ctx.notes.push(`di: ${unresolved} of ${registrations} container registration(s) name a service or implementation type that could not be resolved to exactly one declared type; those sides have no edge`);
    }
    return capFacts(out);
  },
};
