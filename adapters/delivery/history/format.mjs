// Delivery history as evidence (docs/runtime-evidence.md, "Delivery history"). One
// normalised row per deployment: unit, deployed_at, status and the optional
// environment, commit, committed_at, release and code_root columns. This module reads
// no file, touches no store and never contacts a CI/CD system; vendor exports are
// converted to these rows with the recipes in the docs.

import { csvRecords } from '../../runtime/metrics.mjs';
import { safeName, toIso } from '../../runtime/util.mjs';

export const DELIVERY_COLUMNS = Object.freeze([
  'unit', 'deployed_at', 'status', 'environment', 'commit', 'committed_at', 'release', 'code_root',
]);
export const MAX_DELIVERY_ROWS = 100_000;
export const DEFAULT_ENVIRONMENT = 'production';

const REQUIRED = ['unit', 'deployed_at', 'status'];
const STATUSES = Object.freeze({
  success: 'success', succeeded: 'success', ok: 'success',
  failure: 'failure', failed: 'failure', error: 'failure',
  rolled_back: 'rolled_back', rollback: 'rolled_back', reverted: 'rolled_back',
});

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const lc = (raw) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).trim().toLowerCase(), v]));

/** A status spelling to its normalised value, or null when it is not a deployment. */
export function normaliseStatus(v) {
  if (blank(v)) return null;
  const key = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STATUSES[key] ?? null;
}

function parseTime(v, field) {
  const t = Date.parse(String(v).trim());
  if (!Number.isFinite(t)) throw new Error(`${field} "${v}" is not a valid timestamp`);
  return toIso(t);
}

/** A repository-relative code root, or null when absent. Absolute and `..` values are refused. */
function cleanRoot(v) {
  if (blank(v)) return null;
  const raw = String(v).trim();
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`code_root "${v}" is absolute; it must be relative to the repository`);
  }
  if (raw.split(/[\\/]/).includes('..')) throw new Error(`code_root "${v}" must not contain .. segments`);
  const s = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return s === '' ? '.' : safeName(s, 300);
}

/**
 * One raw row to a counted deployment, to `skipped` (not a deployment of the chosen
 * environment), or throws a sentence naming the field that is wrong. A row whose
 * status is not a deployment outcome, or whose environment is not the chosen one, is
 * skipped before the other fields are judged: it records no deployment.
 */
function normaliseRow(raw, environment) {
  if (blank(raw.status)) throw new Error('status is empty');
  const status = normaliseStatus(raw.status);
  if (!status) return { skipped: 'status' };
  const env = blank(raw.environment) ? DEFAULT_ENVIRONMENT : safeName(raw.environment, 100);
  if (env.toLowerCase() !== environment.toLowerCase()) return { skipped: 'environment' };
  const unit = safeName(raw.unit, 200);
  if (!unit) throw new Error('unit is empty');
  if (blank(raw.deployed_at)) throw new Error('deployed_at is empty');
  return {
    unit,
    deployed_at: parseTime(raw.deployed_at, 'deployed_at'),
    status,
    environment: env,
    commit: blank(raw.commit) ? null : safeName(raw.commit, 200),
    committed_at: blank(raw.committed_at) ? null : parseTime(raw.committed_at, 'committed_at'),
    release: blank(raw.release) ? null : safeName(raw.release, 200),
    code_root: cleanRoot(raw.code_root),
  };
}

function rawRows(text) {
  const body = String(text ?? '').replace(/^﻿/, '');
  if (/^\s*[[{]/.test(body)) {
    let doc;
    try {
      doc = JSON.parse(body);
    } catch {
      // Not one JSON document: JSON Lines, one row object per line.
      const lines = body.split(/\r?\n/).filter((l) => l.trim() !== '');
      try {
        return lines.map((l) => JSON.parse(l));
      } catch (err) {
        throw new Error(`not valid JSON or JSON Lines: ${err.message}`);
      }
    }
    if (Array.isArray(doc)) return doc;
    if (Array.isArray(doc?.rows)) return doc.rows;
    return [doc];
  }
  const recs = csvRecords(body);
  if (!recs.length) throw new Error('the file has no header row');
  const head = recs[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`header lacks column(s) ${missing.join(', ')}; expected ${DELIVERY_COLUMNS.join(', ')}`);
  return recs.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/**
 * Read a delivery-history export.
 * @param {string} text a JSON array of rows, JSON Lines, or CSV with a header
 * @param {{environment?: string}} [opts] only rows of this environment count (default `production`)
 * @returns {{rows: object[], invalid: {row: number, error: string}[], total: number,
 *   skipped_status: number, skipped_environment: number, environment: string,
 *   window: {start: string, end: string}|null}}
 *   Row numbers are 1-based data rows. `window` spans the counted rows.
 */
export function readDeliveries(text, { environment = DEFAULT_ENVIRONMENT } = {}) {
  const env = blank(environment) ? DEFAULT_ENVIRONMENT : String(environment).trim();
  const raws = rawRows(text);
  if (raws.length > MAX_DELIVERY_ROWS) throw new Error(`${raws.length} rows is over the limit of ${MAX_DELIVERY_ROWS}`);
  const rows = [];
  const invalid = [];
  let skipped_status = 0;
  let skipped_environment = 0;
  raws.forEach((raw, i) => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('row is not an object');
      const row = normaliseRow(lc(raw), env);
      if (row.skipped === 'status') skipped_status += 1;
      else if (row.skipped === 'environment') skipped_environment += 1;
      else rows.push({ ...row, line: i + 1 });
    } catch (err) {
      invalid.push({ row: i + 1, error: err.message });
    }
  });
  const times = rows.map((r) => r.deployed_at).sort();
  return {
    rows,
    invalid,
    total: raws.length,
    skipped_status,
    skipped_environment,
    environment: env,
    window: times.length ? { start: times[0], end: times[times.length - 1] } : null,
  };
}
