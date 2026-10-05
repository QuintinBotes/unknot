// Per-file extraction: tokenizes, runs the structural and framework passes, and turns the
// result into graph facts. Pure and deterministic: the same text always yields the same facts.

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { EXTRACTOR, isPackageJson, isTsConfig, packageFacts, tsconfigFacts } from './config.mjs';
import { conventionRoutes, detectFrameworks } from './frameworks.mjs';
import { analyze } from './structure.mjs';
import { tokenize } from './tokenizer.mjs';
import { findUnreachable } from './unreachable.mjs';
import { buildMatch } from './tokutil.mjs';

const CODE_FILE_RE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/;
const TS_RE = /\.(?:ts|mts|cts|tsx)$/;
const NO_JSX_RE = /\.(?:ts|mts|cts)$/;
const MAX_FACTS = 5000;
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/|(?:^|\/)tests?\/)/;

export const isTestPath = (p) => TEST_FILE_RE.test(p);

export function extractFile(file, text, _ctx) {
  const path = file.path;
  if (isPackageJson(path)) return packageFacts(path, text);
  if (isTsConfig(path)) return tsconfigFacts(path, text);
  if (/(?:^|\/)\+page\.svelte$/.test(path)) return svelteFacts(path, text);
  if (!CODE_FILE_RE.test(path)) return [];
  return codeFacts(file, text);
}

function mk(path, degraded) {
  return (line, confidence = 'high', source_type = 'ast') => prov({
    source_type, source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence: degraded ? 'low' : confidence,
  });
}

function countLines(text) {
  let n = 1;
  for (let k = text.indexOf('\n'); k !== -1; k = text.indexOf('\n', k + 1)) n++;
  return n;
}

function svelteFacts(path, text) {
  const p = mk(path, false);
  const rt = conventionRoutes(path, [], []).routes[0];
  const loc = countLines(text);
  const sloc = text.split('\n').filter((l) => l.trim() !== '').length;
  const facts = [nodeFact('module', path, {
    name: path, path,
    attrs: { language: 'svelte', loc, sloc, is_test: false, exports: [], env_reads: [], sql: [], security_signals: [], parse_quality: 'ok', imports: [] },
  }, p(1))];
  if (rt) {
    facts.push(nodeFact('route', rt.path, { name: rt.path, path, attrs: { path: rt.path, framework: rt.framework, file: path, line: 1, module: true } }, p(1, 'medium')));
    facts.push(edgeFact('RENDERS', `route:${rt.path}`, `module:${path}`, { framework: rt.framework }, p(1, 'medium')));
  }
  return facts;
}

function codeFacts(file, text) {
  const path = file.path;
  const ts = TS_RE.test(path);
  const tk = tokenize(text, { jsx: !NO_JSX_RE.test(path), ts });
  const { tokens, n } = tk;
  // How often each identifier occurs in the file. A function whose name occurs more than
  // once is used somewhere — called, passed by reference (`map(lineTotal)`), exported in a
  // list — even when no call edge resolves (golden-suite gap 1).
  const nameCount = new Map();
  for (let i = 0; i < n; i++) if (tokens[i].t === 'id') nameCount.set(tokens[i].v, (nameCount.get(tokens[i].v) ?? 0) + 1);
  const { match, bad } = buildMatch(tokens, n);
  let analysis;
  let failed = false;
  try {
    analysis = analyze(tokens, n, match, { ts });
  } catch {
    // The walk is defensive, but a bug here must degrade one file, not the whole map.
    failed = true;
    analysis = {
      functions: [], classes: [], interfaces: [], types: [], imports: [], exports: [], calls: [],
      envReads: new Set(), sql: [], directives: [],
    };
  }
  let unreachable = new Map();
  if (!failed) {
    try {
      unreachable = findUnreachable(tokens, n, match, analysis.functions);
    } catch {
      // Optional signal: a failure here only costs the unreachable-code attribute.
    }
  }
  analysis.functions.sort((a, b) => a.start_line - b.start_line || (a.qname < b.qname ? -1 : a.qname > b.qname ? 1 : 0));
  const degraded = tk.issues.length > 0 || bad > 0 || failed;
  const p = mk(path, degraded);

  let fw = { endpoints: [], routes: [], messaging: [], stores: [], security: [], reqMethods: [] };
  try {
    if (!failed) fw = detectFrameworks({ path, tokens, n, match, analysis });
  } catch {
    // Heuristic detectors are optional; their failure only costs framework facts.
  }
  const conv = conventionRoutes(path, analysis.exports.map((e) => e.name), fw.reqMethods);

  const facts = [];
  const ids = new Set();
  const node = (type, key, spec, prv) => {
    const id = `${type}:${key}`;
    if (ids.has(id)) return id;
    ids.add(id);
    facts.push(nodeFact(type, key, spec, prv));
    return id;
  };
  const modId = `module:${path}`;

  const classByQ = new Map();
  const fnByQ = new Map();

  for (const c of analysis.classes) {
    const id = node('class', `${path}#${c.qname}`, {
      name: c.qname, path,
      attrs: {
        start_line: c.start_line, end_line: c.end_line, lines: c.lines, extends: c.extends, implements: c.implements,
        decorators: c.decorators.map((d) => d.name), abstract: c.abstract, exported: c.exported, methods: c.methods.length,
      },
    }, p(c.start_line));
    classByQ.set(c.qname, id);
  }
  for (const f of analysis.functions) {
    const id = node(f.type, `${path}#${f.qname}`, {
      name: f.qname, path,
      attrs: {
        start_line: f.start_line, end_line: f.end_line, lines: f.lines, params: f.params, param_names: f.param_names,
        cyclomatic: f.cyclomatic, cognitive: f.cognitive, max_nesting: f.max_nesting, exported: f.exported, async: f.async,
        kind: f.kind, returns: f.returns, return_type: f.return_type, calls: f.calls, class: f.cls,
        decorators: f.decorators.map((d) => d.name), visibility: f.visibility ?? null,
        unreachable: unreachable.get(f) ?? [],
        name_occurrences: nameCount.get(f.qname.split('.').pop()) ?? 0,
      },
    }, p(f.start_line));
    fnByQ.set(f.qname, id);
  }
  for (const f of analysis.functions) {
    const parent = (f.cls && classByQ.get(f.cls)) || (f.parent && (fnByQ.get(f.parent) ?? classByQ.get(f.parent))) || modId;
    facts.push(edgeFact('CONTAINS', parent, `${f.type}:${path}#${f.qname}`, {}, p(f.start_line)));
  }
  for (const c of analysis.classes) {
    const parent = (c.parent && (fnByQ.get(c.parent) ?? classByQ.get(c.parent))) || modId;
    facts.push(edgeFact('CONTAINS', parent, `class:${path}#${c.qname}`, {}, p(c.start_line)));
  }
  for (const i of analysis.interfaces) {
    node('interface', `${path}#${i.qname}`, { name: i.qname, path, attrs: { start_line: i.start_line, end_line: i.end_line, lines: i.lines, exported: i.exported } }, p(i.start_line));
    facts.push(edgeFact('CONTAINS', modId, `interface:${path}#${i.qname}`, {}, p(i.start_line)));
  }
  for (const t of analysis.types) {
    node('type', `${path}#${t.qname}`, { name: t.qname, path, attrs: { start_line: t.start_line, end_line: t.end_line, exported: t.exported } }, p(t.start_line));
    facts.push(edgeFact('CONTAINS', modId, `type:${path}#${t.qname}`, {}, p(t.start_line)));
  }

  // Frameworks. Endpoint and route facts are heuristic, so confidence is medium.
  const endpoints = [...fw.endpoints, ...conv.endpoints];
  for (const e of endpoints) {
    const key = `${e.method} ${e.path}`;
    const attrs = { method: e.method, path: e.path, framework: e.framework, file: path };
    if (e.handler) attrs.handler = e.handler;
    if (e.controller) attrs.controller = e.controller;
    if (e.methods && e.methods.length) attrs.methods = e.methods;
    const id = node('endpoint', key, { name: key, path, attrs }, p(e.line, 'medium'));
    facts.push(edgeFact('EXPOSES', modId, id, { framework: e.framework }, p(e.line, 'medium')));
  }
  // A layout route and its index route share a URL, so routes group by path and keep every component.
  const routeGroups = new Map();
  for (const r of [...fw.routes, ...conv.routes]) {
    if (!routeGroups.has(r.path)) routeGroups.set(r.path, []);
    routeGroups.get(r.path).push(r);
  }
  for (const [rpath, group] of routeGroups) {
    const first = group[0];
    const components = [];
    for (const r of group) {
      if (!r.component && !r.importSpec) continue;
      if (!components.some((c) => c.name === (r.component ?? null) && c.import_spec === (r.importSpec ?? null))) {
        components.push({ name: r.component ?? null, import_spec: r.importSpec ?? null, layout: !!r.layout });
      }
    }
    const leaf = components.find((c) => !c.layout) ?? components[0];
    const attrs = { path: rpath, framework: first.framework, file: path, line: first.line };
    if (leaf?.name) attrs.component = leaf.name;
    if (leaf?.import_spec) attrs.import_spec = leaf.import_spec;
    if (components.length) attrs.components = components;
    if (first.module) attrs.module = true;
    const id = node('route', rpath, { name: rpath, path, attrs }, p(first.line, 'medium'));
    if (first.module) facts.push(edgeFact('RENDERS', id, modId, { framework: first.framework }, p(first.line, 'medium')));
  }
  for (const m of fw.messaging) {
    const id = node(m.kind, m.name, { name: m.name, path, attrs: { name: m.name, library: m.lib } }, p(m.line, 'medium', 'inference'));
    facts.push(edgeFact(m.dir, modId, id, { library: m.lib }, p(m.line, 'medium', 'inference')));
  }
  for (const s of fw.stores) {
    const id = node('store', `${path}#${s.name}`, { name: s.name, path, attrs: { kind: s.kind, binding: s.binding, line: s.line } }, p(s.line, 'medium'));
    facts.push(edgeFact('CONTAINS', modId, id, {}, p(s.line, 'medium')));
  }

  let truncated = false;
  if (facts.length > MAX_FACTS) {
    facts.length = MAX_FACTS;
    truncated = true;
  }

  const attrs = {
    language: ts ? 'typescript' : 'javascript',
    loc: tk.loc,
    sloc: tk.sloc,
    is_test: file.kind === 'test' || isTestPath(path),
    exports: analysis.exports.map((e) => ({ name: e.name, kind: e.kind, line: e.line, local: e.local, ...(e.from ? { from: e.from } : {}) })),
    env_reads: [...analysis.envReads].sort(),
    sql: [...analysis.sql, ...[]].slice(0, 100).map((s) => ({ text: s.text, line: s.line })),
    security_signals: fw.security,
    parse_quality: degraded ? 'degraded' : 'ok',
    imports: analysis.imports,
    calls: analysis.calls,
    directives: analysis.directives,
  };
  if (degraded) attrs.parse_issues = tk.issues.concat(bad ? [`bracket mismatches: ${bad}`] : [], failed ? ['structure pass failed'] : []).slice(0, 10);
  if (truncated) attrs.truncated = true;
  return [nodeFact('module', path, { name: path, path, attrs }, p(1)), ...facts];
}
