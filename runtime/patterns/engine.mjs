// The pattern engine (spec §13). Cards are versioned YAML loaded by progressive
// disclosure: `index()` reads every card's header once; `card(id)` returns one card.
// `evaluate(card, signals)` is deterministic: it never recommends a card because it
// exists, only reports how measured signals meet its applicability, preconditions and
// contraindications. Unmeasured signals are evidence gaps, never passes.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnknotError } from '../core/errors.mjs';
import { validateArtifact } from '../core/schema.mjs';
import { parseYAML } from '../core/yaml.mjs';

const ROOT = fileURLToPath(new URL('../../patterns/', import.meta.url));

let cache = null;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.yaml') || name.endsWith('.yml')) out.push(p);
  }
  return out;
}

/** Load and validate every card. Invalid cards are excluded and reported, not used. */
export function loadCatalog(root = ROOT) {
  if (cache && cache.root === root) return cache;
  const cards = new Map();
  const invalid = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    try {
      const card = parseYAML(readFileSync(file, 'utf8'), { filename: rel });
      const v = validateArtifact('pattern-card', card);
      if (!v.valid) {
        invalid.push({ file: rel, errors: v.errors.slice(0, 3) });
        continue;
      }
      if (cards.has(card.id)) {
        invalid.push({ file: rel, errors: [{ message: `duplicate id ${card.id}` }] });
        continue;
      }
      cards.set(card.id, { ...card, file: rel });
    } catch (err) {
      invalid.push({ file: rel, errors: [{ message: err.message }] });
    }
  }
  cache = { root, cards, invalid };
  return cache;
}

/** Headers only: what the model sees before asking for a specific card. */
export function index({ category, treatment } = {}) {
  return [...loadCatalog().cards.values()]
    .filter((c) => (!category || c.category === category) && (!treatment || c.treatment === treatment))
    .map((c) => ({ id: c.id, name: c.name, category: c.category, treatment: c.treatment ?? null, problem: c.problem }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function card(id) {
  const c = loadCatalog().cards.get(id);
  if (!c) throw new UnknotError('UK_NOT_FOUND', `no pattern card ${id}`);
  return c;
}

const OPS = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

/** @returns {'true'|'false'|'unknown'} */
export function test(predicate, signals) {
  if (!predicate) return 'unknown';
  const v = signals[predicate.metric];
  if (v === undefined || v === null || Number.isNaN(v)) return 'unknown';
  const fn = OPS[predicate.op];
  if (!fn) return 'unknown';
  return fn(Number(v), Number(predicate.value)) ? 'true' : 'false';
}

/**
 * Evaluate one card against measured signals.
 * @returns {{id, fit: 'fits'|'contraindicated'|'insufficient_evidence'|'not_applicable', reasons: string[], checked: object[], gaps: string[]}}
 */
export function evaluate(c, signals) {
  const checked = [];
  const reasons = [];
  const gaps = new Set();
  const check = (kind, item) => {
    const result = test(item.predicate, signals);
    const value = item.predicate ? signals[item.predicate.metric] ?? null : null;
    checked.push({ kind, id: item.id, result, value, predicate: item.predicate ?? null, hard: Boolean(item.hard) });
    if (result === 'unknown' && item.predicate) gaps.add(item.predicate.metric);
    return result;
  };
  let contraindicated = false;
  for (const item of c.contraindications ?? []) {
    const r = check('contraindication', item);
    if (r === 'true' && item.hard) {
      contraindicated = true;
      reasons.push(`contraindicated: ${item.description ?? item.id} (${item.predicate.metric}=${signals[item.predicate.metric]})`);
    } else if (r === 'true') reasons.push(`caution: ${item.description ?? item.id}`);
  }
  let unmet = false;
  for (const item of c.preconditions ?? []) {
    const r = check('precondition', item);
    if (r === 'false') {
      unmet = true;
      reasons.push(`precondition not met: ${item.description ?? item.id}`);
    }
  }
  const applicability = (c.applicability_signals ?? []).map((item) => check('applicability', item));
  const measurable = (c.applicability_signals ?? []).filter((i) => i.predicate).length;
  const anyTrue = applicability.includes('true');
  const allFalse = measurable > 0 && applicability.every((r, i) => r === 'false' || !(c.applicability_signals[i].predicate));
  let fit;
  if (contraindicated || unmet) fit = 'contraindicated';
  else if (anyTrue && checked.filter((x) => x.kind !== 'applicability' && x.hard && x.result === 'unknown').length === 0) fit = 'fits';
  else if (allFalse && !anyTrue) fit = 'not_applicable';
  else fit = 'insufficient_evidence';
  if (fit === 'fits') reasons.unshift(`favouring signals: ${checked.filter((x) => x.kind === 'applicability' && x.result === 'true').map((x) => `${x.id} (${x.predicate.metric}=${x.value})`).join(', ')}`);
  if (fit === 'insufficient_evidence' && gaps.size) reasons.push(`not measured: ${[...gaps].join(', ')}`);
  return { id: c.id, fit, reasons, checked, gaps: [...gaps] };
}

/** Evaluate a list of card ids; unknown ids are reported rather than silently dropped. */
export function evaluateAll(ids, signals) {
  return ids.map((id) => {
    try {
      const r = evaluate(card(id), signals);
      return { id: r.id, fit: r.fit, reasons: r.reasons };
    } catch {
      return { id, fit: 'not_evaluated', reasons: ['card not in catalog'] };
    }
  });
}

export function resetCatalog() {
  cache = null;
}
