// Python packaging manifests: pyproject.toml, setup.cfg, setup.py and requirements*.txt.
// Parsing is deliberately minimal (no TOML library): just enough for package names and
// declared dependencies. Anything unrecognised is skipped, never guessed.

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { normalizeDist } from './stdlib.mjs';

const EXTRACTOR = 'python@0.1.0';
const MAX_DEPS = 500;

export const MANIFEST_RE = /(^|\/)(pyproject\.toml|setup\.cfg|setup\.py|requirements[^/]*\.txt)$/;

export function manifestKind(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === 'pyproject.toml') return 'pyproject';
  if (base === 'setup.cfg') return 'setup.cfg';
  if (base === 'setup.py') return 'setup.py';
  if (/^requirements.*\.txt$/.test(base)) return 'requirements';
  return null;
}

/** `requests[security]>=2.0; python_version<'3.10'` -> { name, spec }. */
export function parseRequirement(line) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;#]*)/.exec(line);
  if (!m) return null;
  return { name: m[1], spec: m[2].trim().replace(/^\(|\)$/g, '') };
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function quotedStrings(text) {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

/** Minimal TOML: tables, `key = value`, and multi-line arrays. Values stay as raw text. */
export function parseToml(text) {
  const tables = new Map();
  let table = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    const t = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (t) { table = t[1].replace(/\s+/g, ''); if (!tables.has(table)) tables.set(table, new Map()); continue; }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2];
    const balance = (s) => (s.match(/[[{]/g) ?? []).length - (s.match(/[\]}]/g) ?? []).length;
    while (balance(value) > 0 && i + 1 < lines.length) value += ` ${stripComment(lines[++i]).trim()}`;
    if (!tables.has(table)) tables.set(table, new Map());
    tables.get(table).set(kv[1].replace(/^["']|["']$/g, ''), value.trim());
  }
  return tables;
}

function parsePyproject(text) {
  const t = parseToml(text);
  const out = { name: null, version: null, deps: [] };
  const project = t.get('project');
  const poetry = t.get('tool.poetry');
  const str = (v) => (v ? quotedStrings(v)[0] ?? null : null);
  out.name = str(project?.get('name')) ?? str(poetry?.get('name'));
  out.version = str(project?.get('version')) ?? str(poetry?.get('version'));
  for (const s of quotedStrings(project?.get('dependencies') ?? '')) {
    const r = parseRequirement(s);
    if (r) out.deps.push({ ...r, group: 'main' });
  }
  for (const [group, v] of t.get('project.optional-dependencies') ?? []) {
    for (const s of quotedStrings(v)) {
      const r = parseRequirement(s);
      if (r) out.deps.push({ ...r, group });
    }
  }
  for (const [name, table] of t) {
    const g = name === 'tool.poetry.dependencies' ? 'main'
      : name === 'tool.poetry.dev-dependencies' ? 'dev'
        : /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(name)?.[1] ?? null;
    if (!g) continue;
    for (const [dep, v] of table) {
      if (dep === 'python') continue;
      const spec = /^\{/.test(v) ? (/version\s*=\s*["']([^"']*)["']/.exec(v)?.[1] ?? '') : str(v) ?? '';
      out.deps.push({ name: dep, spec, group: g });
    }
  }
  return out;
}

function parseSetupCfg(text) {
  const sections = new Map();
  let section = '';
  let key = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*[#;]/.test(raw)) continue;
    const sec = /^\[([^\]]+)\]/.exec(raw);
    if (sec) { section = sec[1].trim(); key = null; if (!sections.has(section)) sections.set(section, new Map()); continue; }
    if (!sections.has(section)) sections.set(section, new Map());
    const kv = /^([A-Za-z_][\w.-]*)\s*[=:]\s*(.*)$/.exec(raw);
    if (kv && !/^\s/.test(raw)) { key = kv[1]; sections.get(section).set(key, kv[2]); } else if (key && /^\s/.test(raw)) {
      sections.get(section).set(key, `${sections.get(section).get(key)}\n${raw.trim()}`);
    }
  }
  const lines = (v) => String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  const out = { name: sections.get('metadata')?.get('name')?.trim() || null, version: sections.get('metadata')?.get('version')?.trim() || null, deps: [] };
  for (const s of lines(sections.get('options')?.get('install_requires'))) {
    const r = parseRequirement(s);
    if (r) out.deps.push({ ...r, group: 'main' });
  }
  for (const [group, v] of sections.get('options.extras_require') ?? []) {
    for (const s of lines(v)) {
      const r = parseRequirement(s);
      if (r) out.deps.push({ ...r, group });
    }
  }
  return out;
}

function parseSetupPy(text) {
  const out = { name: null, version: null, deps: [] };
  const name = /\bname\s*=\s*(['"])([^'"]+)\1/.exec(text);
  if (name) out.name = name[2];
  const req = /install_requires\s*=\s*\[([^\]]*)\]/s.exec(text);
  if (req) {
    for (const s of quotedStrings(req[1])) {
      const r = parseRequirement(s);
      if (r) out.deps.push({ ...r, group: 'main' });
    }
  }
  return out;
}

function parseRequirements(text) {
  const out = { name: null, version: null, deps: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-') || /:\/\/|^git\+|^\.|^\//.test(line)) continue;
    const r = parseRequirement(line);
    if (r) out.deps.push({ ...r, group: 'main' });
  }
  return out;
}

/**
 * Package and dependency facts for one manifest file.
 * @param {string} path repository-relative path
 * @param {string} text file content (data only)
 * @returns {object[]} graph facts
 */
export function manifestFacts(path, text) {
  const kind = manifestKind(path);
  if (!kind) return [];
  const parsed = kind === 'pyproject' ? parsePyproject(text)
    : kind === 'setup.cfg' ? parseSetupCfg(text)
      : kind === 'setup.py' ? parseSetupPy(text)
        : parseRequirements(text);
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
  const key = parsed.name ? normalizeDist(parsed.name) : `python:${dir}`;
  const p = (line) => prov({ source_type: 'config', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence: 'high' });
  const facts = [nodeFact('package', key, {
    name: parsed.name ?? key,
    path,
    attrs: { language: 'python', manifest: path, manifest_kind: kind, version: parsed.version, dir },
  }, p(1))];
  const seen = new Set();
  for (const d of parsed.deps.slice(0, MAX_DEPS)) {
    const dep = normalizeDist(d.name);
    if (seen.has(`${dep}|${d.group}`)) continue;
    seen.add(`${dep}|${d.group}`);
    facts.push(nodeFact('dependency', dep, { name: dep, attrs: { ecosystem: 'pypi' } }, p(1)));
    facts.push(edgeFact('DEPENDS_ON', `package:${key}`, `dependency:${dep}`, { spec: d.spec, group: d.group, manifest: path }, p(1)));
  }
  return facts;
}
