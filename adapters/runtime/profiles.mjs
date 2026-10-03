// Profile parsers (collapsed stacks and speedscope JSON) reduced to self-time hotspots.
// Only frame names and percentages are kept; stacks themselves are discarded.

import { nodeFact } from '../../runtime/graph/facts.mjs';
import { codeRootOf, round, safeName, stamper } from './util.mjs';

const TOP = 50;
const MAX_LINES = 2_000_000;

/** `a;b;c 123` lines: self time belongs to the leaf frame. */
export function parseCollapsed(text) {
  const self = new Map();
  let total = 0;
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if ((n += 1) > MAX_LINES) break;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const count = Number(line.slice(sp + 1));
    if (!Number.isFinite(count) || count <= 0) continue;
    const stack = line.slice(0, sp);
    const frame = safeName(stack.slice(stack.lastIndexOf(';') + 1));
    if (frame === '') continue;
    self.set(frame, (self.get(frame) ?? 0) + count);
    total += count;
  }
  return { self, total };
}

/** Speedscope: sampled profiles (leaf of each sample) and evented profiles (open/close). */
export function parseSpeedscope(doc) {
  const frames = (doc.shared?.frames ?? []).map((f) => safeName(f?.name));
  const self = new Map();
  let total = 0;
  const add = (idx, w) => {
    const name = frames[idx];
    if (!name || !(w > 0)) return;
    self.set(name, (self.get(name) ?? 0) + w);
    total += w;
  };
  for (const p of doc.profiles ?? []) {
    if (p.type === 'sampled') {
      const samples = p.samples ?? [];
      for (let i = 0; i < samples.length && i < MAX_LINES; i += 1) {
        const s = samples[i];
        if (Array.isArray(s) && s.length) add(s[s.length - 1], p.weights?.[i] ?? 1);
      }
    } else if (p.type === 'evented') {
      const stack = [];
      let last = null;
      for (const e of (p.events ?? []).slice(0, MAX_LINES)) {
        if (last !== null && stack.length) add(stack[stack.length - 1], e.at - last);
        last = e.at;
        if (e.type === 'O') stack.push(e.frame);
        else if (e.type === 'C') stack.pop();
      }
    }
  }
  return { self, total };
}

export function hotspots({ self, total }) {
  if (total <= 0) return [];
  return [...self].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP)
    .map(([frame, v]) => ({ frame, self_pct: round((100 * v) / total, 2) }));
}

/** Node named by the file: a `service:` when service_map knows it, else a synthetic module. */
export function deriveProfileFacts(text, { file, options, now, ttlDays }) {
  const first = text.trimStart()[0];
  const parsed = first === '{' ? parseSpeedscope(JSON.parse(text)) : parseCollapsed(text);
  const base = file.split('/').pop().replace(/(\.(collapsed|folded|stacks|speedscope|txt|json))+$/i, '');
  const name = safeName(base) || 'profile';
  const st = stamper({ file, sourceType: 'trace', window: { start: now, end: now }, ttlDays });
  const known = options?.service_map && Object.hasOwn(options.service_map, name);
  const attrs = st.attrs({
    hotspots: hotspots(parsed),
    sample_total: Math.round(parsed.total),
    code_root: known ? codeRootOf(options, name) : null,
    synthetic: known ? null : true,
  });
  const fact = known
    ? nodeFact('service', name, { name, attrs }, st.prov(`profile/${name}`, 'medium'))
    : nodeFact('module', `~profile/${name}`, { name, attrs }, st.prov(`profile/${name}`, 'medium'));
  return [fact];
}
