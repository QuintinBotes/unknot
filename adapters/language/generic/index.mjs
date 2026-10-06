// Generic multi-language discovery adapter: honest, lexical structure for Go, Java,
// Kotlin, C#, Rust, Ruby, PHP, Scala, Swift, C and C++ without real parsers. It strips
// comments and strings, matches braces (or def/end for Ruby), and recovers packages,
// imports, types, functions with size/complexity metrics, a few framework conventions
// (HTTP routes, ORM tables, raw SQL, risky calls) and build manifests. Declarations and
// imports are medium confidence, per-function metrics and ORM guesses are low, and every
// module says `parse_quality: 'lexical'`. Nothing here opens files or runs code.

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { lex } from './lexer.mjs';
import { analyze } from './structure.mjs';
import { frameworkInfo } from './frameworks.mjs';
import { clientFacts } from '../http-ops.mjs';
import { csharpLinker, csharpRefs } from './csharp.mjs';
import { basename, dirname, manifestFacts, manifestKind, resolvePath } from './manifests.mjs';

const VERSION = '0.1.7';
const EXTRACTOR = `generic@${VERSION}`;
const MAX_FACTS = 5000;

const EXT_LANG = {
  go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', cs: 'csharp', rs: 'rust', rb: 'ruby', php: 'php', scala: 'scala',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
};

const ECOSYSTEM_LANGS = {
  go: ['go'], cargo: ['rust'], maven: ['java', 'kotlin', 'scala'], gradle: ['java', 'kotlin', 'scala'], dotnet: ['csharp'],
  bundler: ['ruby'], composer: ['php'], swiftpm: ['swift'], cmake: ['c', 'cpp'],
};

const prov_ = (path, line, confidence = 'medium', source_type = 'ast') =>
  prov({ source_type, source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });

/** Language from the extension; `.h` is C++ when it plainly uses C++ constructs. */
export function languageOf(path, text = '') {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const lang = EXT_LANG[ext];
  if (ext === 'h' && /\b(?:class|namespace|template\s*<|public:|private:)|::/.test(text.slice(0, 20000))) return 'cpp';
  return lang ?? null;
}

/** Language test conventions (spec: `_test.go`, `*Test.java`, `*Tests.cs`, Rust `tests/`, `_spec.rb`, `*Test.php`...). */
export function isTestPath(path, lang) {
  switch (lang) {
    case 'go': return /_test\.go$/.test(path);
    case 'java': case 'kotlin': case 'scala':
      return /(?:^|\/)src\/test\//.test(path) || /(?:Tests?|IT|Spec|Suite)\.(?:java|kt|kts|scala)$/.test(path);
    case 'csharp': return /Tests?\.cs$/.test(path) || /(?:^|\/)[^/]*\.Tests?\//.test(path) || /(?:^|\/)Tests?\//.test(path);
    case 'rust': return /(?:^|\/)tests\//.test(path);
    case 'ruby': return /_(?:spec|test)\.rb$/.test(path) || /(?:^|\/)(?:spec|test)\//.test(path);
    case 'php': return /Test\.php$/.test(path) || /(?:^|\/)tests?\//.test(path);
    case 'swift': return /Tests?\.swift$/.test(path) || /(?:^|\/)Tests\//.test(path);
    case 'c': case 'cpp': return /(?:_tests?|Tests?)\.(?:c|cc|cpp|cxx)$/.test(path) || /(?:^|\/)test_[^/]*\.(?:c|cc|cpp)$/.test(path) || /(?:^|\/)tests?\//.test(path);
    default: return false;
  }
}

/** Inheritance edge type from how the base was declared and what it turned out to be. */
function inheritEdge(srcKind, listKind, tgtKind) {
  if (listKind === 'extends') return 'EXTENDS';
  if (listKind === 'implements') return 'IMPLEMENTS';
  return tgtKind === 'interface' && srcKind === 'class' ? 'IMPLEMENTS' : 'EXTENDS';
}

const CALL_SKIP = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'sizeof', 'typeof', 'new', 'using', 'lock',
  'when', 'match', 'fn', 'func', 'function', 'def', 'fun', 'super', 'this', 'throw', 'await', 'defer', 'go', 'select', 'unless', 'until', 'elsif']);

/** Same-file call targets by simple name; ambiguity (several same-named functions) means no edge. */
function callTargets(f, byName) {
  const out = new Set();
  const body = f.body;
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (CALL_SKIP.has(name) || !byName.has(name)) continue;
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
 * 0-based line indexes inside `#[cfg(test)] mod name { ... }` blocks of Rust code (comments
 * and string contents are already blanked by the lexer, so braces can be counted plainly).
 */
function rustTestLines(code) {
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
  const testRange = lang === 'rust' ? rustTestLines(lx.code) : new Set();
  const sloc = codeLines.filter((l, i) => /\S/.test(l) && !testRange.has(i)).length;
  const testSloc = codeLines.filter((l, i) => /\S/.test(l) && testRange.has(i)).length;
  const typeNames = [...new Set(an.types.map((t) => t.name))].sort();

  const attrs = {
    language: lang,
    loc: lines,
    sloc,
    ...(lang === 'rust' && { test_sloc: testSloc }),
    is_test: isTestPath(path, lang) || file.kind === 'test',
    imports: an.imports,
    package: an.pkg,
    namespace: an.namespaces[0] ?? null,
    namespaces: [...new Set(an.namespaces)],
    types: typeNames,
    parse_quality: 'lexical',
  };
  if (an.impls.length) attrs.impls = an.impls;
  // Link-only inputs for C# type resolution; link() removes them so they are never persisted.
  if (lang === 'csharp') {
    const r = csharpRefs(lx, an);
    attrs.refs = r.refs;
    if (Object.keys(r.declOnly).length) attrs.decl_only = r.declOnly;
    if (Object.keys(r.declPublic).length) attrs.decl_public = r.declPublic;
    if (Object.keys(r.declCands).length) attrs.decl_cands = r.declCands;
    attrs.words = r.words;
    attrs.acc = r.acc;
    attrs.calls = r.calls;
    attrs.type_bases = r.typeBases;
    if (r.publicMembers.length) { attrs.public_members = r.publicMembers; attrs.public_owners = r.publicOwners; }
  }
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
        exported: t.exported, extends: t.extends, implements: t.implements, bases: t.bases,
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
  for (const { f, id } of funcNodes) {
    for (const target of callTargets(f, byName)) {
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
      body.push(nodeFact('endpoint', eid, { name: eid, attrs: { method: e.method, path: e.path, framework: e.framework } }, prov_(path, e.line, 'medium', 'inference')));
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
    const tid =`public.${t.name}`;
    body.push(nodeFact('table', tid, { name: t.name, attrs: { schema: 'public', orm: t.orm } }, prov_(path, t.line, t.confidence, 'inference')));
    // A fluent mapping names an entity whose file may differ from this one: link() adds that owner.
    if (t.entity) (attrs.ef_tables ??= []).push({ entity: t.entity, table: t.name, line: t.line });
    else body.push(edgeFact('OWNS_DATA', modId, `table:${tid}`, { orm: t.orm }, prov_(path, t.line, t.confidence, 'inference')));
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

function link(ctx) {
  const mods = new Map();
  const types = new Map();
  const pkgs = [];
  const targets = new Map();
  const factIndex = new Map();
  for (const [path, facts] of ctx.factsByFile) {
    for (const f of facts) {
      if (f.kind !== 'node' || f.provenance.extractor !== EXTRACTOR) continue;
      factIndex.set(f.id, f);
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

  // --- indexes ----------------------------------------------------------------------
  const fq = new Map();
  const pkgIndex = new Map();
  const dirGo = new Map();
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
    const conv = /(?:^|\/)src\/(?:main|test)\/(?:java|kotlin|scala)\/(.+)\.(?:java|kt|scala)$/.exec(path);
    if (conv) add(fq, conv[1].replace(/\//g, '.'), path);
    for (const ns of a.namespaces ?? []) {
      if (a.language === 'php') for (const t of a.types) add(phpFq, `${ns}\\${t}`, path);
    }
    if (a.language === 'go' && !a.is_test) add(dirGo, dirname(path), path);
  }
  const gomods = pkgs.filter((p) => p.attrs.ecosystem === 'go' && p.attrs.go_module).sort((a, b) => b.attrs.go_module.length - a.attrs.go_module.length);
  const psr4 = pkgs.flatMap((p) => p.attrs.psr4 ?? []).sort((a, b) => b.prefix.length - a.prefix.length);
  const cargo = pkgs.filter((p) => p.attrs.ecosystem === 'cargo' && p.attrs.crate_root !== null && p.attrs.crate_root !== undefined);
  const cmake = pkgs.filter((p) => p.attrs.ecosystem === 'cmake');
  const crateOf = (path) => cargo.filter((c) => !c.attrs.dir || path.startsWith(`${c.attrs.dir}/`)).sort((a, b) => b.attrs.dir.length - a.attrs.dir.length)[0] ?? null;
  const swiftTargets = [...targets.values()].filter((t) => t.attrs.ecosystem === 'swiftpm');

  const rustFind = (base, segs) => {
    for (let k = segs.length; k >= 1; k--) {
      const p = resolvePath(base, segs.slice(0, k).join('/'));
      if (has(`${p}.rs`)) return `${p}.rs`;
      if (has(`${p}/mod.rs`)) return `${p}/mod.rs`;
    }
    return null;
  };
  const rubyFind = (spec) => {
    const hits = sortedMods.filter((p) => p === `${spec}.rb` || p.endsWith(`/${spec}.rb`));
    const lib = hits.filter((p) => p.includes('lib/'));
    return (lib.length ? lib : hits).slice(0, 1);
  };

  /** @returns {{ paths: string[], via?: string, low?: boolean, external?: string|null, package_level?: boolean }} package_level: the import names a whole package, so every file in it is a target */
  const resolve = (path, a, imp) => {
    const lang = a.language;
    const spec = imp.spec;
    const dir = dirname(path);
    switch (lang) {
      case 'go': {
        const gm = gomods.find((g) => spec === g.attrs.go_module || spec.startsWith(`${g.attrs.go_module}/`));
        if (gm) {
          const sub = spec.slice(gm.attrs.go_module.length + 1);
          return { paths: dirGo.get(resolvePath(gm.attrs.dir, sub)) ?? [], package_level: true };
        }
        const segs = spec.split('/');
        return { paths: [], external: segs[0].includes('.') ? segs.slice(0, 3).join('/') : null };
      }
      case 'java': case 'kotlin': case 'scala': {
        if (/\.[*_]$/.test(spec)) return { paths: (pkgIndex.get(spec.slice(0, -2)) ?? []).slice(0, 50), package_level: true };
        const parts = spec.split('.');
        for (let k = parts.length; k >= 2; k--) {
          const hit = fq.get(parts.slice(0, k).join('.'));
          if (hit) return { paths: hit };
        }
        return { paths: [], external: JVM_SKIP.test(spec) ? null : parts.slice(0, 2).join('.') };
      }
      case 'rust': {
        const crate = crateOf(path);
        const src = crate ? `${crate.attrs.dir ? `${crate.attrs.dir}/` : ''}src` : 'src';
        if (imp.kind === 'mod') {
          const base = rustModuleDir(path);
          const hit = [`${base}/${spec}.rs`, `${base}/${spec}/mod.rs`].find(has);
          return { paths: hit ? [hit] : [] };
        }
        const segs = spec.split('::').filter((s) => s && s !== '*');
        const head = segs[0];
        if (head === 'crate') { const h = rustFind(src, segs.slice(1)); return { paths: h ? [h] : [] }; }
        if (head === 'self') { const h = rustFind(rustModuleDir(path), segs.slice(1)); return { paths: h ? [h] : [] }; }
        if (head === 'super') { const h = rustFind(dirname(rustModuleDir(path)), segs.slice(1)); return { paths: h ? [h] : [] }; }
        const other = cargo.find((c) => c.name.replace(/-/g, '_') === head);
        if (other) {
          const h = rustFind(`${other.attrs.dir ? `${other.attrs.dir}/` : ''}src`, segs.slice(1));
          return { paths: h ? [h] : [has(`${other.attrs.dir ? `${other.attrs.dir}/` : ''}src/lib.rs`) ? `${other.attrs.dir ? `${other.attrs.dir}/` : ''}src/lib.rs` : null].filter(Boolean) };
        }
        const local = rustFind(src, segs);
        if (local) return { paths: [local] };
        return { paths: [], external: /^(?:std|core|alloc|proc_macro|test)$/.test(head) ? null : head };
      }
      case 'ruby': {
        if (imp.kind === 'require_relative') {
          const p = resolvePath(dir, spec);
          return { paths: [`${p}.rb`, p].filter(has).slice(0, 1) };
        }
        const hit = rubyFind(spec.replace(/\.rb$/, ''));
        return { paths: hit, external: hit.length || imp.kind === 'load' ? null : spec.split('/')[0] };
      }
      case 'php': {
        if (imp.kind !== 'use') {
          const p = [resolvePath(dir, spec), resolvePath('', spec)].find(has);
          return { paths: p ? [p] : [] };
        }
        const pm = psr4.find((e) => spec === e.prefix || spec.startsWith(`${e.prefix}\\`));
        if (pm) {
          const p = `${resolvePath(pm.dir, spec.slice(pm.prefix.length + 1).replace(/\\/g, '/'))}.php`;
          if (has(p)) return { paths: [p] };
        }
        if (phpFq.has(spec)) return { paths: phpFq.get(spec) };
        return { paths: [], external: pm ? null : spec.split('\\')[0] };
      }
      case 'swift': {
        const tg = swiftTargets.find((t) => t.name === spec);
        const hit = tg ? sortedMods.filter((p) => mods.get(p).attrs.language === 'swift' && (p.includes(`/${spec}/`) || p.startsWith(`${spec}/`))).slice(0, 200) : [];
        return { paths: hit, external: tg ? null : spec, package_level: true };
      }
      case 'c': case 'cpp': {
        if (imp.kind === 'include_local') {
          const incs = cmake.filter((c) => !c.attrs.dir || path.startsWith(`${c.attrs.dir}/`)).flatMap((c) => c.attrs.include_dirs ?? []);
          const cands = [resolvePath(dir, spec), ...incs.map((d) => resolvePath(d, spec)), resolvePath('include', spec), resolvePath('src', spec), resolvePath('', spec)];
          const hit = cands.find(has);
          if (hit) return { paths: [hit] };
          const tail = sortedMods.filter((p) => p.endsWith(`/${spec}`));
          return { paths: tail.length === 1 ? tail : [], external: tail.length ? null : spec };
        }
        const std = !spec.includes('/') && (!/\./.test(spec) || /^(?:std\w+|string|math|time|errno|assert|ctype|limits|signal|stdarg|stddef|unistd|fcntl)\.h$/.test(spec));
        return { paths: [], external: std ? null : spec.split('/')[0] };
      }
      default: return { paths: [] };
    }
  };

  // --- imports, tests -----------------------------------------------------------------
  const importsOf = new Map();
  const csLink = csharpLinker(mods, sortedMods, ctx.semantic);
  for (const path of sortedMods) {
    const mod = mods.get(path);
    const a = mod.attrs;
    const resolved = new Set();
    if (a.language === 'csharp') {
      const cs = csLink(path);
      for (const e of cs.edges) {
        resolved.add(e.to);
        push(edgeFact('IMPORTS', mod.id, mods.get(e.to).id, {
          spec: e.spec, via: 'type', ...(e.declared_only && { declared_only: true, unused_member: e.unused_member, member_visibility: e.member_visibility }),
          ...(e.unused_evidence && { unused_evidence: e.unused_evidence }),
          ...(e.use_evidence && { use_evidence: e.use_evidence, possible_use_of: e.possible_use_of, possible_receivers: e.possible_receivers }),
        }, e.semantic ? prov_(path, e.line, 'high', 'lsp') : prov_(path, e.line)));
      }
      for (const c of cs.calls) push(edgeFact('CALLS', mod.id, mods.get(c.to).id, { via: 'member-call', count: c.count }, prov_(path, c.line, c.weak ? 'low' : 'medium')));
      for (const imp of cs.externals) {
        const first = imp.spec.split('.');
        const ext = first[0] === 'System' ? null : first[0] === 'Microsoft' ? first.slice(0, 2).join('.') : first[0];
        if (ext) push(edgeFact('IMPORTS', mod.id, dependency(ext, path, imp.line), { spec: imp.spec }, prov_(path, imp.line)));
      }
      delete a.refs;
      delete a.decl_only;
      delete a.decl_public;
      delete a.decl_cands;
      delete a.words;
      delete a.acc;
      delete a.calls;
      delete a.type_bases;
      delete a.public_owners;
    }
    for (const imp of a.language === 'csharp' ? [] : a.imports ?? []) {
      const r = resolve(path, a, imp);
      for (const p of r.paths) {
        if (p === path) continue;
        resolved.add(p);
        push(edgeFact('IMPORTS', mod.id, mods.get(p).id, { spec: imp.spec, ...(r.via ? { via: r.via } : {}), ...(r.package_level ? { package_level: true } : {}) }, prov_(path, imp.line, r.low ? 'low' : 'medium')));
      }
      if (!r.paths.length && r.external) {
        push(edgeFact('IMPORTS', mod.id, dependency(r.external, path, imp.line), { spec: imp.spec }, prov_(path, imp.line)));
      }
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
      push(edgeFact('OWNS_DATA', owner, `table:public.${t.table}`, { orm: 'efcore' }, prov_(path, t.line, 'medium', 'inference')));
    }
  }

  // --- inheritance across files ------------------------------------------------------
  for (const list of types.values()) {
    for (const t of list) {
      for (const [names, kind] of [[t.attrs.extends, 'extends'], [t.attrs.implements, 'implements'], [t.attrs.bases, 'bases']]) {
        for (const name of names ?? []) {
          const cands = types.get(name) ?? [];
          if (cands.some((c) => c.path === t.path) || cands.length !== 1 || cands[0].id === t.id) continue;
          push(edgeFact(inheritEdge(t.type, kind, cands[0].type), t.id, cands[0].id, { by: 'name' }, prov_(t.path, t.attrs.start_line ?? 1, 'low')));
        }
      }
    }
  }
  for (const path of sortedMods) {
    const m = mods.get(path);
    for (const im of m.attrs.impls ?? []) {
      const own = (types.get(im.type) ?? []).filter((c) => c.path === path);
      const srcs = own.length ? own : (types.get(im.type) ?? []);
      const trs = (types.get(im.trait) ?? []).filter((c) => c.type === 'interface');
      const near = trs.filter((c) => c.path === path);
      const tr = near.length ? near : trs;
      if (srcs.length === 1 && tr.length === 1) push(edgeFact('IMPLEMENTS', srcs[0].id, tr[0].id, { by: 'impl' }, prov_(path, im.line, 'low')));
    }
  }

  // --- packages ---------------------------------------------------------------------
  const nameIndex = new Map();
  for (const p of pkgs) if (p.type === 'package') add(nameIndex, p.name, p);
  const compat = (p, lang) => (ECOSYSTEM_LANGS[p.attrs.ecosystem] ?? []).includes(lang);
  const byDepth = pkgs.filter((p) => p.type === 'package').sort((a, b) => b.attrs.dir.length - a.attrs.dir.length || a.id.localeCompare(b.id));
  for (const path of sortedMods) {
    const lang = mods.get(path).attrs.language;
    const owner = byDepth.find((p) => compat(p, lang) && (p.attrs.dir === '' || path.startsWith(`${p.attrs.dir}/`)));
    if (owner) push(edgeFact('CONTAINS', owner.id, mods.get(path).id, {}, prov_(owner.path, 1)));
  }
  const gradleRoot = (p) => pkgs.filter((w) => w.type === 'workspace' && w.attrs.ecosystem === 'gradle' && (w.attrs.dir === '' || p.attrs.dir === w.attrs.dir || p.attrs.dir.startsWith(`${w.attrs.dir}/`)))
    .sort((a, b) => b.attrs.dir.length - a.attrs.dir.length)[0]?.attrs.dir ?? '';
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
    for (const name of [...(p.attrs.deps ?? []), ...(p.attrs.dev_deps ?? [])]) {
      for (const q of nameIndex.get(name) ?? []) if (q !== p) push(edgeFact('DEPENDS_ON', p.id, q.id, {}, prov_(src, 1)));
    }
    for (const l of p.attrs.local_deps ?? []) {
      for (const q of others) if (q.attrs.dir === l || q.attrs.manifest === l) push(edgeFact('DEPENDS_ON', p.id, q.id, {}, prov_(src, 1)));
    }
    for (const gp of p.attrs.gradle_projects ?? []) {
      const dir = resolvePath(gradleRoot(p), gp.replace(/:/g, '/'));
      for (const q of others) if (q.attrs.ecosystem === 'gradle' && q.attrs.dir === dir) push(edgeFact('DEPENDS_ON', p.id, q.id, {}, prov_(src, 1)));
    }
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

  for (const name of [...deps.keys()].sort()) out.push(deps.get(name));
  return out;
}

export default {
  id: 'generic',
  version: VERSION,
  kind: 'language',
  capabilities: {
    files: [
      '**/*.go', '**/*.java', '**/*.kt', '**/*.kts', '**/*.cs', '**/*.rs', '**/*.rb', '**/*.php', '**/*.scala', '**/*.swift',
      '**/*.c', '**/*.h', '**/*.cc', '**/*.cpp', '**/*.cxx', '**/*.hpp', '**/*.hh',
      '**/go.mod', '**/Cargo.toml', '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/settings.gradle',
      '**/settings.gradle.kts', '**/*.csproj', '**/*.sln', '**/Gemfile', '**/composer.json', '**/Package.swift',
      '**/CMakeLists.txt',
    ],
    executes: [],
    network: false,
  },
  extract,
  link,
};
