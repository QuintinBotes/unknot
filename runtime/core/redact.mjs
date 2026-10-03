// Secret detection and redaction (spec §14.9, §16.3, §16.5). Runs on everything the
// runtime is about to hand to a model, write to a log, or store in a proof bundle.
// Detection favours recall for well-known token formats and uses entropy for generic
// `password = ...` assignments so documentation placeholders are left alone.

const RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['aws-access-key-id', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g],
  ['aws-secret-access-key', /(?<=aws_secret_access_key\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g],
  ['stripe-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['azure-storage-key', /(?<=AccountKey=)[A-Za-z0-9+/=]{40,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['url-credentials', /(?<=\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]{1,128}:)(?!(?:password|postgres|secret|changeme|example|test|testing|dev|admin|root|guest|pass|user|mysql|redis|rabbit|local|\$\{?[A-Za-z_]+\}?|<[^>]+>)@)[^\s@'"]{3,256}(?=@)/gi],
];

const ASSIGNMENT =
  /\b(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|token|private[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"'`,;)}\]]{8,})/gi;

const PLACEHOLDER = /^(?:\$\{?|<|%|\{\{|changeme|change_me|example|xxx+|\*+|your[_-]|replace|dummy|test|password|secret|null|none|true|false|undefined|env\.|process\.env)/i;

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * @param {string} text
 * @param {{extraPatterns?: string[]}} [opts] extra regex sources from config `security.redact_patterns`
 * @returns {{kind: string, start: number, end: number}[]} non-overlapping, sorted
 */
export function findSecrets(text, { extraPatterns = [] } = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const [kind, re] of RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ kind, start: m.index, end: m.index + m[0].length });
  }
  ASSIGNMENT.lastIndex = 0;
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[2];
    if (PLACEHOLDER.test(value) || entropy(value) < 3.2) continue;
    // `token = secrets.token_urlsafe(32)` or `password: req.body.password` is code, not a
    // secret: a credential value has no call parentheses, member access chains or templates.
    if (/[()[\]{}$]|^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)+$|^[A-Za-z_]+$/.test(value)) continue;
    const start = m.index + m[0].length - value.length;
    hits.push({ kind: `assigned-${m[1].toLowerCase().replace(/[_-]/g, '')}`, start, end: start + value.length });
  }
  for (const src of extraPatterns) {
    const re = new RegExp(src, 'g');
    for (const m of text.matchAll(re)) if (m[0]) hits.push({ kind: 'custom', start: m.index, end: m.index + m[0].length });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const h of hits) {
    const last = merged.at(-1);
    if (last && h.start < last.end) last.end = Math.max(last.end, h.end);
    else merged.push({ ...h });
  }
  return merged;
}

/** Replace every detected secret with `[REDACTED:<kind>]`. */
export function redact(text, opts) {
  const hits = findSecrets(text, opts);
  if (hits.length === 0) return { text, count: 0, kinds: [] };
  let out = '';
  let pos = 0;
  for (const h of hits) {
    out += text.slice(pos, h.start) + `[REDACTED:${h.kind}]`;
    pos = h.end;
  }
  out += text.slice(pos);
  return { text: out, count: hits.length, kinds: [...new Set(hits.map((h) => h.kind))] };
}

/** Redact every string inside a JSON-like value. */
export function redactDeep(value, opts) {
  if (typeof value === 'string') return redact(value, opts).text;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, opts)]));
  }
  return value;
}
