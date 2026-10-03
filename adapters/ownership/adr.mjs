// Architecture decision records in MADR and Nygard layouts. Extraction records the record's
// own metadata plus the repository paths its text names; `link` (index.mjs) turns those into
// SUPERSEDES and DESCRIBED_BY edges once the node set is known. Free text is data only.

import { parseYAML } from '../../runtime/core/yaml.mjs';
import { nodeFact } from '../../runtime/graph/facts.mjs';
import {
  P, isObj, uniqSorted, redactEmails, dirname, basename,
} from './util.mjs';

const STATUS_WORDS = [
  ['supersed', 'superseded'], ['deprecat', 'deprecated'], ['reject', 'rejected'],
  ['accept', 'accepted'], ['propos', 'proposed'], ['draft', 'proposed'],
];

export function normalizeStatus(raw) {
  const s = String(raw ?? '').toLowerCase();
  for (const [needle, status] of STATUS_WORDS) if (s.includes(needle)) return status;
  return 'unknown';
}

/** Resolve `../x/y.md` relative to the ADR's directory into a repo path. */
function resolveRel(dir, rel) {
  const out = dir === '.' ? [] : dir.split('/');
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** ADR references in a line: markdown links to .md files (paths) and `ADR-0003` numbers. */
function refsIn(line, dir) {
  const refs = [];
  for (const m of line.matchAll(/\]\(([^)#\s]+\.(?:md|markdown))(?:#[^)]*)?\)/g)) {
    if (!/^[a-z]+:/.test(m[1])) refs.push(resolveRel(dir, m[1]));
  }
  for (const m of line.matchAll(/\bADR[-\s_#]*0*(\d+)\b/gi)) refs.push(`#${Number(m[1])}`);
  return refs;
}

function sectionOf(lines, re) {
  const i = lines.findIndex((l) => re.test(l));
  if (i === -1) return null;
  const body = [];
  for (let k = i + 1; k < lines.length; k++) {
    if (/^#{1,6}\s/.test(lines[k])) break;
    body.push(lines[k]);
  }
  return body;
}

function summarize(lines) {
  const body = sectionOf(lines, /^#{2,3}\s+Decision(?:\s+Outcome)?\b/i);
  if (!body) return undefined;
  const text = redactEmails(body.join(' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
  if (!text) return undefined;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** Repo-path-looking tokens (must contain a slash) so link can match them exactly. */
function mentionedPaths(text, self) {
  const out = new Set();
  const stripped = text.replace(/https?:\/\/\S+/g, ' ');
  for (const m of stripped.matchAll(/(?<![\w/.@:-])((?:\.\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]*)/g)) {
    let t = m[1].replace(/^\.\//, '').replace(/\/+$/, '').replace(/[.,;:]+$/, '');
    if (!t.includes('/') || t.includes('..') || t === self) continue;
    out.add(t);
  }
  return [...out].sort().slice(0, 300);
}

export function isAdrCandidate(path) {
  if (!/\.(md|markdown)$/i.test(path)) return false;
  return !/^(readme|index|template|_template|adr-template)(\.|$)/i.test(basename(path));
}

export function parseAdr(path, text) {
  let body = text;
  let front = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    try {
      const parsed = parseYAML(fm[1], { filename: path });
      if (isObj(parsed)) front = parsed;
    } catch {
      front = {};
    }
    body = text.slice(fm[0].length);
  }
  const lines = body.split(/\r?\n/);
  const dir = dirname(path);
  const heading = lines.find((l) => /^#\s+\S/.test(l));
  const title = redactEmails((heading ?? basename(path).replace(/\.(md|markdown)$/i, ''))
    .replace(/^#\s+/, '')
    .replace(/^(?:ADR[-\s_]*)?\d+[.:)\s-]+\s*/i, '')
    .trim());

  // Status: front matter, `## Status` section (Nygard), or a `Status:` line (MADR bullet list).
  let statusRaw = typeof front.status === 'string' ? front.status : undefined;
  const statusSection = sectionOf(lines, /^#{1,6}\s+Status\b/i);
  const statusLines = statusSection ? statusSection.filter((l) => l.trim()) : [];
  if (!statusRaw && statusLines.length) statusRaw = statusLines.join(' ');
  if (!statusRaw) {
    const m = /^\s*[*-]?\s*\**Status\**\s*:\s*\**\s*(.+)$/im.exec(body);
    if (m) statusRaw = m[1];
  }
  const statusText = statusRaw ?? '';

  // Date: front matter, `Date:` line, any ISO date in the head, or the file name.
  const dateOf = (s) => /\b(\d{4}-\d{2}-\d{2})\b/.exec(String(s ?? ''))?.[1];
  const date = dateOf(front.date)
    ?? dateOf(/^\s*[*-]?\s*\**Date\**\s*:\s*(.+)$/im.exec(body)?.[1])
    ?? dateOf(lines.slice(0, 30).join('\n'))
    ?? dateOf(basename(path));

  const supersedes = [];
  const supersededBy = [];
  const relation = [...(statusSection ?? []), ...lines.slice(0, 40), ...(typeof front.supersedes === 'string' ? [`supersedes ${front.supersedes}`] : [])];
  for (const line of relation) {
    const stripped = line.replace(/superseded\s+by/gi, 'SUPERSEDEDBY');
    if (/SUPERSEDEDBY/.test(stripped)) supersededBy.push(...refsIn(line, dir));
    else if (/\bsupersedes\b/i.test(line)) supersedes.push(...refsIn(line, dir));
  }
  if (Array.isArray(front.supersedes)) supersedes.push(...front.supersedes.flatMap((s) => refsIn(String(s), dir)));

  const nameNum = /^(?:adr[-_]?)?0*(\d+)[-_.]/i.exec(basename(path)) ?? /^#\s+(?:ADR[-\s_]*)?0*(\d+)[.:)\s-]/i.exec(heading ?? '');
  const status = supersededBy.length ? 'superseded' : normalizeStatus(statusText);
  return [nodeFact('adr', path, {
    name: title || path,
    path,
    attrs: {
      title: title || path,
      status,
      date: date ?? null,
      number: nameNum ? Number(nameNum[1]) : null,
      supersedes: uniqSorted(supersedes),
      superseded_by: uniqSorted(supersededBy),
      decision: summarize(lines) ?? null,
      mentioned_paths: mentionedPaths(body, path),
    },
  }, P(path, 1, 'medium', 'inference'))];
}
