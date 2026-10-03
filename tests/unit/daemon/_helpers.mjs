// Shared test helpers: hand-built JWTs and JWKS (no JWT library), and a raw HTTP client
// that can set the Host header (fetch forbids it).

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** Generate a signing key of the given JOSE alg plus its public JWK (with kid). */
export function makeKey(alg, kid) {
  const pair = alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig' };
  return { alg, kid, privateKey: pair.privateKey, publicKey: pair.publicKey, jwk };
}

export const jwks = (...keys) => ({ keys: keys.map((k) => k.jwk) });

/** Sign a compact JWS. `header`/`payload` override defaults; pass `signature` to forge one. */
export function makeJwt(key, payload, { header = {}, signature } = {}) {
  const h = b64u({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header });
  const p = b64u(payload);
  const data = Buffer.from(`${h}.${p}`);
  let sig = signature;
  if (sig === undefined) {
    const alg = header.alg ?? key.alg;
    if (alg === 'RS256') sig = sign('sha256', data, key.privateKey);
    else if (alg === 'ES256') sig = sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    else if (alg === 'EdDSA') sig = sign(null, data, key.privateKey);
    else sig = Buffer.alloc(0);
  }
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

export const claimsFor = (over = {}) => ({
  iss: 'https://idp.example',
  aud: 'unknot',
  sub: 'user-1',
  iat: nowSec(),
  nbf: nowSec() - 5,
  exp: nowSec() + 600,
  groups: ['eng'],
  tenants: ['acme'],
  ...over,
});

export { createPrivateKey, createPublicKey };

/** Minimal HTTP(S) client returning {status, headers, text, json}. */
export function request(base, method, path, { headers = {}, body, rawBody, tls } = {}) {
  const url = new URL(base);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, method, path, headers: { ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}), ...headers }, ...tls },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // NDJSON or empty
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
