// HTTP routes compared across frameworks, files and repositories. A client declares
// `GET /v1/orders/{id}`; the server that answers it may call the parameter `{orderId}`, write
// the path without its leading slash or end it with one. The key is what such spellings
// share: the upper-case method and the path with every parameter reduced to `:`.

/** `{id}`, `{id:guid}`, `:id` and `{*rest}` are all one parameter segment. */
const PARAM = /^(?::[\w*]+\??|\{\**[^}/]*\}\??)$/;

/** Method plus path template with parameter names dropped, or null for a route that cannot be keyed. */
export function routeKey(method, path) {
  const m = String(method ?? '').trim().toUpperCase();
  if (!m || path === undefined || path === null) return null;
  const segments = String(path).replace(/[?#].*$/, '').split('/').filter((s) => s !== '').map((s) => (PARAM.test(s) ? ':' : s));
  return `${m} /${segments.join('/')}`;
}

/** The key of an `endpoint:` or client-operation `contract:` node id such as `endpoint:GET /v1/orders/:id`. */
export function routeKeyOfId(id) {
  const m = /^(?:endpoint|contract):(?:[^:\s]+:)?([A-Za-z]+) (\/[^\s]*)$/.exec(String(id));
  return m ? routeKey(m[1], m[2]) : null;
}

/** Client/service identity: HTTP normalization stays separate from RPC/schema names. */
export function operationKey(node) {
  if (node?.attrs?.contract_key) return node.attrs.contract_key;
  if (/^endpoint:(?:RPC|GRAPHQL) /.test(node?.id ?? '')) return node.id.slice('endpoint:'.length);
  return routeKeyOfId(node?.id) ?? routeKey(node?.attrs?.method, node?.attrs?.path);
}

/** A generated client/query document matched against a declared service/schema operation. */
export function clientMatches(client, endpoint) {
  const c = client?.attrs ?? client;
  const e = endpoint?.attrs;
  if (!e?.from_contract) return false;
  if (c?.kind === 'rpc_client') {
    const methodKey = (s) => String(s).replace(/_/g, '').toLowerCase();
    return endpoint.id.startsWith('endpoint:RPC ') && e.service === c.service
      && (!(c.methods?.length) || c.methods.some((m) => methodKey(m) === methodKey(e.method)));
  }
  return c?.kind === 'graphql_client' && endpoint.id.startsWith('endpoint:GRAPHQL ')
    && e.operation === c.operation && (c.fields?.includes(e.field) || c.operation_name === e.field);
}
