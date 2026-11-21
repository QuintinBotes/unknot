// Generic multi-language discovery adapter: honest, lexical structure for Go, Java,
// Kotlin, C#, Rust, Ruby, PHP, Scala, Swift, C and C++ without real parsers. It strips
// comments and strings, matches braces (or def/end for Ruby), and recovers packages,
// imports, types, functions with size/complexity metrics, a few framework conventions
// (HTTP routes, ORM tables, raw SQL, risky calls) and build manifests. Declarations and
// imports are medium confidence, per-function metrics and ORM guesses are low, and every
// module says `parse_quality: 'lexical'`. Nothing here opens files or runs code.

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { analysesFor, genericGlobs, language, languageForPath } from '../../../runtime/graph/languages.mjs';
import { lex } from './lexer.mjs';
import { analyze } from './structure.mjs';
import { frameworkInfo, normPath } from './frameworks.mjs';
import { ormAccess, tableFacts } from '../orm-maps.mjs';
import { clientFacts, routeGroupAttrs, routeGroups, serverInterfaces } from '../http-ops.mjs';
import { csharpLinker, csharpRefs, friendAssemblies } from './csharp.mjs';
import { buildGraph } from './build-graph.mjs';
import { MEMBER_SYNTAX, FAMILY } from './member-syntax.mjs';
import { declaredEdge, dropMemberAttrs, memberAttrs, memberReach, memberRefs, memberTypes, withSemantic } from './members.mjs';
import { basename, dirname, manifestFacts, manifestKind, resolvePath } from './manifests.mjs';
import { resolveFlatSiblingImport } from './imports.mjs';

const VERSION = '0.1.19';
const EXTRACTOR = `generic@${VERSION}`;
const MAX_FACTS = 5000;
const genericSyntax = (lang) => language(lang)?.genericSyntax ?? {};
const prov_ = (path, line, confidence = 'medium', source_type = 'ast') =>
  prov({ source_type, source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });
/** An edge found by matching names is inferred, unless the index links the two files (#77). */
const byName = (sem, e, path, confidence = 'medium') => (e.semantic || sem?.linked?.has(e.to) ? prov_(path, e.line, 'high', 'lsp') : prov_(path, e.line, confidence, 'inference'));

/** Language from the registry; a header is C++ when it plainly uses C++ constructs. */
export function languageOf(path, text = '') {
  const row = languageForPath(path);
  if (!row?.generic) return null;
  const header = row.header;
  if (header?.extensions.some((ext) => path.toLowerCase().endsWith(ext)) && /\b(?:class|namespace|template\s*<|public:|private:)|::/.test(text.slice(0, 20000))) return header.language;
  return row.id;
}

/** Language test conventions (spec: `_test.go`, `*Test.java`, `*Tests.cs`, Rust `tests/`, `_spec.rb`, `*Test.php`...). */
export function isTestPath(path, lang) {
  return language(lang)?.testPathPatterns?.some((pattern) => pattern.test(path)) ?? false;
}

/** Inheritance edge type from how the base was declared and what it turned out to be. */
function inheritEdge(srcKind, listKind, tgtKind) {
  if (listKind === 'extends') return 'EXTENDS';
  if (listKind === 'implements') return 'IMPLEMENTS';
  return tgtKind === 'interface' && srcKind === 'class' ? 'IMPLEMENTS' : 'EXTENDS';
}

const CALL_SKIP = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'sizeof', 'typeof', 'new', 'using', 'lock',
  'when', 'match', 'fn', 'func', 'function', 'def', 'fun', 'super', 'this', 'throw', 'await', 'defer', 'select', 'unless', 'until', 'elsif']);

/** Same-file call targets by simple name; ambiguity (several same-named functions) means no edge. */
function callTargets(f, byName, callSkip) {
  const out = new Set();
  const body = f.body;
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (callSkip.has(name) || !byName.has(name)) continue;
    const before = body.slice(Math.max(0, m.index - 7), m.index);
    const prev = body[m.index - 1];
    if (prev === '.' && !/(?:this|self)\.$/.test(before)) continue;
    if (prev === '>' && !/\$this->$/.test(before)) continue;
    if (prev === ':' && !/(?:self|Self|static)::$/.test(before)) continue;
    const cands = byName.get(name);
    const same = cands.filter((c) => c.owner === f.owner);
    const pick = same.length === 1 ? same[0] : cands.length === 1 ? cands[0] : null;
    if (pick && pick !== f) out.add(pick);
  }
  return out;
}

/**
 * 0-based line indexes inside `#[cfg(test)] mod name { ... }` blocks (comments
 * and string contents are already blanked by the lexer, so braces can be counted plainly).
 */
function cfgTestLines(code) {
  const lines = new Set();
  const re = /#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
    }
    const first = code.slice(0, m.index).split('\n').length - 1;
    const last = code.slice(0, i).split('\n').length - 1;
    for (let l = first; l <= last; l++) lines.add(l);
    re.lastIndex = i;
  }
  return lines;
}

function extract(file, text, ctx) {
  void ctx;
  const path = file.path;
  if (manifestKind(path)) return manifestFacts(path, text, (line) => prov_(path, line));
  const lang = languageOf(path, text);
  if (!lang) return [];
  const lx = lex(text, lang);
  const an = analyze(lx, lang);
  const fw = frameworkInfo(lx, an, lang, path);
  const syntax = genericSyntax(lang);

  const modId = `module:${path}`;
  const facts = [];
  const ids = new Map();
  const taken = new Set();
  const key = (type, base, line) => {
    let k = base;
    if (taken.has(`${type}:${k}`)) k = `${base}~${line}`;
    taken.add(`${type}:${k}`);
    return k;
  };
  const lines = lx.lineStarts.length - (text.endsWith('\n') ? 1 : 0);
  const codeLines = lx.code.split('\n');
  const testRange = syntax.testBlocks ? cfgTestLines(lx.code) : new Set();
  const sloc = codeLines.filter((l, i) => /\S/.test(l) && !testRange.has(i)).length;
  const testSloc = codeLines.filter((l, i) => /\S/.test(l) && testRange.has(i)).length;
  const typeNames = [...new Set(an.types.map((t) => t.name))].sort();
  const methodCounts = new Map();
  for (const f of an.funcs) if (f.owner) methodCounts.set(f.owner, (methodCounts.get(f.owner) ?? 0) + 1);

  const attrs = {
    language: lang,
    loc: lines,
    sloc,
    ...(syntax.testBlocks && { test_sloc: testSloc }),
    is_test: isTestPath(path, lang) || file.kind === 'test',
    imports: an.imports,
    package: an.pkg,
    namespace: an.namespaces[0] ?? null,
    namespaces: [...new Set(an.namespaces)],
    types: typeNames,
    parse_quality: 'lexical',
    analyses: [...analysesFor(lang)],
  };
  if (an.impls.length) attrs.impls = an.impls;
  // Link-only inputs for type resolution and unused members; link() removes them so they are never persisted.
  if (MEMBER_SYNTAX[lang]) {
    const refs = syntax.memberLinker === 'namespace' ? csharpRefs(lx, an) : memberRefs(lx, memberTypes(an.types), MEMBER_SYNTAX[lang]);
    Object.assign(attrs, memberAttrs(refs));
  }
  if (syntax.memberLinker === 'namespace') {
    const friends = friendAssemblies(lx);
    if (friends.length) attrs.internals_visible_to = friends;
  }
  Object.assign(attrs, fw.routeLinks, fw.ormLinks);
  if (fw.sql.length) attrs.sql = fw.sql;
  if (fw.signals.length) attrs.security_signals = fw.signals;
  const mod = nodeFact('module', path, { name: path, path, attrs }, prov_(path, 1));

  const body = [];
  const typeNodes = [];
  for (const t of an.types) {
    const k = key(t.kind, `${path}#${t.name}`, t.startLine);
    const id = `${t.kind}:${k}`;
    ids.set(t, id);
    typeNodes.push({ t, id });
    body.push(nodeFact(t.kind, k, {
      name: t.name,
      path,
      attrs: {
        language: lang, type_kind: t.typeKind, start_line: t.startLine, end_line: t.endLine, lines: t.endLine - t.startLine + 1,
        exported: t.exported, extends: t.extends, implements: t.implements, bases: t.bases, methods: methodCounts.get(t.name) ?? 0,
        ...(t.methodSet && { method_set: t.methodSet }),
        ...(t.partial && { partial: true }),
        ...(t.embeds?.length && { embeds: t.embeds }),
      },
    }, prov_(path, t.startLine)));
    body.push(edgeFact('CONTAINS', modId, id, {}, prov_(path, t.startLine)));
  }
  const funcNodes = [];
  for (const f of an.funcs) {
    const type = f.owner ? 'method' : 'function';
    const k = key(type, `${path}#${f.owner ? `${f.owner}.` : ''}${f.name}`, f.startLine);
    const id = `${type}:${k}`;
    ids.set(f, id);
    funcNodes.push({ f, id });
    const lineCount = f.endLine - f.startLine + 1;
    // Metrics are lexical approximations, so the whole node carries low confidence.
    body.push(nodeFact(type, k, {
      name: f.name,
      path,
      attrs: {
        language: lang, start_line: f.startLine, end_line: f.endLine, lines: lineCount, params: f.params,
        cyclomatic: f.cyclomatic, max_nesting: f.maxNesting, exported: f.exported, owner: f.owner ?? null,
      },
    }, prov_(path, f.startLine, 'low')));
    const container = f.owner ? typeNodes.find((x) => x.t.name === f.owner) : null;
    body.push(edgeFact('CONTAINS', container ? container.id : modId, id, {}, prov_(path, f.startLine)));
  }

  const byName = new Map();
  for (const f of an.funcs) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(f);
  }
  const callSeen = new Set();
  const callSkip = new Set([...CALL_SKIP, ...(syntax.callKeywords ?? [])]);
  for (const { f, id } of funcNodes) {
    for (const target of callTargets(f, byName, callSkip)) {
      const k = `${id}|${ids.get(target)}`;
      if (callSeen.has(k)) continue;
      callSeen.add(k);
      body.push(edgeFact('CALLS', id, ids.get(target), { by: 'name' }, prov_(path, f.startLine, 'low')));
    }
  }

  for (const { t, id } of typeNodes) {
    for (const [list, kind] of [[t.extends, 'extends'], [t.implements, 'implements'], [t.bases, 'bases']]) {
      for (const name of list) {
        const target = typeNodes.find((x) => x.t.name === name && x.t !== t);
        if (target) body.push(edgeFact(inheritEdge(t.kind, kind, target.t.kind), id, target.id, { by: 'name' }, prov_(path, t.startLine, 'low')));
      }
    }
  }

  const seenEndpoint = new Set();
  for (const e of fw.endpoints) {
    const eid = `${e.method} ${e.path}`;
    if (!seenEndpoint.has(eid)) {
      seenEndpoint.add(eid);
      body.push(nodeFact('endpoint', eid, { name: eid, attrs: { method: e.method, path: e.path, framework: e.framework, ...routeGroupAttrs(e.group) } }, prov_(path, e.line, 'medium', 'inference')));
    }
    body.push(edgeFact('EXPOSES', (e.handler && ids.get(e.handler)) || modId, `endpoint:${eid}`, { framework: e.framework }, prov_(path, e.line, 'medium', 'inference')));
  }
  // A client interface is a contract the module declares: one `contract` per interface holding
  // its operations, one per distinct route, and the module consumes each route.
  for (const c of fw.clients) {
    const cid = key('contract', `${path}#${c.type.name}`, c.type.startLine);
    body.push(...clientFacts({
      modId, cid, name: c.type.name, path, line: c.type.startLine, interfaceId: ids.get(c.type), lang, framework: c.framework, ops: c.ops,
      pv: (line) => prov_(path, line, 'medium', 'inference'),
    }));
  }
  for (const t of fw.tables) {
    const pv = prov_(path, t.line, t.confidence, 'inference');
    // A fluent mapping names an entity whose file may differ from this one: link() adds that owner.
    if (t.entity) (attrs.ef_tables ??= []).push({ entity: t.entity, table: t.name, line: t.line });
    body.push(...tableFacts(t, { key: t.name, spec: { name: t.name, attrs: { orm: t.orm, ...(t.model && { model: t.model }) } }, from: t.entity ? null : modId, edgeAttrs: { orm: t.orm }, pv }));
  }

  if (body.length + 1 > MAX_FACTS) {
    mod.attrs.truncated = { facts: body.length + 1, kept: MAX_FACTS };
    return [mod, ...body.slice(0, MAX_FACTS - 1)];
  }
  facts.push(mod, ...body);
  return facts;
}

// ---------------------------------------------------------------------------------------
// link

const JVM_SKIP = /^(?:java|javax|jdk|sun|kotlin|scala)\./;

function rustModuleDir(path) {
  const b = basename(path);
  return b === 'mod.rs' || b === 'lib.rs' || b === 'main.rs' ? dirname(path) : `${dirname(path)}/${b.replace(/\.rs$/, '')}`.replace(/^\//, '');
}

// shortcut: an interface more types satisfy (`Close()`, `String()`) gets edges from this many, in id order, each with the full count; raise it if a consumer needs them all.
const MAX_STRUCTURAL = 25;

/**
 * A type implements an interface by having its methods, in languages that say so
 * (`structuralInterfaces`): same names and parameter counts, an unexported name only from the
 * interface's own directory. Embedded interfaces add their methods; one that does not resolve to
 * exactly one interface leaves the method set unknown, and an unknown set implies nothing. A
 * type's methods include those of the repository's types it embeds, which the language promotes;
 * an embedded type from elsewhere adds none, since its methods are not visible here.
 */
function structuralImplements(types, receivers, qualified) {
  const all = [...types.values()].flat().filter((t) => genericSyntax(t.attrs.language).structuralInterfaces).sort((a, b) => (a.id < b.id ? -1 : 1));
  // The one type of `type` an embedded name means: in the embedder's directory or a package it
  // dot-imports, or, qualified, in the package that qualifier names in the embedder's file.
  const embedded = (from, e, type) => {
    const i = e.lastIndexOf('.');
    const [q, n] = i < 0 ? [null, e] : [e.slice(0, i), e.slice(i + 1)];
    const under = (k, x) => qualified.get(from.path)?.get(k)?.has(x.path);
    const c = (types.get(n) ?? []).filter((x) => x.type === type && (q ? under(q, x) : dirname(x.path) === dirname(from.path) || under('', x)));
    return c.length === 1 ? c[0] : null;
  };
  const methodSet = (iface, seen = new Set()) => {
    if (!iface.attrs.method_set || seen.has(iface.id)) return null;
    seen.add(iface.id);
    const set = iface.attrs.method_set.map((m) => ({ ...m, dir: dirname(iface.path) }));
    for (const e of iface.attrs.embeds ?? []) {
      const c = embedded(iface, e, 'interface');
      const sub = c ? methodSet(c, seen) : null;
      if (!sub) return null;
      set.push(...sub);
    }
    seen.delete(iface.id); // `seen` is the embedding path: two embeds sharing an interface is no cycle
    return set;
  };
  const methodsOf = (t, seen = new Set()) => {
    const ms = new Map(receivers.get(`${dirname(t.path)}|${t.name}`) ?? []);
    seen.add(t.id);
    for (const e of t.attrs.embeds ?? []) {
      const s = embedded(t, e, 'class');
      const i = s ? null : embedded(t, e, 'interface');
      const promoted = s ? (seen.has(s.id) ? new Map() : methodsOf(s, seen)) : new Map(((i && methodSet(i)) ?? []).map((m) => [m.name, m]));
      for (const [k, v] of promoted) if (!ms.has(k)) ms.set(k, v);
    }
    return ms;
  };
  const byMethod = new Map();
  for (const t of all) {
    if (t.type !== 'class') continue;
    const ms = methodsOf(t);
    for (const name of ms.keys()) {
      if (!byMethod.has(name)) byMethod.set(name, []);
      byMethod.get(name).push({ t, ms });
    }
  }
  const out = [];
  for (const iface of all) {
    if (iface.type !== 'interface') continue;
    const set = methodSet(iface);
    if (!set?.length) continue;
    const rarest = set.map((m) => byMethod.get(m.name) ?? []).sort((a, b) => a.length - b.length)[0];
    // An unexported method is the declaring package's own: it matches only one declared there.
    const hits = rarest.filter(({ ms }) => set.every((m) => ms.get(m.name)?.params === m.params && (/^[A-Z]/.test(m.name) || ms.get(m.name).dir === m.dir)));
    const attrs = { by: 'structural', ...(hits.length > MAX_STRUCTURAL && { satisfied_by: hits.length }) };
    for (const { t } of hits.slice(0, MAX_STRUCTURAL)) out.push(edgeFact('IMPLEMENTS', t.id, iface.id, attrs, prov_(t.path, t.attrs.start_line ?? 1, 'low', 'inference')));
  }
  return out;
}

function link(ctx) {
  const mods = new Map();
  const types = new Map();
  const pkgs = [];
  const targets = new Map();
  const factIndex = new Map();
  const receivers = new Map(); // `${dir}|${type}` → method name → { params, dir }, for structural interfaces
  for (const [path, facts] of ctx.factsByFile) {
    for (const f of facts) {
      if (f.kind !== 'node' || f.provenance.extractor !== EXTRACTOR) continue;
      factIndex.set(f.id, f);
      if (f.type === 'method' && f.attrs.owner && genericSyntax(f.attrs.language).structuralInterfaces) {
        const k = `${dirname(path)}|${f.attrs.owner}`;
        if (!receivers.has(k)) receivers.set(k, new Map());
        receivers.get(k).set(f.name, { params: f.attrs.params, dir: dirname(path) });
      }
      if (f.type === 'module') mods.set(path, f);
      else if (f.type === 'class' || f.type === 'interface') {
        if (!types.has(f.name)) types.set(f.name, []);
        types.get(f.name).push(f);
      } else if (f.type === 'package' || f.type === 'workspace') pkgs.push(f);
      else if (f.type === 'build_target') targets.set(f.name, f);
    }
  }
  const out = [];
  const seen = new Set();
  const deps = new Map();
  const push = (fact) => {
    const k = fact.kind === 'node' ? fact.id : `${fact.type}|${fact.from}|${fact.to}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(fact);
  };
  const declared = new Set(pkgs.flatMap((p) => [...(p.attrs.deps ?? []), ...(p.attrs.dev_deps ?? [])]));
  const dependency = (name, path, line) => {
    if (!deps.has(name) && !declared.has(name)) deps.set(name, nodeFact('dependency', name, { name, attrs: {} }, prov_(path, line)));
    return `dependency:${name}`;
  };
  const sortedMods = [...mods.keys()].sort();
  const has = (p) => mods.has(p);
  const modulePaths = new Set(sortedMods);

  // --- indexes ----------------------------------------------------------------------
  const fq = new Map();
  const pkgIndex = new Map();
  const directoryModules = new Map();
  const phpFq = new Map();
  const add = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    if (!m.get(k).includes(v)) m.get(k).push(v);
  };
  for (const path of sortedMods) {
    const a = mods.get(path).attrs;
    if (a.package) {
      add(pkgIndex, a.package, path);
      for (const t of a.types) add(fq, `${a.package}.${t}`, path);
    }
    const conv = genericSyntax(a.language).sourceConvention?.exec(path);
    if (conv) add(fq, conv[1].replace(/\//g, '.'), path);
    for (const ns of a.namespaces ?? []) {
      if (genericSyntax(a.language).namespaceIndex) for (const t of a.types) add(phpFq, `${ns}\\${t}`, path);
    }
    if (genericSyntax(a.language).directoryIndex && !a.is_test) add(directoryModules, dirname(path), path);
  }
  const modulePackages = pkgs.filter((p) => p.attrs.go_module).sort((a, b) => b.attrs.go_module.length - a.attrs.go_module.length);
  const psr4 = pkgs.flatMap((p) => p.attrs.psr4 ?? []).sort((a, b) => b.prefix.length - a.prefix.length);
  const cargo = pkgs.filter((p) => p.attrs.ecosystem === 'cargo' && p.attrs.crate_root !== null && p.attrs.crate_root !== undefined);
  const cmake = pkgs.filter((p) => p.attrs.ecosystem === 'cmake');
  const crateOf = (path) => cargo.filter((c) => !c.attrs.dir || path.startsWith(`${c.attrs.dir}/`)).sort((a, b) => b.attrs.dir.length - a.attrs.dir.length)[0] ?? null;
  const swiftTargets = [...targets.values()].filter((t) => t.attrs.ecosystem === 'swiftpm');

  const crateFind = (base, segs, extension) => {
    for (let k = segs.length; k >= 1; k--) {
      const p = resolvePath(base, segs.slice(0, k).join('/'));
      if (has(`${p}${extension}`)) return `${p}${extension}`;
      if (has(`${p}/mod${extension}`)) return `${p}/mod${extension}`;
    }
    return null;
  };
  const loadPathFind = (spec, extension) => {
    const hits = sortedMods.filter((p) => p === `${spec}${extension}` || p.endsWith(`/${spec}${extension}`));
    const lib = hits.filter((p) => p.includes('lib/'));
    return (lib.length ? lib : hits).slice(0, 1);
  };

  /** @returns {{ paths: string[], via?: string, low?: boolean, external?: string|null, package_level?: boolean }} package_level: the import names a whole package, so every file in it is a target */
  const resolve = (path, a, imp) => {
    const lang = a.language;
    const spec = imp.spec;
    const dir = dirname(path);
    const syntax = genericSyntax(lang);
    switch (syntax.resolver) {
      case 'module_paths': {
        const gm = modulePackages.find((g) => spec === g.attrs.go_module || spec.startsWith(`${g.attrs.go_module}/`));
        if (gm) {
          const sub = spec.slice(gm.attrs.go_module.length + 1);
          return { paths: directoryModules.get(resolvePath(gm.attrs.dir, sub)) ?? [], package_level: true };
        }
        const segs = spec.split('/');
        return { paths: [], external: segs[0].includes('.') ? segs.slice(0, 3).join('/') : null };
      }
      case 'qualified_type': {
        if (/\.[*_]$/.test(spec)) return { paths: (pkgIndex.get(spec.slice(0, -2)) ?? []).slice(0, 50), package_level: true };
        const parts = spec.split('.');
        for (let k = parts.length; k >= 2; k--) {
          const hit = fq.get(parts.slice(0, k).join('.'));
          if (hit) return { paths: hit };
        }
        return { paths: [], external: JVM_SKIP.test(spec) ? null : parts.slice(0, 2).join('.') };
      }
      case 'crate': {
        const extension = language(lang)?.extensions[0] ?? '';
        const crate = crateOf(path);
        const src = crate ? `${crate.attrs.dir ? `${crate.attrs.dir}/` : ''}src` : 'src';
        if (imp.kind === 'mod') {
          const base = rustModuleDir(path);
          const hit = [`${base}/${spec}${extension}`, `${base}/${spec}/mod${extension}`].find(has);
          return { paths: hit ? [hit] : [] };
        }
        const segs = spec.split('::').filter((s) => s && s !== '*');
        const head = segs[0];
        if (head === 'crate') { const h = crateFind(src, segs.slice(1), extension); return { paths: h ? [h] : [] }; }
        if (head === 'self') { const h = crateFind(rustModuleDir(path), segs.slice(1), extension); return { paths: h ? [h] : [] }; }
        if (head === 'super') { const h = crateFind(dirname(rustModuleDir(path)), segs.slice(1), extension); return { paths: h ? [h] : [] }; }
        const other = cargo.find((c) => c.name.replace(/-/g, '_') === head);
        if (other) {
          const h = crateFind(`${other.attrs.dir ? `${other.attrs.dir}/` : ''}src`, segs.slice(1), extension);
          return { paths: h ? [h] : [has(`${other.attrs.dir ? `${other.attrs.dir}/` : ''}src/lib${extension}`) ? `${other.attrs.dir ? `${other.attrs.dir}/` : ''}src/lib${extension}` : null].filter(Boolean) };
        }
        const local = crateFind(src, segs, extension);
        if (local) return { paths: [local] };
        return { paths: [], external: /^(?:std|core|alloc|proc_macro|test)$/.test(head) ? null : head };
      }
      case 'require': {
        const extension = language(lang)?.extensions[0] ?? '';
        if (imp.kind === 'require_relative') {
          const p = resolvePath(dir, spec);
          return { paths: [`${p}${extension}`, p].filter(has).slice(0, 1) };
        }
        const hit = loadPathFind(spec.replace(new RegExp(`${extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''), extension);
        return { paths: hit, external: hit.length || imp.kind === 'load' ? null : spec.split('/')[0] };
      }
      case 'psr4': {
        const extension = language(lang)?.extensions[0] ?? '';
        if (imp.kind !== 'use') {
          const p = [resolvePath(dir, spec), resolvePath('', spec)].find(has);
          return { paths: p ? [p] : [] };
        }
        const pm = psr4.find((e) => spec === e.prefix || spec.startsWith(`${e.prefix}\\`));
        if (pm) {
          const p = `${resolvePath(pm.dir, spec.slice(pm.prefix.length + 1).replace(/\\/g, '/'))}${extension}`;
          if (has(p)) return { paths: [p] };
        }
        if (phpFq.has(spec)) return { paths: phpFq.get(spec) };
        return { paths: [], external: pm ? null : spec.split('\\')[0] };
      }
      case 'targets': {
        const tg = swiftTargets.find((t) => t.name === spec);
        const hit = tg ? sortedMods.filter((p) => mods.get(p).attrs.language === lang && (p.includes(`/${spec}/`) || p.startsWith(`${spec}/`))).slice(0, 200) : [];
        return { paths: hit, external: tg ? null : spec, package_level: true };
      }
      case 'includes': {
        if (imp.kind === 'include_local') {
          const incs = cmake.filter((c) => !c.attrs.dir || path.startsWith(`${c.attrs.dir}/`)).flatMap((c) => c.attrs.include_dirs ?? []);
          const cands = [resolvePath(dir, spec), ...incs.map((d) => resolvePath(d, spec)), resolvePath('include', spec), resolvePath('src', spec), resolvePath('', spec)];
          const hit = cands.find(has);
          if (hit) return { paths: [hit] };
          const tail = sortedMods.filter((p) => p.endsWith(`/${spec}`));
          return { paths: tail.length === 1 ? tail : [], external: tail.length ? null : spec };
        }
        const std = !spec.includes('/') && (!/\./.test(spec) || syntax.systemIncludePattern?.test(spec));
        return { paths: [], external: std ? null : spec.split('/')[0] };
      }
      default: {
        const sibling = resolveFlatSiblingImport(lang, path, spec, modulePaths);
        return sibling ? { paths: [sibling.path], via: sibling.via, low: true } : { paths: [] };
      }
    }
  };

  // --- build graph: which projects each project references (build-graph.mjs) -------------
  const nameIndex = new Map();
  for (const p of pkgs) if (p.type === 'package') add(nameIndex, p.name, p);
  const gradleRoot = (p) => pkgs.filter((w) => w.type === 'workspace' && w.attrs.ecosystem === 'gradle' && (w.attrs.dir === '' || p.attrs.dir === w.attrs.dir || p.attrs.dir.startsWith(`${w.attrs.dir}/`)))
    .sort((a, b) => b.attrs.dir.length - a.attrs.dir.length)[0]?.attrs.dir ?? '';
  /** The packages a package references: by name, by local path, or as a Gradle project. */
  const references = (p) => {
    const others = pkgs.filter((q) => q !== p && q.type === 'package');
    return [
      ...[...(p.attrs.deps ?? []), ...(p.attrs.dev_deps ?? [])].flatMap((name) => (nameIndex.get(name) ?? []).filter((q) => q !== p)),
      // Project files written on Windows may spell a reference's case differently from the tree.
      ...(p.attrs.local_deps ?? []).flatMap((l) => others.filter((q) => q.attrs.dir === l || q.attrs.manifest?.toLowerCase() === l.toLowerCase())),
      ...(p.attrs.gradle_projects ?? []).flatMap((gp) => {
        const dir = resolvePath(gradleRoot(p), gp.replace(/:/g, '/'));
        return others.filter((q) => q.attrs.ecosystem === 'gradle' && q.attrs.dir === dir);
      }),
    ];
  };
  const units = pkgs.filter((p) => p.type === 'package');
  const dependsOn = new Map(units.map((p) => [p, references(p)]));
  const build = buildGraph(units, dependsOn, mods, types);

  // --- members: a type held only through a member nothing reads (members.mjs) --------------
  // C# resolves types through namespaces (csharp.mjs). Java, Kotlin and Go resolve a mentioned
  // type name to a file in the same package or directory, or one the file imports by class name.
  const reachers = new Map();
  const reachFor = (lang) => {
    const fam = FAMILY[lang];
    if (!reachers.has(fam)) {
      const files = sortedMods.filter((p) => FAMILY[mods.get(p).attrs.language] === fam && MEMBER_SYNTAX[mods.get(p).attrs.language]).map((p) => ({ path: p, attrs: mods.get(p).attrs }));
      reachers.set(fam, memberReach(files, new Set(files.flatMap((f) => f.attrs.types ?? [])), (a) => MEMBER_SYNTAX[a.language]?.bare ?? false, genericSyntax(lang).sameDirectoryMembers ? (x, y) => dirname(x) === dirname(y) : undefined, (m) => Boolean(MEMBER_SYNTAX[lang]?.scopePrivate?.test(m))));
    }
    return reachers.get(fam);
  };
  const visibleType = (path, a, c) => {
    if (c.path === path) return false;
    const cm = mods.get(c.path)?.attrs;
    if (!cm || FAMILY[cm.language] !== FAMILY[a.language] || (cm.is_test && !a.is_test)) return false;
    if (genericSyntax(a.language).sameDirectoryMembers) return dirname(c.path) === dirname(path);
    if (!cm.package) return false;
    if (a.package === cm.package) return true;
    return (a.imports ?? []).some((i) => i.kind !== 'static' && (i.spec === `${cm.package}.${c.name}` || i.spec === `${cm.package}.*`));
  };
  /** Per module reached through types: whether every mention of its types in the file is an unused member, and what the file's members say. */
  const typeHits = (path, a, syn) => {
    const hits = new Map();
    for (const ref of a.refs ?? []) {
      if (ref.includes('.')) continue;
      for (const c of types.get(ref) ?? []) {
        if (!visibleType(path, a, c) || !build.allowed(path, c.path, ref)) continue;
        let h = hits.get(c.path);
        if (!h) hits.set(c.path, (h = { spec: ref, decl: true, members: new Set(), pub: new Set(), line: c.attrs.start_line ?? 1 }));
        if (ref in (a.decl_only ?? {})) {
          for (const m of a.decl_only[ref].split(', ')) h.members.add(m);
          for (const m of a.decl_public?.[ref] ?? []) h.pub.add(m);
        } else h.decl = false;
      }
    }
    const reach = reachFor(a.language);
    const owners = a.public_owners ?? {};
    const out = new Map();
    for (const [to, h] of hits) out.set(to, { ...declaredEdge(path, h, owners, reach, syn), spec: h.spec, line: h.line });
    return out;
  };

  // --- imports, tests -----------------------------------------------------------------
  // Every family's member reach is read before the loop below drops each file's member attributes;
  // built lazily, it missed the accesses of every file linked before the first file that needed it.
  for (const p of sortedMods) if (MEMBER_SYNTAX[mods.get(p).attrs.language]) reachFor(mods.get(p).attrs.language);
  const importsOf = new Map();
  // path → qualifier → files of the package it names there: the alias, else the package clause; '' for a dot import.
  const qualified = new Map();
  const csLink = csharpLinker(mods, sortedMods, ctx.semantic, build.allowed);
  for (const path of sortedMods) {
    const mod = mods.get(path);
    const a = mod.attrs;
    const resolved = new Set();
    const sem = ctx.semantic?.get(path) ?? null;
    if (genericSyntax(a.language).memberLinker === 'namespace') {
      const cs = csLink(path);
      for (const e of withSemantic(sem, cs.edges)) {
        resolved.add(e.to);
        // C# links by type name through namespaces: every such edge is name-matched.
        push(edgeFact('IMPORTS', mod.id, mods.get(e.to).id, e.attrs, byName(sem, e, path)));
      }
      for (const c of cs.calls) push(edgeFact('CALLS', mod.id, mods.get(c.to).id, { via: 'member-call', count: c.count }, prov_(path, c.line, c.weak ? 'low' : 'medium', 'inference')));
      for (const imp of cs.externals) {
        const first = imp.spec.split('.');
        const ext = first[0] === 'System' ? null : first[0] === 'Microsoft' ? first.slice(0, 2).join('.') : first[0];
        if (ext) push(edgeFact('IMPORTS', mod.id, dependency(ext, path, imp.line), { spec: imp.spec }, prov_(path, imp.line)));
      }
      dropMemberAttrs(a);
    } else {
      // The edges imports make, then what the member analysis (or the index) says about them.
      const items = [];
      const seenTo = new Set();
      const unplain = new Set(); // targets an import reaches other than by a class name
      for (const imp of a.imports ?? []) {
        const r = resolve(path, a, imp);
        if (r.paths.length && imp.alias !== '_' && genericSyntax(a.language).structuralInterfaces) {
          // Every package clause in the directory names it: a build-ignored `package main` generator does not decide.
          const names = imp.alias === '.' ? [''] : imp.alias ? [imp.alias] : [...new Set(r.paths.map((p) => mods.get(p).attrs.package ?? basename(imp.spec)))];
          if (!qualified.has(path)) qualified.set(path, new Map());
          for (const q of names) qualified.get(path).set(q, new Set([...(qualified.get(path).get(q) ?? []), ...r.paths]));
        }
        for (const p of r.paths) {
          // The type an import names is its first capitalised segment (`y.Helper.CONSTANT` names `Helper`).
          if (p === path || !build.allowed(path, p, imp.spec.split('.').find((s) => /^[A-Z]/.test(s)))) continue;
          resolved.add(p);
          if (r.package_level || imp.kind === 'static' || !/(?:^|\.)[A-Z]\w*$/.test(imp.spec)) unplain.add(p);
          if (seenTo.has(p)) continue;
          seenTo.add(p);
          items.push({ to: p, line: imp.line, attrs: { spec: imp.spec, ...(r.via ? { via: r.via } : {}), ...(r.package_level ? { package_level: true } : {}) }, low: r.low });
        }
        if (!r.paths.length && r.external) {
          items.push({ fact: edgeFact('IMPORTS', mod.id, dependency(r.external, path, imp.line), { spec: imp.spec }, prov_(path, imp.line)) });
        }
      }
      const syn = MEMBER_SYNTAX[a.language];
      if (syn && !sem && (a.refs ?? []).length) {
        // A type of the same package or directory needs no import, yet using it is a dependency.
        for (const [to, h] of typeHits(path, a, syn)) {
          const ex = items.find((i) => i.to === to);
          if (!ex) items.push({ to, line: h.line, attrs: { spec: h.spec, via: 'type', ...(genericSyntax(a.language).packageUnit && dirname(to) === dirname(path) && { intra_package: true }), ...h.attrs } });
          else if (Object.keys(h.attrs).length && !(h.declared && unplain.has(to))) Object.assign(ex.attrs, h.attrs);
        }
      }
      // Emitted in the order the imports gave them; an edge only the index or the member analysis found comes last.
      const mapped = withSemantic(sem, items.filter((i) => i.to));
      let k = 0;
      const emit = (e) => {
        resolved.add(e.to);
        // A type named without an import, or a sibling guessed from a bare name, is name-matched; an import's resolved path is read.
        push(edgeFact('IMPORTS', mod.id, mods.get(e.to).id, e.attrs, e.attrs.via === 'type' || e.low ? byName(sem, e, path, e.low ? 'low' : 'medium') : e.semantic ? prov_(path, e.line, 'high', 'lsp') : prov_(path, e.line)));
      };
      for (const i of items) {
        if (i.fact) push(i.fact);
        else emit(mapped[k++]);
      }
      for (const e of mapped.slice(k)) emit(e);
      dropMemberAttrs(a);
    }
    importsOf.set(path, resolved);
    if (a.is_test) {
      for (const p of [...resolved].sort()) {
        if (!mods.get(p).attrs.is_test) push(edgeFact('TESTS', mod.id, mods.get(p).id, {}, prov_(path, 1)));
      }
    }
  }
  // Same-package tests (Go) and naming-convention tests rarely import their subject.
  const bySubject = new Map();
  const mirror = (p) => dirname(p).replace(/(^|\/)src\/test(\/|$)/, '$1src/main$2');
  for (const path of sortedMods) {
    const a = mods.get(path).attrs;
    if (!a.is_test) add(bySubject, `${mirror(path)}|${basename(path).replace(/\.[^.]+$/, '').toLowerCase()}`, path);
  }
  for (const path of sortedMods) {
    const a = mods.get(path).attrs;
    if (!a.is_test) continue;
    const stem = basename(path).replace(/\.[^.]+$/, '').replace(/(?:_test|_spec|Tests?|Spec|IT)$/, '').toLowerCase();
    const same = bySubject.get(`${mirror(path)}|${stem}`);
    if (same?.length === 1 && same[0] !== path && !importsOf.get(path).has(same[0])) {
      push(edgeFact('TESTS', mods.get(path).id, mods.get(same[0]).id, { by: 'name' }, prov_(path, 1, 'low')));
    }
  }

  // Fluent EF mappings: the table is owned by the file declaring the entity (this file when it is not found).
  for (const path of sortedMods) {
    const m = mods.get(path);
    for (const t of m.attrs.ef_tables ?? []) {
      const own = (types.get(t.entity) ?? []).filter((c) => c.path === path);
      const decl = own.length ? own : (types.get(t.entity) ?? []);
      const owner = decl.length === 1 ? mods.get(decl[0].path).id : m.id;
      push(edgeFact('OWNS_DATA', owner, `table:${t.table}`, { orm: 'efcore' }, prov_(path, t.line, 'medium', 'inference')));
    }
  }

  // --- inheritance across files ------------------------------------------------------
  for (const list of types.values()) {
    for (const t of list) {
      for (const [names, kind] of [[t.attrs.extends, 'extends'], [t.attrs.implements, 'implements'], [t.attrs.bases, 'bases']]) {
        for (const name of names ?? []) {
          // Only an unambiguous name ever linked, so only then is a refusal a rejected edge.
          const all = types.get(name) ?? [];
          const cands = all.filter((c) => (all.length === 1 ? build.allowed : build.visible)(t.path, c.path, name));
          if (cands.some((c) => c.path === t.path) || cands.length !== 1 || cands[0].id === t.id) continue;
          push(edgeFact(inheritEdge(t.type, kind, cands[0].type), t.id, cands[0].id, { by: 'name' }, prov_(t.path, t.attrs.start_line ?? 1, 'low')));
        }
      }
    }
  }
  for (const path of sortedMods) {
    const m = mods.get(path);
    // A qualified name (an assertion's `pkg.T`) is a type of the package that qualifier names in this file.
    const under = (q, c) => !q || qualified.get(path)?.get(q)?.has(c.path);
    for (const im of m.attrs.impls ?? []) {
      const concrete = (types.get(im.type) ?? []).filter((c) => c.type !== 'interface' && under(im.type_qualifier, c));
      const own = concrete.filter((c) => c.path === path);
      const srcs = own.length ? own : concrete;
      const trs = (types.get(im.trait) ?? []).filter((c) => c.type === 'interface' && under(im.trait_qualifier, c));
      const near = trs.filter((c) => c.path === path);
      const tr = near.length ? near : trs;
      if (srcs.length === 1 && tr.length === 1) push(edgeFact('IMPLEMENTS', srcs[0].id, tr[0].id, { by: 'impl' }, prov_(path, im.line, 'low')));
    }
  }
  for (const f of structuralImplements(types, receivers, qualified)) push(f);

  // A partial type declared in several files of one project and namespace is one logical type (#75):
  // a node naming its files and the members of every part. It contains nothing, so each part keeps its
  // module as its only container. Projects are told apart by manifest: two can share a name.
  const partials = new Map();
  const methodsOf = new Map();
  for (const f of factIndex.values()) if (f.type === 'method' && f.attrs.owner) methodsOf.set(f.attrs.owner, [...(methodsOf.get(f.attrs.owner) ?? []), f]);
  const typesIn = new Map();
  for (const t of [...types.values()].flat()) typesIn.set(t.path, [...(typesIn.get(t.path) ?? []), t]);
  for (const t of [...types.values()].flat()) {
    if (!t.attrs.partial) continue;
    const unit = build.ownerOf(t.path);
    // A nested partial type is merged under its containing type: `Order.Builder`, not every `Builder`.
    const outer = (typesIn.get(t.path) ?? []).filter((o) => o !== t && o.attrs.start_line <= t.attrs.start_line && o.attrs.end_line >= t.attrs.end_line)
      .sort((a, b) => a.attrs.start_line - b.attrs.start_line).map((o) => o.name);
    const ns = [mods.get(t.path)?.attrs.namespace, ...outer].filter(Boolean).join('.');
    const k = `${unit?.attrs.manifest ?? ''}|${ns}|${t.name}`;
    if (!partials.has(k)) partials.set(k, { unit, ns, name: t.name, parts: [] });
    partials.get(k).parts.push(t);
  }
  for (const { unit, ns, name, parts } of [...partials.values()].sort((a, b) => (a.parts[0].id < b.parts[0].id ? -1 : 1))) {
    const files = [...new Set(parts.map((t) => t.path))].sort();
    if (files.length < 2) continue;
    const members = [...new Set((methodsOf.get(name) ?? []).filter((f) => files.includes(f.path)).map((f) => f.name))].sort();
    const shared = unit && units.filter((u) => u.name === unit.name).length > 1;
    const key = `${ns ? `${ns}.` : ''}${name}${unit ? `@${shared ? unit.attrs.manifest : unit.name}` : ''}`;
    push(nodeFact(parts[0].type, key, { name, attrs: { language: parts[0].attrs.language, partial: true, files, members } }, prov_(files[0], parts[0].attrs.start_line ?? 1)));
  }

  routeGroups(ctx.factsByFile, 'generic@', normPath);
  for (const f of ormAccess(ctx.factsByFile, 'generic@', (p, line) => prov_(p, line, 'medium', 'inference'))) push(f);
  for (const f of serverInterfaces(ctx.factsByFile, 'generic@', (p, line) => prov_(p, line, 'medium', 'inference'))) push(f);

  // --- packages ---------------------------------------------------------------------
  for (const path of sortedMods) {
    const owner = build.ownerOf(path);
    if (owner) push(edgeFact('CONTAINS', owner.id, mods.get(path).id, {}, prov_(owner.path, 1)));
  }
  for (const p of pkgs) {
    const src = p.path ?? p.attrs.manifest;
    const others = pkgs.filter((q) => q !== p && q.type === 'package');
    for (const m of p.attrs.members ?? []) {
      const glob = m.endsWith('/*') ? m.slice(0, -2) : null;
      for (const q of others) {
        if (glob !== null ? dirname(q.attrs.dir) === glob : q.attrs.dir === m) push(edgeFact('CONTAINS', p.id, q.id, {}, prov_(src, 1)));
      }
    }
    for (const f of p.attrs.member_files ?? []) {
      for (const q of others) if (q.attrs.manifest === f) push(edgeFact('CONTAINS', p.id, q.id, {}, prov_(src, 1)));
    }
    if (p.type !== 'package') continue;
    for (const q of dependsOn.get(p)) push(edgeFact('DEPENDS_ON', p.id, q.id, {}, prov_(src, 1)));
    for (const [tname, libs] of Object.entries(p.attrs.extra_links ?? {})) {
      for (const l of libs) {
        const to = targets.has(l) ? `build_target:${l}` : dependency(l, src, 1);
        push(edgeFact('DEPENDS_ON', `build_target:${tname}`, to, {}, prov_(src, 1)));
      }
    }
  }
  for (const t of [...targets.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const l of t.attrs.links ?? []) {
      if (l !== t.name && targets.has(l) && targets.get(l).path !== t.path) push(edgeFact('DEPENDS_ON', t.id, `build_target:${l}`, {}, prov_(t.path ?? '', 1)));
    }
  }

  // A refused pair another reference linked after all is no rejected edge.
  const rejected = [...build.rejected].reduce((n, [from, tos]) => n + [...tos].filter((to) => !importsOf.get(from)?.has(to)).length, 0);
  if (units.length && ctx.stats) ctx.stats.build_graph = { rejected };
  if (build.unread.length) ctx.notes?.push(`the project references of ${build.unread.length} .NET project(s) could not be read (${build.unread.slice(0, 3).join(', ')}${build.unread.length > 3 ? ', ...' : ''}), so their files link by name as before`);

  for (const name of [...deps.keys()].sort()) out.push(deps.get(name));
  return out;
}

export default {
  id: 'generic',
  version: VERSION,
  kind: 'language',
  capabilities: {
    get files() {
      return [
        ...genericGlobs(),
        '**/go.mod', '**/Cargo.toml', '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/settings.gradle',
        '**/settings.gradle.kts', '**/*.csproj', '**/*.sln', '**/Gemfile', '**/composer.json', '**/Package.swift',
        '**/CMakeLists.txt',
      ];
    },
    executes: [],
    network: false,
  },
  extract,
  link,
};
