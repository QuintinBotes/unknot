// The optional API daemon (spec §24). Local by default: loopback only, bearer token from a
// 0600 file, Host allowlist against DNS rebinding. Remote mode adds mutual TLS and an OIDC
// JWT with RBAC and per-tenant project isolation. See README.md for the threat model.

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { UnknotError } from '../core/errors.mjs';
import { resolveInside } from '../core/paths.mjs';
import { isInitialized } from '../core/project.mjs';
import { openProject } from '../context.mjs';
import { loadConfig } from '../policy/config.mjs';
import { ROLES, TENANT_RE, bearerToken, checkTenant, constantTimeEqual, createJwksProvider, ensureTokenFile, mapRole, roleAtLeast, verifyJwt } from './auth.mjs';
import { ApiError, Mutex, RateLimiter, idempotencyKey, readJsonBody, requireJsonContentType, sendError, sendJson, withIdempotency } from './http.mjs';
import { matchRoute } from './routes.mjs';

const LOOPBACK = new Map([
  ['127.0.0.1', '127.0.0.1'],
  ['localhost', '127.0.0.1'],
  ['[::1]', '::1'],
  ['::1', '::1'],
]);

/** Split `host:port` (IPv6 in brackets). */
export function parseListen(listen) {
  const m = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(String(listen ?? ''));
  if (!m || Number(m[2]) > 65535) throw new UnknotError('UK_CONFIG_INVALID', `daemon.listen must be host:port, got ${listen}`);
  return { host: m[1], port: Number(m[2]) };
}

const missing = (what) => new UnknotError('UK_CONFIG_INVALID', `remote daemon mode requires ${what}`, { details: { policy: 'daemon.remote' } });

/**
 * @param {{root: string, config: object, port?: number, host?: string, rateLimit?: {perMinute?: number}, now?: () => number, onError?: (err: unknown) => void}} opts
 *   `root` is the project root (local mode) or the directory holding one project directory
 *   per tenant (remote mode). `config` is the effective Unknot config (uses `config.daemon`).
 * @returns {{listen: () => Promise<{port: number, url: string}>, close: () => Promise<void>, port: number, url: string, tokenFile: string|null, mode: string}}
 */
export function createDaemon({ root, config, port: portOverride, host: hostOverride, rateLimit = {}, now, onError = () => {} }) {
  const dcfg = config?.daemon ?? {};
  const mode = dcfg.mode ?? 'local';
  if (mode !== 'local' && mode !== 'remote') throw new UnknotError('UK_CONFIG_INVALID', `unknown daemon mode ${mode}`);
  const parsed = parseListen(hostOverride ? `${hostOverride}:${portOverride ?? 0}` : dcfg.listen ?? '127.0.0.1:7433');
  const wantPort = portOverride ?? parsed.port;
  let bindHost = parsed.host.replace(/^\[|\]$/g, '');

  const limiter = new RateLimiter({ perMinute: rateLimit.perMinute ?? 60, now });
  const mutexes = new Map();
  const mutexFor = (key) => mutexes.get(key) ?? mutexes.set(key, new Mutex()).get(key);

  let local = null; // {ctx, token, tokenFile}
  let remote = null; // {jwks, oidc, tenants, contexts}
  let tlsOptions = null;

  if (mode === 'local') {
    // Refuse before opening anything: a non-loopback bind is a policy violation, not a typo.
    if (!LOOPBACK.has(parsed.host)) {
      throw new UnknotError('UK_POLICY_DENIED', `local daemon mode binds loopback only; refusing ${parsed.host}. Remote exposure needs daemon.mode: remote with mutual TLS and OIDC`, { details: { policy: 'daemon.local.loopback_only', host: parsed.host } });
    }
    bindHost = LOOPBACK.get(parsed.host);
    const ctx = openProject(root);
    const tok = ensureTokenFile(ctx.projectId);
    local = { ctx, token: tok.token, tokenFile: tok.path };
  } else {
    const { tls = {}, oidc = {}, tenants = [] } = dcfg;
    if (!tls.cert || !tls.key || !tls.client_ca) throw missing('daemon.tls.cert, key and client_ca (mutual TLS)');
    if (!oidc.issuer || !oidc.audience || !oidc.jwks_file || !oidc.role_claim || !oidc.role_map) throw missing('daemon.oidc issuer, audience, jwks_file, role_claim and role_map');
    for (const [group, roles] of Object.entries(oidc.role_map)) {
      if (!Array.isArray(roles) || roles.some((r) => !ROLES.includes(r))) throw new UnknotError('UK_CONFIG_INVALID', `daemon.oidc.role_map["${group}"] must list only: ${ROLES.join(', ')}`);
    }
    if (!tenants.length || tenants.some((t) => !TENANT_RE.test(t))) throw missing('daemon.tenants naming at least one valid tenant id');
    tlsOptions = {
      cert: readFileSync(tls.cert),
      key: readFileSync(tls.key),
      ca: readFileSync(tls.client_ca),
      // Mutual TLS: the handshake itself fails for a client without a certificate our CA signed.
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    };
    remote = { jwks: createJwksProvider(oidc.jwks_file), oidc, tenants, contexts: new Map() };
  }

  /** Tenant project context. The tenant directory must itself hold `.unknot`: openProject would otherwise walk UP into a parent project. */
  function tenantContext(tenant) {
    let ctx = remote.contexts.get(tenant);
    if (!ctx) {
      const dir = resolveInside(root, tenant, { allowRoot: false }).abs;
      if (!isInitialized(dir)) throw new UnknotError('UK_NOT_FOUND', 'tenant project is not initialised');
      ctx = openProject(dir);
      remote.contexts.set(tenant, ctx);
    }
    return ctx;
  }

  /** Authenticate the request. @returns {{sub: string, actor: string, role: string, tenant: string|null, ctx: object}} */
  function authenticate(req) {
    const presented = bearerToken(req.headers.authorization);
    if (mode === 'local') {
      if (!presented || !constantTimeEqual(presented, local.token)) throw new ApiError(401, 'UK_POLICY_DENIED', 'invalid or missing bearer token', { details: { reason: 'unauthenticated' } });
      return { sub: 'local', actor: 'ci:api:local', role: 'admin', tenant: null, ctx: local.ctx };
    }
    if (!presented) throw new ApiError(401, 'UK_POLICY_DENIED', 'invalid or missing bearer token', { details: { reason: 'unauthenticated' } });
    let claims;
    try {
      ({ claims } = verifyJwt(presented, { keys: remote.jwks(), issuer: remote.oidc.issuer, audience: remote.oidc.audience }));
    } catch (err) {
      if (err instanceof UnknotError && err.details?.reason === 'unauthenticated') throw new ApiError(401, err.code, err.message, { details: { reason: 'unauthenticated' } });
      throw err;
    }
    const role = mapRole(claims, remote.oidc);
    if (!role) throw new UnknotError('UK_POLICY_DENIED', 'token grants no Unknot role', { details: { reason: 'no_role' } });
    const tenant = checkTenant(claims, req.headers['x-unknot-tenant'], remote.tenants);
    // The event and slice schemas admit human|model|runtime|ci actors; `ci:api:` marks a non-human API caller.
    const safe = claims.sub.replace(/[^A-Za-z0-9@._:/-]/g, '_').slice(0, 100);
    return { sub: claims.sub, actor: `ci:api:${safe}`, role, tenant, ctx: tenantContext(tenant) };
  }

  let server;
  let boundPort = wantPort;

  /** DNS-rebinding defence: a browser tricked into hitting 127.0.0.1 still sends the attacker's Host. */
  function checkHost(req) {
    if (mode !== 'local') return;
    const h = String(req.headers.host ?? '').toLowerCase();
    if (h !== `127.0.0.1:${boundPort}` && h !== `localhost:${boundPort}` && h !== `[::1]:${boundPort}`) {
      throw new UnknotError('UK_POLICY_DENIED', 'unexpected Host header', { details: { reason: 'host' } });
    }
  }

  async function handle(req, res) {
    try {
      checkHost(req);
      const url = new URL(req.url, 'http://unknot.invalid');
      const ip = req.socket.remoteAddress ?? 'unknown';
      const gate = limiter.take(`ip:${ip}`);
      if (!gate.ok) throw new ApiError(429, 'UK_BUDGET_EXCEEDED', 'rate limit exceeded', { retryable: true, details: { retry_after_seconds: gate.retryAfter } });

      const hit = matchRoute(req.method, url.pathname);
      if (hit?.route?.public) return sendJson(res, 200, (await hit.route.handler()).body);

      const principal = authenticate(req);
      if (mode === 'remote') {
        const g2 = limiter.take(`sub:${principal.tenant}:${principal.sub}`);
        if (!g2.ok) throw new ApiError(429, 'UK_BUDGET_EXCEEDED', 'rate limit exceeded', { retryable: true, details: { retry_after_seconds: g2.retryAfter } });
      }
      if (!hit) throw new UnknotError('UK_NOT_FOUND', 'no such endpoint');
      if (hit.methodNotAllowed) throw new ApiError(405, 'UK_SCHEMA_INVALID', 'method not allowed');
      const { route, params } = hit;
      if (route.denyAlways) return sendJson(res, 403, await toDenied(route, { params }));
      if (!roleAtLeast(principal.role, route.role)) {
        throw new UnknotError('UK_POLICY_DENIED', `role ${principal.role} may not call this endpoint (needs ${route.role})`, { details: { reason: 'rbac', required_role: route.role } });
      }

      const { ctx } = principal;
      const cfg = loadConfig(ctx);
      const c = { ctx, cfg, principal, params, query: url.searchParams, body: {}, req };

      let out;
      if (route.mutating) {
        requireJsonContentType(req);
        c.body = await readJsonBody(req);
        const key = idempotencyKey(req);
        // Serialise per project: handlers await, SQLite does not, and idempotency lookup-then-run must be atomic.
        out = await mutexFor(ctx.root).run(() =>
          withIdempotency(ctx.store, {
            scope: `${principal.tenant ?? '-'}|${principal.sub}`,
            key,
            request: { method: req.method, target: url.pathname + url.search, body: c.body },
            fn: () => route.handler(c),
          }),
        );
      } else {
        out = await route.handler(c);
      }

      if (out.ndjson) {
        res.writeHead(out.status, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        for (const line of out.ndjson) res.write(`${line}\n`);
        return res.end();
      }
      sendJson(res, out.status, out.body, out.headers);
    } catch (err) {
      if (!(err instanceof UnknotError)) onError(err);
      const status = sendError(res, err, err?.details?.retry_after_seconds ? { 'retry-after': String(err.details.retry_after_seconds) } : {});
      void status;
    }
  }

  // The approve route carries a handler that always throws; run it to build the error body.
  async function toDenied(route, c) {
    try {
      route.handler(c);
    } catch (err) {
      return err.toJSON();
    }
    throw new UnknotError('UK_INTEGRITY', 'approve handler returned');
  }

  server = (mode === 'remote' ? createHttpsServer(tlsOptions, handle) : createHttpServer(handle));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  });
  // TLS handshake failures (no client cert) surface here; they are expected noise, not crashes.
  server.on('tlsClientError', () => {});

  return {
    mode,
    tokenFile: local?.tokenFile ?? null,
    get port() {
      return boundPort;
    },
    get url() {
      const h = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
      return `${mode === 'remote' ? 'https' : 'http'}://${h}:${boundPort}`;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantPort, bindHost, () => {
          server.off('error', reject);
          boundPort = server.address().port;
          resolve({ port: boundPort, url: this.url });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
