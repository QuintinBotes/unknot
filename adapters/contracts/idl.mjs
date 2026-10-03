// Interface-definition languages read textually: GraphQL SDL and Protocol Buffers.
// Neither grammar is evaluated; a small scanner over comment-stripped text is enough to list
// operations and RPCs, and anything it cannot see is simply absent. Hence confidence 'medium'.

import { nodeFact, edgeFact } from '../../runtime/graph/facts.mjs';
import {
  P, uniqSorted, clean, capFacts, matchBrace, blank, lineAt,
} from './util.mjs';

const OPERATIONS = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };

export function parseGraphql(path, text) {
  const src = text.replace(/"""[\s\S]*?"""/g, blank).replace(/#[^\n]*/g, '');
  const roots = { Query: 'query', Mutation: 'mutation', Subscription: 'subscription' };
  const schemaBlock = /\bschema\s*(?:@[^{]*)?\{([^}]*)\}/.exec(src);
  if (schemaBlock) {
    for (const m of schemaBlock[1].matchAll(/\b(query|mutation|subscription)\s*:\s*(\w+)/g)) roots[m[2]] = m[1];
  }
  const endpoints = [];
  const types = [];
  const counts = { query: 0, mutation: 0, subscription: 0 };
  const defRe = /\b(?:extend\s+)?(type|interface|input|enum|union|scalar)\s+(\w+)([^{=\n]*)(\{|=[^\n]*)?/g;
  let m;
  while ((m = defRe.exec(src))) {
    const [, kind, name, header, tail] = m;
    const line = lineAt(src, m.index);
    let fields = [];
    if (tail === '{') {
      const open = m.index + m[0].length - 1;
      const end = matchBrace(src, open);
      const body = src.slice(open + 1, end).replace(/\([^)]*\)/g, (s) => s.replace(/\s+/g, ' '));
      defRe.lastIndex = end + 1;
      for (const raw of body.split('\n')) {
        const f = /^\s*(\w+)\s*(?:\(([^)]*)\))?\s*:\s*([\[\]\w!]+)(.*)$/.exec(raw);
        if (f && kind !== 'enum' && kind !== 'input') fields.push({ name: f[1], args: [...(f[2] ?? '').matchAll(/(\w+)\s*:/g)].map((a) => a[1]), type: f[3], deprecated: /@deprecated/.test(f[4]) });
        else if (kind === 'enum' || kind === 'input') {
          const v = /^\s*(\w+)/.exec(raw);
          if (v) fields.push({ name: v[1], args: [], type: '', deprecated: false });
        }
      }
    }
    const op = kind === 'type' ? roots[name] : undefined;
    if (op) {
      for (const f of fields) {
        counts[op]++;
        const label = `${OPERATIONS[op]}.${f.name}`;
        endpoints.push(nodeFact('endpoint', `GRAPHQL ${label}`, {
          name: `GRAPHQL ${label}`,
          attrs: { operation: op, field: f.name, return_type: f.type, args: f.args, deprecated: f.deprecated, from_contract: true, declared_in: path },
        }, P(path, line, 'medium')));
      }
    } else if (!tail || tail === '{' || tail.startsWith('=')) {
      const impl = /\bimplements\s+([\w\s&,]+)/.exec(header);
      types.push(nodeFact('type', `${path}#${name}`, {
        name,
        path,
        attrs: clean({
          kind: 'graphql',
          graphql_kind: kind,
          fields: fields.map((f) => f.name).slice(0, 200),
          implements: impl ? impl[1].split(/[\s&,]+/).filter(Boolean) : undefined,
        }),
      }, P(path, line, 'medium')));
    }
  }
  const prov = P(path, 1, 'medium');
  const artifact = nodeFact('artifact', path, {
    name: path,
    path,
    attrs: { kind: 'graphql', types: types.length, queries: counts.query, mutations: counts.mutation, subscriptions: counts.subscription, endpoints: endpoints.length },
  }, prov);
  const dedup = new Map();
  for (const e of endpoints) dedup.set(e.id, e);
  return capFacts([artifact, ...types, ...dedup.values(), ...[...dedup.values()].map((e) => edgeFact('DESCRIBED_BY', e.id, artifact.id, {}, prov))]);
}

export function parseProto(path, text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, '');
  const syntax = /\bsyntax\s*=\s*"(proto[23])"/.exec(src)?.[1];
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(src)?.[1];
  const prov = P(path, 1, 'medium');
  const endpoints = [];
  const services = [];
  const re = /\bservice\s+(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const end = matchBrace(src, open);
    const body = src.slice(open + 1, end);
    services.push(m[1]);
    re.lastIndex = end + 1;
    const base = lineAt(src, open);
    for (const r of body.matchAll(/\brpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/g)) {
      const id = `RPC ${pkg ? `${pkg}.` : ''}${m[1]}/${r[1]}`;
      endpoints.push(nodeFact('endpoint', id, {
        name: id,
        attrs: clean({
          service: m[1],
          method: r[1],
          package: pkg,
          request: r[3],
          response: r[5],
          client_streaming: Boolean(r[2]),
          server_streaming: Boolean(r[4]),
          from_contract: true,
          declared_in: path,
        }),
      }, P(path, base + lineAt(body, r.index) - 1, 'medium')));
    }
  }
  const artifact = nodeFact('artifact', path, {
    name: path,
    path,
    attrs: clean({
      kind: 'protobuf',
      syntax,
      package: pkg,
      services: uniqSorted(services),
      messages: [...src.matchAll(/\bmessage\s+\w+\s*\{/g)].length,
      enums: [...src.matchAll(/\benum\s+\w+\s*\{/g)].length,
      // Reserved field numbers/names are how a schema records removed fields; their absence
      // in an evolving message is a compatibility smell later stages can look for.
      has_reserved: /\breserved\b/.test(src),
      endpoints: endpoints.length,
    }),
  }, prov);
  return capFacts([artifact, ...endpoints, ...endpoints.map((e) => edgeFact('DESCRIBED_BY', e.id, artifact.id, {}, prov))]);
}
