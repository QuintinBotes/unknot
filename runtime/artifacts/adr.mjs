// Architecture decision records in MADR form, for campaign decisions. The inputs are
// strings the planner and the humans produced, so they are laid out as data: a heading
// inside a field cannot add a section, and a newline inside a bullet cannot add a bullet.

const STATUSES = ['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'];

/** Collapse to one line (list items, headings). */
const line = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Keep paragraphs but demote anything that looks like a heading or a fence. */
const block = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim().split('\n').map((l) => l.replace(/^(\s*)(#+)/, '$1\\$2').replace(/^(\s*)```/, '$1\\`\\`\\`')).join('\n');

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function option(a, chosen) {
  if (typeof a === 'string') return { title: line(a), summary: '', pros: [], cons: [] };
  return { title: line(a.title ?? a.id ?? a.name ?? 'option'), summary: line(a.summary ?? a.description ?? ''), pros: asList(a.pros).map(line), cons: asList(a.cons).map(line), id: a.id, chosen };
}

function consequenceLines(c) {
  if (c == null) return [];
  if (typeof c === 'string') return [`* ${line(c)}`];
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? `* ${line(x)}` : `* ${line(x.kind ? `${x.kind[0].toUpperCase()}${x.kind.slice(1)}, ${x.text ?? x.summary}` : x.text ?? x.summary)}`));
  return [
    ...asList(c.good).map((x) => `* Good, because ${line(x)}`),
    ...asList(c.bad).map((x) => `* Bad, because ${line(x)}`),
    ...asList(c.neutral).map((x) => `* Neutral, ${line(x)}`),
  ];
}

/**
 * @param {{id: string, title: string, status?: string, context: string, decision: string,
 *   alternatives?: (string|{title?: string, id?: string, summary?: string, pros?: string[], cons?: string[]})[],
 *   consequences?: string|string[]|{good?: string[], bad?: string[], neutral?: string[]},
 *   evidence?: (string|{ref?: string, label?: string, summary?: string})[], date?: string, deciders?: string[]}} adr
 * @returns {string} markdown
 */
export function adrMarkdown({ id, title, status = 'proposed', context, decision, alternatives = [], consequences, evidence = [], date, deciders = [] }) {
  if (!id || !title) throw new TypeError('an ADR needs an id and a title');
  if (!STATUSES.includes(status)) throw new TypeError(`ADR status must be one of ${STATUSES.join(', ')}`);
  const out = [`# ${line(id)}: ${line(title)}`, '', `* Status: ${status}`];
  if (date) out.push(`* Date: ${line(date)}`);
  if (deciders.length) out.push(`* Deciders: ${deciders.map(line).join(', ')}`);
  out.push('', '## Context and Problem Statement', '', block(context) || 'Not stated.');
  const opts = asList(alternatives).map((a) => option(a));
  if (opts.length) {
    out.push('', '## Considered Options', '', ...opts.map((o) => `* ${o.title}`));
  }
  out.push('', '## Decision Outcome', '', block(decision) || 'Not stated.');
  const cons = consequenceLines(consequences);
  if (cons.length) out.push('', '### Consequences', '', ...cons);
  const detailed = opts.filter((o) => o.summary || o.pros.length || o.cons.length);
  if (detailed.length) {
    out.push('', '## Pros and Cons of the Options');
    for (const o of detailed) {
      out.push('', `### ${o.title}`, '');
      if (o.summary) out.push(o.summary, '');
      out.push(...o.pros.map((p) => `* Good, because ${p}`), ...o.cons.map((c) => `* Bad, because ${c}`));
    }
  }
  const ev = asList(evidence);
  if (ev.length) {
    out.push('', '## More Information', '', 'Evidence considered:');
    for (const e of ev) out.push(typeof e === 'string' ? `* ${line(e)}` : `* ${[e.ref ? `\`${line(e.ref)}\`` : '', e.label ? `(${line(e.label)})` : '', line(e.summary)].filter(Boolean).join(' ')}`);
  }
  return `${out.join('\n')}\n`;
}
