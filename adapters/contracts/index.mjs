// Contracts adapter: API, event and schema definitions (spec §9.4 step 6, §10.1). It declares
// what the system promises; `link` compares that promise with the endpoints language adapters
// found in code and marks the gaps either way:
//   undocumented   an endpoint in code that no contract of the same family lists
//   unimplemented  a contract endpoint with no implementation in code
// Both are heuristic (path styles differ between frameworks), hence confidence 'medium'.

import { parseYAML } from '../../runtime/core/yaml.mjs';
import { nodeFact } from '../../runtime/graph/facts.mjs';
import {
  ID, VERSION, EXTRACTOR, P, isObj, basename, uniqSorted,
} from './util.mjs';
import {
  parseOpenApi, parseAsyncApi, parsePact, parseAvro, parseJsonSchema,
} from './structured.mjs';
import { parseGraphql, parseProto } from './idl.mjs';

/** Endpoints only compare within a family: HTTP verbs, GRAPHQL, RPC. */
function family(id) {
  const m = /^endpoint:([A-Z]+) /.exec(id);
  if (!m) return null;
  return m[1] === 'GRAPHQL' || m[1] === 'RPC' ? m[1] : 'HTTP';
}

const allNodes = (factsByFile) => {
  const out = [];
  for (const path of [...factsByFile.keys()].sort()) for (const f of factsByFile.get(path)) if (f.kind === 'node') out.push(f);
  return out;
};

export default {
  id: ID,
  version: VERSION,
  kind: 'contracts',
  capabilities: {
    files: [
      '**/openapi*.{yaml,yml,json}', '**/swagger*.{yaml,yml,json}', '**/*.openapi.{yaml,yml,json}', '**/asyncapi*.{yaml,yml,json}',
      '**/*.graphql', '**/*.gql', '**/schema.graphqls', '**/*.proto', '**/*.avsc', '**/*.schema.json', '**/pact*/**/*.json', '**/pacts/*.json',
    ],
    executes: [],
    network: false,
  },

  extract(file, text) {
    const { path } = file;
    if (/\.(graphql|gql|graphqls)$/.test(path)) return parseGraphql(path, text);
    if (path.endsWith('.proto')) return parseProto(path, text);
    if (path.endsWith('.avsc')) return parseAvro(path, JSON.parse(text));
    const doc = path.endsWith('.json') ? JSON.parse(text) : parseYAML(text, { filename: path });
    if (!isObj(doc)) return [];
    // Content decides: a file named openapi-config.json is not a contract.
    if (typeof doc.openapi === 'string' || typeof doc.swagger === 'string') return parseOpenApi(path, doc);
    if (typeof doc.asyncapi === 'string') return parseAsyncApi(path, doc);
    if (isObj(doc.consumer) && isObj(doc.provider)) return parsePact(path, doc);
    if (basename(path).endsWith('.schema.json')) return parseJsonSchema(path, doc);
    return [];
  },

  link(ctx) {
    const nodes = allNodes(ctx.factsByFile).filter((n) => n.type === 'endpoint');
    const isContract = (n) => n.provenance.extractor === EXTRACTOR && n.attrs.from_contract;
    // Neither this adapter nor ownership (Backstage `endpoint:api:`) describes code.
    const isCode = (n) => !n.provenance.extractor.startsWith('contracts@') && !n.provenance.extractor.startsWith('ownership@');

    const contract = new Map(); // id -> artifacts declaring it (non-concrete only)
    const pact = new Set();
    const contractNodes = new Map();
    for (const n of nodes.filter(isContract)) {
      if (n.attrs.concrete) { pact.add(n.id); continue; }
      if (!contract.has(n.id)) contract.set(n.id, new Set());
      contract.get(n.id).add(n.attrs.declared_in);
      contractNodes.set(n.id, n);
    }
    const code = new Map(nodes.filter(isCode).map((n) => [n.id, n]));
    const contractFamilies = new Set([...contract.keys()].map(family));
    const codeFamilies = new Set([...code.keys()].map(family));
    const out = [];
    const key = (id) => id.slice('endpoint:'.length);

    for (const [id, n] of [...code].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const fam = family(id);
      if (!fam) continue;
      const arts = contract.get(id);
      if (arts) {
        const list = uniqSorted([...arts]);
        out.push(nodeFact('endpoint', key(id), {
          name: n.name,
          path: n.path,
          attrs: { contract: list[0], ...(list.length > 1 ? { contracts: list } : {}), ...(pact.has(id) ? { contract_tested: true } : {}) },
        }, P(list[0], 1, 'medium', 'inference')));
      } else if (contractFamilies.has(fam)) {
        out.push(nodeFact('endpoint', key(id), {
          name: n.name,
          path: n.path,
          attrs: { undocumented: true, ...(pact.has(id) ? { contract_tested: true } : {}) },
        }, P(n.path ?? '', 1, 'medium', 'inference')));
      } else if (pact.has(id)) {
        out.push(nodeFact('endpoint', key(id), { name: n.name, path: n.path, attrs: { contract_tested: true } }, P(n.path ?? '', 1, 'medium', 'inference')));
      }
    }
    for (const [id, arts] of [...contract].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (code.has(id) || !codeFamilies.has(family(id))) continue;
      const list = uniqSorted([...arts]);
      out.push(nodeFact('endpoint', key(id), {
        name: contractNodes.get(id).name,
        attrs: { unimplemented: true },
      }, P(list[0], 1, 'medium', 'inference')));
    }
    return out;
  },
};
