// Contracts expressed as JSON/YAML documents: OpenAPI 2/3, AsyncAPI 2/3, Pact, Avro and
// JSON Schema. Parsed structurally, so confidence is high.

import { nodeFact, edgeFact } from '../../runtime/graph/facts.mjs';
import {
  P, isObj, asArray, uniqSorted, clean, capFacts, normalizePath, stripUserinfo, schemaNames, basename,
} from './util.mjs';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Security scheme names an operation (or the document default) requires. */
function securityNames(req) {
  return uniqSorted(asArray(req).filter(isObj).flatMap((r) => Object.keys(r)));
}

export function parseOpenApi(path, doc) {
  const isSwagger = typeof doc.swagger === 'string';
  const version = String(isSwagger ? doc.swagger : doc.openapi);
  const prov = P(path, 1);
  const defaultSecurity = securityNames(doc.security);
  const schemes = isSwagger ? Object.keys(doc.securityDefinitions ?? {}) : Object.keys(doc.components?.securitySchemes ?? {});
  const servers = isSwagger
    ? (doc.host ? asArray(doc.schemes?.length ? doc.schemes : ['https']).map((s) => stripUserinfo(`${s}://${doc.host}${doc.basePath ?? ''}`)) : [])
    : asArray(doc.servers).filter(isObj).map((s) => stripUserinfo(s.url)).filter(Boolean);
  const endpoints = [];
  for (const [rawPath, item] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    if (!isObj(item) || rawPath.startsWith('x-')) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const req = [];
      const res = [];
      if (isObj(op.requestBody)) for (const c of Object.values(op.requestBody.content ?? {})) req.push(...schemaNames(c?.schema));
      for (const prm of [...asArray(item.parameters), ...asArray(op.parameters)]) if (isObj(prm) && prm.in === 'body') req.push(...schemaNames(prm.schema));
      for (const r of Object.values(isObj(op.responses) ? op.responses : {})) {
        if (!isObj(r)) continue;
        res.push(...schemaNames(r.schema));
        for (const c of Object.values(r.content ?? {})) res.push(...schemaNames(c?.schema));
      }
      const m = method.toUpperCase();
      endpoints.push(nodeFact('endpoint', `${m} ${normalizePath(rawPath)}`, {
        name: `${m} ${normalizePath(rawPath)}`,
        attrs: clean({
          operation_id: op.operationId,
          summary: typeof op.summary === 'string' ? op.summary.slice(0, 200) : undefined,
          deprecated: op.deprecated === true,
          security: op.security !== undefined ? securityNames(op.security) : defaultSecurity,
          request_schemas: uniqSorted(req),
          response_schemas: uniqSorted(res),
          tags: asArray(op.tags).filter((t) => typeof t === 'string').sort(),
          from_contract: true,
          declared_in: path,
        }),
      }, prov));
    }
  }
  const artifact = nodeFact('artifact', path, {
    name: doc.info?.title ?? path,
    path,
    attrs: clean({
      kind: isSwagger ? 'swagger' : 'openapi',
      version,
      title: doc.info?.title,
      api_version: doc.info?.version === undefined ? undefined : String(doc.info.version),
      servers,
      endpoints: endpoints.length,
      security_schemes: schemes.sort(),
    }),
  }, prov);
  return capFacts([
    artifact,
    ...endpoints,
    ...endpoints.map((e) => edgeFact('DESCRIBED_BY', e.id, artifact.id, {}, prov)),
  ]);
}

function messageNames(m) {
  if (!isObj(m)) return [];
  if (Array.isArray(m.oneOf)) return m.oneOf.flatMap(messageNames);
  if (typeof m.$ref === 'string') return [m.$ref.split('/').pop()];
  return typeof m.name === 'string' ? [m.name] : typeof m.messageId === 'string' ? [m.messageId] : [];
}

export function parseAsyncApi(path, doc) {
  const prov = P(path, 1);
  const channels = isObj(doc.channels) ? doc.channels : {};
  const v3 = String(doc.asyncapi).startsWith('3');
  const ops = [];
  if (v3) {
    for (const [opName, op] of Object.entries(isObj(doc.operations) ? doc.operations : {})) {
      const ref = op?.channel?.$ref;
      if (typeof ref === 'string') ops.push({ channel: ref.split('/').pop(), action: op.action === 'send' ? 'publish' : 'subscribe', id: opName, messages: asArray(op.messages).flatMap(messageNames) });
    }
  } else {
    for (const [name, ch] of Object.entries(channels)) {
      for (const action of ['publish', 'subscribe']) {
        const op = ch?.[action];
        if (isObj(op)) ops.push({ channel: name, action, id: op.operationId, messages: messageNames(op.message) });
      }
    }
  }
  const topics = Object.entries(channels).filter(([, ch]) => isObj(ch)).map(([name, ch]) => {
    const key = typeof ch.address === 'string' ? ch.address : name;
    return nodeFact('topic', key, {
      name: key,
      attrs: clean({
        operations: ops.filter((o) => o.channel === name).map((o) => clean({ action: o.action, operation_id: o.id, messages: uniqSorted(o.messages) })),
        bindings: isObj(ch.bindings) ? Object.keys(ch.bindings).sort() : undefined,
        from_contract: true,
        declared_in: path,
      }),
    }, prov);
  });
  const artifact = nodeFact('artifact', path, {
    name: doc.info?.title ?? path,
    path,
    attrs: clean({
      kind: 'asyncapi',
      version: String(doc.asyncapi),
      title: doc.info?.title,
      api_version: doc.info?.version === undefined ? undefined : String(doc.info.version),
      servers: Object.values(isObj(doc.servers) ? doc.servers : {}).filter(isObj).map((s) => stripUserinfo(s.url ?? s.host ?? '')).filter(Boolean).sort(),
      channels: topics.length,
    }),
  }, prov);
  return capFacts([artifact, ...topics, ...topics.map((t) => edgeFact('DESCRIBED_BY', t.id, artifact.id, {}, prov))]);
}

/** Pact v2/v3 consumer-driven contract: consumer CONSUMES, provider EXPOSES each interaction. */
export function parsePact(path, doc) {
  const consumer = doc.consumer?.name;
  const provider = doc.provider?.name;
  if (typeof consumer !== 'string' || typeof provider !== 'string') return [];
  const prov = P(path, 1);
  // Medium: a pact names services as the team chose to, which may differ from the catalog.
  const svcProv = P(path, 1, 'medium');
  const byId = new Map();
  for (const it of asArray(doc.interactions).filter(isObj)) {
    const req = it.request;
    if (!isObj(req) || typeof req.path !== 'string') continue;
    const method = String(req.method ?? 'GET').toUpperCase();
    const key = `${method} ${normalizePath(req.path)}`;
    const e = byId.get(key) ?? { statuses: new Set(), descriptions: [] };
    if (it.response?.status !== undefined) e.statuses.add(it.response.status);
    if (typeof it.description === 'string') e.descriptions.push(it.description.slice(0, 120));
    byId.set(key, e);
  }
  const artifact = nodeFact('artifact', path, {
    name: `${consumer} -> ${provider}`,
    path,
    attrs: clean({
      kind: 'pact',
      consumer,
      provider,
      interactions: asArray(doc.interactions).length,
      messages: asArray(doc.messages).length || undefined,
      pact_specification: doc.metadata?.pactSpecification?.version ?? doc.metadata?.['pact-specification']?.version,
    }),
  }, prov);
  const facts = [
    artifact,
    nodeFact('service', consumer, { name: consumer, attrs: { pact: true } }, svcProv),
    nodeFact('service', provider, { name: provider, attrs: { pact: true } }, svcProv),
  ];
  for (const [key, e] of [...byId].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const id = `endpoint:${key}`;
    facts.push(
      nodeFact('endpoint', key, {
        name: key,
        attrs: { from_contract: true, contract_kind: 'pact', concrete: true, contract_tested: true, statuses: [...e.statuses].sort(), declared_in: path },
      }, prov),
      edgeFact('CONSUMES', `service:${consumer}`, id, { contract_tested: true, via: 'pact', pact_file: path }, svcProv),
      edgeFact('EXPOSES', `service:${provider}`, id, { contract_tested: true, via: 'pact', pact_file: path }, svcProv),
      edgeFact('DESCRIBED_BY', id, artifact.id, {}, prov),
    );
  }
  return capFacts(facts);
}

const AVRO_PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);

export function parseAvro(path, doc) {
  const prov = P(path, 1);
  const facts = [];
  const seen = new Set();
  const walk = (schema, ns) => {
    if (Array.isArray(schema)) { schema.forEach((s) => walk(s, ns)); return; }
    if (!isObj(schema)) return;
    if (['record', 'error', 'enum', 'fixed'].includes(schema.type) && typeof schema.name === 'string') {
      const spaceNs = schema.name.includes('.') ? schema.name.slice(0, schema.name.lastIndexOf('.')) : (schema.namespace ?? ns);
      const simple = schema.name.slice(schema.name.lastIndexOf('.') + 1);
      const full = schema.name.includes('.') ? schema.name : (spaceNs ? `${spaceNs}.${simple}` : simple);
      if (!seen.has(full)) {
        seen.add(full);
        facts.push(nodeFact('type', full, {
          name: full,
          path,
          attrs: clean({
            kind: 'avro',
            avro_type: schema.type,
            namespace: spaceNs,
            doc: typeof schema.doc === 'string' ? schema.doc.slice(0, 200) : undefined,
            fields: schema.type === 'record' || schema.type === 'error' ? asArray(schema.fields).filter(isObj).map((f) => f.name) : undefined,
            symbols: schema.type === 'enum' ? asArray(schema.symbols) : undefined,
            size: schema.type === 'fixed' ? schema.size : undefined,
          }),
        }, prov));
      }
      for (const f of asArray(schema.fields).filter(isObj)) {
        walk(f.type, spaceNs);
        for (const ref of namedRefs(f.type, spaceNs)) facts.push(edgeFact('REFERENCES', `type:${full}`, `type:${ref}`, { field: f.name }, P(path, 1, 'medium')));
      }
    } else if (schema.type && typeof schema.type !== 'string') walk(schema.type, ns);
    else if (schema.items) walk(schema.items, ns);
    else if (schema.values) walk(schema.values, ns);
  };
  /** Non-primitive type names used by a field's type expression. */
  function namedRefs(t, ns) {
    if (typeof t === 'string') return AVRO_PRIMITIVES.has(t) || ['array', 'map', 'record', 'enum', 'fixed'].includes(t) ? [] : [t.includes('.') || !ns ? t : `${ns}.${t}`];
    if (Array.isArray(t)) return t.flatMap((x) => namedRefs(x, ns));
    if (isObj(t)) return namedRefs(t.type, ns).concat(t.items ? namedRefs(t.items, ns) : [], t.values ? namedRefs(t.values, ns) : []);
    return [];
  }
  walk(doc, undefined);
  return capFacts(facts);
}

export function parseJsonSchema(path, doc) {
  const stem = basename(path).replace(/\.schema\.json$/, '').replace(/\.json$/, '');
  const key = typeof doc.$id === 'string' ? doc.$id : typeof doc.title === 'string' ? doc.title : stem;
  const refs = [];
  const scan = (v, depth) => {
    if (depth > 8) return;
    if (Array.isArray(v)) v.forEach((x) => scan(x, depth + 1));
    else if (isObj(v)) {
      if (typeof v.$ref === 'string' && !v.$ref.startsWith('#')) refs.push(v.$ref);
      for (const x of Object.values(v)) scan(x, depth + 1);
    }
  };
  scan(doc, 0);
  return [nodeFact('type', key, {
    name: key,
    path,
    attrs: clean({
      kind: 'jsonschema',
      draft: doc.$schema,
      title: doc.title,
      schema_type: doc.type,
      required: asArray(doc.required).sort(),
      properties: Object.keys(isObj(doc.properties) ? doc.properties : {}).slice(0, 200),
      definitions: Object.keys(isObj(doc.$defs) ? doc.$defs : isObj(doc.definitions) ? doc.definitions : {}).sort(),
      external_refs: uniqSorted(refs).slice(0, 100),
    }),
  }, P(path, 1))];
}
