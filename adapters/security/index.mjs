// Security adapter (spec §16.1). `extract` finds secret-shaped text with the runtime
// redactor and records only the kind and line, never the value or any text near it.
// `discover` optionally runs local scanners through the broker. Scanners that need the
// network are off unless the user points them at local data, and a missing or forbidden
// tool is recorded, never an error: the map must not fail because a scanner is absent.

import { nodeFact, prov } from '../../runtime/graph/facts.mjs';
import { findSecrets, redact } from '../../runtime/core/redact.mjs';

export const ID = 'security';
export const VERSION = '0.1.0';
const EXTRACTOR = `${ID}@${VERSION}`;
const MAX_BYTES = 1024 * 1024;
const MAX_SECRETS_PER_FILE = 200;
const MAX_SCANNER_PER_FILE = 50;
const TIMEOUT_MS = 120_000;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum|gradle\.lockfile|packages\.lock\.json|[^/]+\.lock)$/;
const SKIP_KINDS = new Set(['binary', 'generated', 'vendored']);

const lineAt = (text, offset) => {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

const toRel = (root, p) => {
  const s = String(p ?? '').replace(/\\/g, '/');
  const r = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return r && s.startsWith(`${r}/`) ? s.slice(r.length + 1) : s.replace(/^\.\//, '');
};

const clip = (s) => redact(String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)).text;

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** gitleaks: rule id, file and line only. Secret and Match fields are never read. */
export function parseGitleaks(text, root) {
  const arr = parseJSON(text);
  if (!Array.isArray(arr)) return [];
  return arr.filter((r) => r && typeof r === 'object' && r.File).map((r) => ({
    file: toRel(root, r.File), tool: 'gitleaks', rule: clip(r.RuleID), severity: 'high', line: Number.isInteger(r.StartLine) ? r.StartLine : null,
  }));
}

export function parseSemgrep(text, root) {
  const doc = parseJSON(text);
  if (!doc || !Array.isArray(doc.results)) return [];
  return doc.results.filter((r) => r?.path).map((r) => ({
    file: toRel(root, r.path),
    tool: 'semgrep',
    rule: clip(r.check_id),
    severity: String(r.extra?.severity ?? 'unrated').toLowerCase(),
    line: Number.isInteger(r.start?.line) ? r.start.line : null,
    message: clip(r.extra?.message),
  }));
}

export function parseOsv(text, root) {
  const doc = parseJSON(text);
  if (!doc || !Array.isArray(doc.results)) return [];
  const out = [];
  for (const res of doc.results) {
    const file = toRel(root, res?.source?.path);
    for (const pkg of res?.packages ?? []) {
      for (const v of pkg?.vulnerabilities ?? []) {
        if (v?.id) out.push({ file, tool: 'osv-scanner', rule: clip(v.id), severity: String(v.database_specific?.severity ?? 'unrated').toLowerCase(), line: null });
      }
    }
  }
  return out.filter((f) => f.file);
}

const outputOf = (r) => (typeof r === 'string' ? r : String(r?.stdout ?? ''));

export default {
  id: ID,
  version: VERSION,
  kind: 'security',
  capabilities: {
    files: ['**/*'],
    executes: ['gitleaks', 'semgrep', 'trivy', 'osv-scanner'],
    network: false,
  },

  /** @param {{path: string, size?: number, kind?: string}} file @param {string} text */
  extract(file, text) {
    if (!file?.path || typeof text !== 'string') return [];
    if (SKIP_KINDS.has(file.kind) || (file.size ?? 0) > MAX_BYTES || text.length > MAX_BYTES || LOCKFILE.test(file.path)) return [];
    const hits = findSecrets(text);
    if (!hits.length) return [];
    // Kind and line only: the offset is used to compute the line and then discarded.
    const secrets = hits.slice(0, MAX_SECRETS_PER_FILE).map((h) => ({ kind: h.kind, line: lineAt(text, h.start) }));
    const attrs = { secrets, ...(hits.length > MAX_SECRETS_PER_FILE ? { truncated: true } : {}) };
    return [nodeFact('file', file.path, { name: file.path, path: file.path, attrs },
      prov({ source_type: 'ast', source_ref: `${file.path}:${secrets[0].line}`, extractor: EXTRACTOR, confidence: 'medium' }))];
  },

  /** Optional external scanners. Never throws for an unavailable tool. */
  async discover(ctx) {
    const root = ctx.root ?? '.';
    const options = ctx.options ?? {};
    const ran = [];
    const unavailable = [];
    const failed = [];
    const skipped = [];
    const findings = [];

    const run = async (tool, argv, parse) => {
      try {
        const r = await ctx.exec(argv, { timeoutMs: TIMEOUT_MS });
        const text = outputOf(r);
        const parsed = parse(text, root);
        // A non-empty, unparsable output is a failed run, not "no findings".
        if (!parsed.length && text.trim() && parseJSON(text) === null) failed.push(tool);
        else {
          ran.push(tool);
          findings.push(...parsed);
        }
      } catch (err) {
        if (err?.code === 'UK_ADAPTER_UNSUPPORTED') unavailable.push(tool);
        else failed.push(tool);
      }
    };

    await run('gitleaks', ['gitleaks', 'detect', '--no-git', '--redact', '--report-format', 'json', '--report-path', '/dev/stdout', '--source', root], parseGitleaks);

    const rules = options.semgrep_config;
    if (typeof rules === 'string' && rules && !rules.startsWith('-')) {
      await run('semgrep', ['semgrep', '--config', rules, '--json', '--metrics=off', root], parseSemgrep);
    } else {
      skipped.push({ tool: 'semgrep', reason: 'needs options.semgrep_config pointing at local rules (--config auto uses the network)' });
    }

    if (options.osv_offline_db) {
      await run('osv-scanner', ['osv-scanner', '--offline', '--json', root], parseOsv);
    } else {
      skipped.push({ tool: 'osv-scanner', reason: 'needs options.osv_offline_db (online mode uses the network)' });
    }
    skipped.push({ tool: 'trivy', reason: 'not run by default (vulnerability database download needs the network)' });

    const facts = [];
    const byFile = new Map();
    for (const f of findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push({ tool: f.tool, rule: f.rule, severity: f.severity, line: f.line, ...(f.message ? { message: f.message } : {}) });
    }
    for (const [path, list] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      list.sort((a, b) => (a.tool + a.rule < b.tool + b.rule ? -1 : 1) || (a.line ?? 0) - (b.line ?? 0));
      facts.push(nodeFact('file', path, { name: path, path, attrs: { scanner_findings: list.slice(0, MAX_SCANNER_PER_FILE), ...(list.length > MAX_SCANNER_PER_FILE ? { scanner_findings_truncated: true } : {}) } },
        prov({ source_type: 'ast', source_ref: `${path}:${list[0].line ?? 1}`, extractor: EXTRACTOR, confidence: 'medium' })));
    }
    facts.push(nodeFact('build_target', 'security-scanners', {
      name: 'security-scanners',
      attrs: { ran: ran.sort(), unavailable: unavailable.sort(), failed: failed.sort(), skipped, finding_count: findings.length },
    }, prov({ source_type: 'config', source_ref: null, extractor: EXTRACTOR, confidence: 'high' })));
    return facts;
  },
};
