// Shared helpers for the ownership adapter, chiefly the privacy boundary: an owner given as
// an e-mail address is NEVER stored. It becomes `owner:email:<sha256 prefix>` so the graph can
// still tell two owners apart (and join the same address across CODEOWNERS, OWNERS and the
// catalog) without ever holding the personal data.

import { createHash } from 'node:crypto';
import { prov, nodeFact } from '../../runtime/graph/facts.mjs';

export const ID = 'ownership';
export const VERSION = '0.1.0';
export const EXTRACTOR = `${ID}@${VERSION}`;
export const MAX_FACTS = 5000;

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
export const uniqSorted = (xs) => [...new Set(xs)].sort();
export const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
export const keyOf = (id) => id.slice(id.indexOf(':') + 1);

export function P(path, line, confidence = 'high', source_type = 'config') {
  return prov({ source_type, source_ref: `${path}:${line || 1}`, extractor: EXTRACTOR, confidence });
}

export function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export function capFacts(facts) {
  if (facts.length <= MAX_FACTS) return facts;
  const out = facts.slice(0, MAX_FACTS);
  const i = out.findIndex((f) => f.kind === 'node');
  if (i !== -1) out[i] = { ...out[i], attrs: { ...out[i].attrs, truncated: true } };
  return out;
}

const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
export const EMAIL_ANYWHERE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** First 16 hex chars of sha256 over the trimmed, lower-cased address. */
export function emailHash(email) {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** Replace every e-mail address in free text; ADR summaries and titles go through this. */
export const redactEmails = (s) => s.replace(EMAIL_ANYWHERE, '[email]');

/**
 * Turn an owner token into {id, fact-args}. `@org/team` is a team, `@user` an owner, an
 * e-mail an anonymised owner. Anything else (a bare word, `*`) is not an owner.
 * @returns {{type: 'team'|'owner', key: string, name: string, attrs: object}|null}
 */
export function parseOwnerToken(token) {
  const t = token.trim();
  if (/^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t)) return { type: 'team', key: t, name: t, attrs: { handle: t } };
  if (/^@[A-Za-z0-9_.-]+$/.test(t)) return { type: 'owner', key: t, name: t, attrs: { kind: 'user', handle: t } };
  if (EMAIL_RE.test(t)) {
    const h = emailHash(t);
    return { type: 'owner', key: `email:${h}`, name: `email:${h}`, attrs: { kind: 'email', email_hash: h } };
  }
  return null;
}

/** Build the owner/team node fact for a parsed token. */
export function ownerNode(o, provenance) {
  return nodeFact(o.type, o.key, { name: o.name, attrs: o.attrs }, provenance);
}

export const ownerId = (o) => `${o.type}:${o.key}`;
