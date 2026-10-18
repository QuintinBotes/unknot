// Generated service constructors and named query documents are client evidence. The
// contract adapter supplies the service/schema declarations during the link pass.
import { LANGUAGE_IDS } from '../../runtime/graph/languages.mjs';
import { clientMatches } from '../../runtime/graph/routes.mjs';
import { edgeFact, nodeFact } from '../../runtime/graph/facts.mjs';
import { callsIn, closing, MAX_OPERATIONS, view } from './contract-scan.mjs';

export const RPC_CLIENT_SYNTAX = [
  { name: /^(.+)Client$/, before: /\bnew\s+(?:[\w.]+\.)?$/, service: 1 },
  { name: /^(.+)Stub$/, service: 1 },
  { name: /^New(.+)Client$/, service: 1 },
];

export function rpcCandidates(text, lang) {
  // Most files construct no client and hold no query document: a text test spares them the lexer.
  if (!/(?:Client|Stub)\s*\(|\bgql\s*`/.test(text)) return [];
  const lx = view(text, lang);
  const calls = callsIn(lx);
  const out = [];
  for (const c of calls) {
    for (const row of RPC_CLIENT_SYNTAX) {
      const m = row.name.exec(c.name);
      if (!m || (row.before && !row.before.test(c.before)) || !c.args.positional.length) continue;
      const binding = /([A-Za-z_]\w*)\s*(?:=|:=)\s*(?:new\s+)?(?:[\w.]+\.)?$/.exec(c.before)?.[1];
      const methods = binding ? [...new Set(calls.filter((x) => x.receiver.split('.').pop() === binding).map((x) => x.name))].sort() : [];
      out.push({ kind: 'rpc_client', service: m[row.service], methods, line: c.line, index: c.index });
      break;
    }
    if (out.length >= MAX_OPERATIONS) break;
  }
  for (const m of lx.code.matchAll(/\bgql\s*`/g)) {
    const start = m.index + m[0].lastIndexOf('`');
    const literal = lx.literals.find((l) => l.start === start);
    if (!literal || literal.value.includes('${')) continue;
    out.push(...graphqlCandidates(literal.value).map((o) => ({ ...o, line: lx.lineOf(start) + o.line - 1, index: start + o.index })));
    if (out.length >= MAX_OPERATIONS) break;
  }
  return out.slice(0, MAX_OPERATIONS);
}

const ROOTS = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };
export function graphqlCandidates(text) {
  const lx = view(text.replace(/#[^\n]*/g, (s) => ' '.repeat(s.length)), LANGUAGE_IDS.JAVASCRIPT);
  const out = [];
  for (const m of lx.code.matchAll(/\b(query|mutation|subscription)\s+([A-Za-z_]\w*)/g)) {
    let open = m.index + m[0].length;
    while (open < lx.code.length && lx.code[open] !== '{') {
      if (lx.code[open] === '(') { const end = closing(lx.code, open); if (end < 0) break; open = end; }
      open++;
    }
    const end = closing(lx.code, open, '{', '}');
    if (end < 0) continue;
    const fields = [];
    let i = open + 1;
    while (i < end) {
      if (lx.code[i] === '{' || lx.code[i] === '(') {
        const close = closing(lx.code, i, lx.code[i], lx.code[i] === '{' ? '}' : ')');
        if (close < 0) break;
        i = close + 1;
        continue;
      }
      if (lx.code[i] === '@' || lx.code.startsWith('...', i)) {
        const skip = /^(?:@\w+|\.\.\.\s*\w+)/.exec(lx.code.slice(i));
        i += skip?.[0].length ?? 1;
        continue;
      }
      const f = /^[A-Za-z_]\w*/.exec(lx.code.slice(i));
      if (f) {
        let field = f[0];
        i += field.length;
        const alias = /^\s*:\s*([A-Za-z_]\w*)/.exec(lx.code.slice(i));
        if (alias) { field = alias[1]; i += alias[0].length; }
        fields.push(field);
      } else i++;
    }
    out.push({ kind: 'graphql_client', operation: m[1], operation_name: m[2], root: ROOTS[m[1]], fields: [...new Set(fields)].sort(), line: lx.lineOf(m.index), index: m.index });
    if (out.length >= MAX_OPERATIONS) break;
  }
  return out;
}

export function queryClientFacts(path, candidate, endpoints, pv, maxFacts = 5000) {
  const key = `${path}#${candidate.operation_name ?? candidate.service}@${candidate.index}`;
  const client = `contract:${key}`;
  const facts = [nodeFact('contract', key, { name: candidate.operation_name ?? candidate.service, path,
    attrs: { ...candidate, matched: false } }, pv(candidate.line)), edgeFact('CONTAINS', `module:${path}`, client, {}, pv(candidate.line))];
  const matches = endpoints.filter((e) => clientMatches(candidate, e));
  // A bare generated service name cannot choose between packages with the same service.
  if (candidate.kind === 'rpc_client' && new Set(endpoints.filter((e) => clientMatches({ ...candidate, methods: [] }, e)).map((e) => e.attrs.package ?? '')).size > 1) return facts;
  facts[0].attrs.matched = matches.length > 0;
  for (const e of matches) {
    if (facts.length + 4 > maxFacts) { facts[0].attrs.truncated = true; break; }
    const op = e.id.slice('endpoint:'.length);
    const attrs = { kind: 'client_operation', protocol: candidate.kind === 'rpc_client' ? 'rpc' : LANGUAGE_IDS.GRAPHQL, contract_key: op,
      ...(candidate.operation_name ? { operation_name: candidate.operation_name } : { service: candidate.service, method: e.attrs.method }) };
    facts.push(nodeFact('contract', op, { name: op, attrs }, pv(candidate.line)),
      edgeFact('DEFINES', client, `contract:${op}`, {}, pv(candidate.line)),
      edgeFact('CONSUMES', `module:${path}`, `contract:${op}`, {}, pv(candidate.line)),
      edgeFact('CONSUMES', `contract:${op}`, e.id, { via: 'contract', contract_key: op }, pv(candidate.line)));
  }
  return facts;
}
