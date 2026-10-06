// Where each line of a configuration proposal came from, so a person can tell a detected fact
// from an inference. `unknot init` records a source for every line it did not take from the
// template, in a sidecar beside the proposal; the proposal itself, and so the accepted config
// format, is unchanged. Nothing here grants anything: it labels lines and filters a proposal.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { digest } from '../core/canonical.mjs';

/** One comparable entry per setting; list items and argv-valued commands are single entries. */
export function flattenConfig(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    const scalars = value.every((v) => v === null || typeof v !== 'object');
    if (prefix.startsWith('commands.')) out.set(prefix, { text: `${prefix}: ${value.join(' ')}`, value });
    else if (scalars) for (const item of value) out.set(`${prefix}[${item}]`, { text: `${prefix}: ${item}`, value: item, list: prefix });
    else out.set(prefix, { text: `${prefix}: ${JSON.stringify(value)}`, value });
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flattenConfig(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.set(prefix, { text: `${prefix}: ${JSON.stringify(value)}`, value });
  return out;
}

/** The sidecar key of a proposed list item, matching flattenConfig. */
export const itemKey = (list, item) => `${list}[${item}]`;

/** Record the sources of `proposedText`'s lines. `entries`: { key: {source, file?, line?, sentence?} }; `omitted`: rules that kept a detected command out. */
export function writeSources(paths, proposedText, { entries = {}, omitted = [] } = {}) {
  writeFileSync(paths.proposedSources, `${JSON.stringify({ version: 1, digest: digest(proposedText), entries, omitted }, null, 2)}\n`);
}

export function clearSources(paths) {
  rmSync(paths.proposedSources, { force: true });
}

/** The recorded sources when they belong to exactly this proposal text, else null. */
export function readSources(paths, proposedText) {
  if (!existsSync(paths.proposedSources)) return null;
  try {
    const s = JSON.parse(readFileSync(paths.proposedSources, 'utf8'));
    return s?.version === 1 && s.digest === digest(proposedText) ? s : null;
  } catch {
    return null;
  }
}

/** `detected: <file>:<line>`, `guidance: <file>:<line> "<sentence>"` or `default`. */
export function sourceLabel(e) {
  if (!e) return 'default';
  if (e.source === 'detected') return `detected: ${e.file}:${e.line}`;
  if (e.source === 'workspace add') return 'workspace add';
  if (e.source === 'guidance') return `guidance: ${e.file}:${e.line} "${e.sentence}"`;
  return 'default';
}

/**
 * Changed entries between two parsed configs, each with its source.
 * @returns {{added: object[], removed: object[], guidance: object[], omitted: object[], known: boolean}}
 */
export function diffConfig(current, proposed, sources) {
  const a = flattenConfig(current ?? {});
  const b = flattenConfig(proposed ?? {});
  const known = Boolean(sources);
  const label = (key) => (known ? sourceLabel(sources.entries[key]) : 'unknown: this proposal has no source record (not written by `unknot init`, or edited since)');
  const changes = [];
  for (const [key, e] of b) {
    const old = a.get(key);
    if (old && old.text === e.text) continue;
    if (old && !e.list) changes.push({ sign: '-', key, text: old.text, label: 'current' });
    changes.push({ sign: '+', key, text: e.text, label: label(key), guidance: sources?.entries[key]?.source === 'guidance' });
  }
  for (const [key, e] of a) if (!b.has(key)) changes.push({ sign: '-', key, text: e.text, label: 'current' });
  const omitted = (sources?.omitted ?? []).map((o) => ({ sign: '!', key: o.key, text: `${o.key}: ${o.argv.join(' ')} (not proposed)`, label: sourceLabel(o), guidance: true }));
  return {
    changes: changes.filter((c) => !c.guidance),
    guidance: [...changes.filter((c) => c.guidance), ...omitted],
    known,
  };
}

/** The diff as text: every line ends in its source; guidance-derived lines are grouped and flagged. */
export function renderDiff(d, { currentExists }) {
  const row = (c) => `${c.sign} ${c.text}    [${c.label}]`;
  const out = [currentExists ? '--- current' : '--- (no config: built-in defaults)', '+++ proposed', ''];
  if (!d.changes.length && !d.guidance.length) out.push('No changes. [default]');
  out.push(...d.changes.map(row));
  if (d.guidance.length) {
    out.push('', 'Inferred from repository guidance. These need your judgement: a sentence can be read wrongly (an exception taken for a ban, a note for a rule). `unknot config accept --detected-only` accepts the proposal without them.', ...d.guidance.map(row));
  }
  return out.join('\n');
}

/**
 * The proposal without the lines guidance produced. A line already in the current config stays:
 * accepting a proposal never removes what a person accepted before.
 * @returns {{proposed: object, dropped: object[]}}
 */
export function withoutGuidance(current, proposed, sources) {
  const cur = flattenConfig(current ?? {});
  const result = structuredClone(proposed);
  const dropped = [];
  for (const [key, e] of Object.entries(sources.entries)) {
    if (e.source !== 'guidance' || cur.has(key)) continue;
    const m = /^([^[]*)\[(.*)\]$/s.exec(key);
    if (m) {
      const list = m[1].split('.').reduce((o, k) => o?.[k], result);
      if (Array.isArray(list) && list.includes(m[2])) {
        list.splice(list.indexOf(m[2]), 1);
        dropped.push({ key, label: sourceLabel(e) });
      }
    } else {
      const path = key.split('.');
      const holder = path.slice(0, -1).reduce((o, k) => o?.[k], result);
      if (holder && path.at(-1) in holder) {
        delete holder[path.at(-1)];
        dropped.push({ key, label: sourceLabel(e) });
      }
    }
  }
  return { proposed: result, dropped };
}
