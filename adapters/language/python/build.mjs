// Turns the raw per-file structure (from extract.py or the lexical reader) into graph
// facts. Everything here is a pure function of the raw record, so both parsers share one
// fact shape and differ only in provenance (ast/high versus inference/low).

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { frameworkFacts } from './frameworks.mjs';

export const EXTRACTOR = 'python@0.1.0';
const MAX_FACTS = 5000;

const TEST_RE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$|(^|\/)tests?\//;

export function isTestPath(path) {
  return TEST_RE.test(path);
}

/**
 * @param {string} path repository-relative path
 * @param {object} raw one record from extract.py or lexicalAnalyze
 * @param {string} text source text, for sizes when the parser could not report them
 * @param {'ast'|'lexical'} quality
 * @returns {object[]} graph facts
 */
export function buildFacts(path, raw, text, quality) {
  const hi = quality === 'ast';
  const pv = (line, heuristic = false) => prov({
    source_type: hi && !heuristic ? 'ast' : 'inference',
    source_ref: `${path}:${line || 1}`,
    extractor: EXTRACTOR,
    confidence: hi ? (heuristic ? 'medium' : 'high') : 'low',
  });
  // ORM mappings are observed in syntax but interpreted, so never above medium.
  const pvModel = (line) => prov({
    source_type: hi ? 'ast' : 'inference',
    source_ref: `${path}:${line || 1}`,
    extractor: EXTRACTOR,
    confidence: hi ? 'medium' : 'low',
  });
  const moduleId = `module:${path}`;
  const lines = text.length ? text.split(/\r\n|\r|\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const loc = raw.loc ?? lines.length;
  const sloc = raw.sloc ?? lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  const base = { language: 'python', loc, sloc, is_test: isTestPath(path) };

  if (raw.error) {
    return [nodeFact('module', path, {
      name: path,
      path,
      attrs: { ...base, imports: [], env_reads: [], sql: [], security_signals: [], parse_quality: 'syntax_error', syntax_error: raw.error },
    }, pv(raw.error.line || 1))];
  }

  const facts = [];
  const symbols = new Map();
  for (const c of raw.classes) symbols.set(c.qual, { id: `class:${path}#${c.qual}`, type: 'class', rec: c });
  for (const f of raw.functions) {
    const type = f.in_class && symbols.get(f.parent)?.type === 'class' ? 'method' : 'function';
    if (!symbols.has(f.qual)) symbols.set(f.qual, { id: `${type}:${path}#${f.qual}`, type, rec: f });
  }

  const moduleFact = nodeFact('module', path, {
    name: path,
    path,
    attrs: {
      ...base,
      imports: raw.imports.map((i) => ({
        kind: i.kind, level: i.level, module: i.module, as: i.as ?? null, line: i.line,
        names: i.names.map((n) => ({ name: n.name, as: n.as ?? null })),
      })),
      env_reads: [...new Set(raw.env.map((e) => e.name))].sort(),
      sql: raw.sql,
      security_signals: raw.security,
      parse_quality: quality,
    },
  }, pv(1));
  facts.push(moduleFact);

  const methodCounts = new Map();
  for (const f of raw.functions) {
    if (f.in_class) methodCounts.set(f.parent, (methodCounts.get(f.parent) ?? 0) + 1);
  }

  for (const [qual, sym] of symbols) {
    const r = sym.rec;
    const exported = !r.name.startsWith('_') && (!r.parent || symbols.get(r.parent)?.type === 'class');
    const common = {
      language: 'python', start_line: r.start_line, end_line: r.end_line, lines: r.end_line - r.start_line + 1,
      exported, decorators: (r.decorators ?? []).map((d) => d.name), parse_quality: quality,
    };
    const attrs = sym.type === 'class'
      ? { ...common, kind: 'class', bases: r.bases, methods: methodCounts.get(qual) ?? 0 }
      : {
        ...common, kind: r.kind, params: r.params.length, param_names: r.params, cyclomatic: r.cyclomatic,
        cognitive: r.cognitive, max_nesting: r.max_nesting, async: r.async, returns: r.returns, calls: r.calls,
        class: sym.type === 'method' ? r.parent : null,
      };
    facts.push(nodeFact(sym.type, `${path}#${qual}`, { name: qual, path, attrs }, pv(r.start_line)));
    const parentId = r.parent && symbols.has(r.parent) ? symbols.get(r.parent).id : moduleId;
    facts.push(edgeFact('CONTAINS', parentId, sym.id, {}, pv(r.start_line)));
  }

  const heuristic = (line) => pv(line, true);
  facts.push(...frameworkFacts({ path, raw, moduleId, symbols, pv: heuristic, pvModel }));

  if (facts.length > MAX_FACTS) {
    const dropped = facts.length - MAX_FACTS;
    facts.length = MAX_FACTS;
    moduleFact.attrs.truncated = { dropped, cap: MAX_FACTS };
  }
  return facts;
}
