// What a SCIP index says about a repository, computed in two streaming passes so that only
// one document is in memory at a time (plus a table of the symbols the repository defines):
//   pass 1  which file defines each symbol; types and their kinds; implementation relationships
//   pass 2  every non-definition occurrence of a defined symbol: references (module to module),
//           calls (the symbol is a method) and, per member symbol, how often it is referenced
//           outside its own definition, and how often that is a read.
// A symbol the index does not define in a mapped file (a library, a generated file) is ignored.

import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE, rangeOf, scipRecords } from './reader.mjs';
import { classify } from './symbols.mjs';

// SymbolInformation.Kind values: Interface 21, Protocol 42, Trait 53.
const INTERFACE_KINDS = new Set([21, 42, 53]);

const isLocal = (s) => s.startsWith('local ');

/** The repository-relative directory the index's paths are relative to ('' when unknown). */
export function projectPrefix(root, projectRoot) {
  if (!projectRoot) return '';
  let abs = projectRoot;
  try {
    if (abs.startsWith('file:')) abs = fileURLToPath(abs);
    else if (!abs.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(abs)) return '';
    const rel = relative(realpathSync(resolve(root)), realpathSync(abs)).split('\\').join('/');
    return rel.startsWith('..') ? '' : rel;
  } catch {
    return '';
  }
}

const inside = (outer, o) => {
  const [sl, sc] = rangeOf(o);
  const [a, b, c, d] = rangeOf(outer);
  return (sl > a || (sl === a && sc >= b)) && (sl < c || (sl === c && sc <= d));
};

/**
 * @param {string[]} indexPaths absolute paths of SCIP index files
 * @param {{root: string, hasFile: (path: string) => boolean}} opts `hasFile` says whether a repository path is a mapped file
 */
export function analyzeIndex(indexPaths, { root, hasFile }) {
  const t0 = Date.now();
  const syms = []; // id → symbol
  const defs = new Map(); // symbol → id
  const defFile = [];
  const defKind = []; // 1 type, 2 method, 3 member
  const files = []; // fi → { path, language, definitions, types, memberIds }
  const fileOf = new Map(); // path → fi
  const types = new Map(); // type symbol → { file, name, kind, line }
  const rels = []; // [from symbol, to symbol] implementation relationships between types
  const tools = new Set();
  const stats = { indexes: indexPaths.length, documents: 0, matched: 0, unmatched: 0, occurrences: 0, symbols: 0 };

  const resolver = (prefix) => (rel) => {
    const withPrefix = prefix ? `${prefix}/${rel}` : rel;
    if (hasFile(withPrefix)) return withPrefix;
    return prefix && hasFile(rel) ? rel : null;
  };

  const eachDocument = (fn) => {
    for (const index of indexPaths) {
      let path = resolver('');
      for (const rec of scipRecords(index)) {
        if (rec.type === 'metadata') {
          path = resolver(projectPrefix(root, rec.value.project_root));
          if (rec.value.tool.name) tools.add(`${rec.value.tool.name}${rec.value.tool.version ? `@${rec.value.tool.version}` : ''}`);
        } else if (rec.type === 'document') fn(rec.value, path(rec.value.relative_path));
      }
    }
  };

  eachDocument((d, path) => {
    stats.documents++;
    if (!path) {
      stats.unmatched++;
      return;
    }
    if (fileOf.has(path)) return; // the same file in two indexes: the first wins
    stats.matched++;
    const fi = files.length;
    const info = { path, language: d.language, definitions: 0, types: 0, memberIds: [] };
    files.push(info);
    fileOf.set(path, fi);
    const kinds = new Map();
    for (const s of d.symbols) {
      kinds.set(s.symbol, s.kind);
      if (!s.relationships.length || isLocal(s.symbol)) continue;
      for (const r of s.relationships) if (r.is_implementation && r.symbol && !isLocal(r.symbol)) rels.push([s.symbol, r.symbol]);
    }
    for (const o of d.occurrences) {
      stats.occurrences++;
      if (!(o.roles & ROLE.Definition) || !o.symbol || isLocal(o.symbol) || defs.has(o.symbol)) continue;
      const c = classify(o.symbol);
      if (!c) continue;
      const id = syms.length;
      syms.push(o.symbol);
      defFile.push(fi);
      defKind.push(c.kind === 'type' ? 1 : c.kind === 'method' ? 2 : 3);
      defs.set(o.symbol, id);
      info.definitions++;
      if (c.kind === 'type') {
        info.types++;
        types.set(o.symbol, { file: fi, name: c.name, kind: kinds.get(o.symbol) ?? 0, line: (o.range[0] ?? 0) + 1 });
      } else info.memberIds.push(id);
    }
    stats.symbols += d.symbols.length;
  });

  const refs = new Uint32Array(syms.length);
  const reads = new Uint32Array(syms.length);
  const pairs = new Map(); // "src>tgt" → { src, tgt, refs, calls, line, callLine }
  eachDocument((d, path) => {
    const fi = path ? fileOf.get(path) : undefined;
    if (fi === undefined) return;
    // A method calling itself is not a use of it from outside: its own enclosing range is skipped.
    const own = new Map();
    for (const o of d.occurrences) if (o.enclosing && (o.roles & ROLE.Definition) && defKind[defs.get(o.symbol)] === 2) own.set(o.symbol, o.enclosing);
    for (const o of d.occurrences) {
      if ((o.roles & (ROLE.Definition | ROLE.ForwardDefinition)) || !o.symbol || isLocal(o.symbol)) continue;
      const id = defs.get(o.symbol);
      if (id === undefined) continue;
      const enclosing = own.get(o.symbol);
      if (enclosing && inside(enclosing, o.range)) continue;
      refs[id]++;
      const writeOnly = (o.roles & ROLE.WriteAccess) && !(o.roles & ROLE.ReadAccess);
      if (!writeOnly) reads[id]++;
      const tf = defFile[id];
      if (tf === fi) continue;
      const key = `${fi}>${tf}`;
      let p = pairs.get(key);
      if (!p) pairs.set(key, (p = { src: fi, tgt: tf, refs: 0, calls: 0, line: 0, callLine: 0 }));
      const line = (o.range[0] ?? 0) + 1;
      if (defKind[id] === 2) {
        p.calls++;
        if (!p.callLine || line < p.callLine) p.callLine = line;
      } else {
        p.refs++;
        if (!p.line || line < p.line) p.line = line;
      }
    }
  });

  const inherits = [];
  for (const [from, to] of rels) {
    const a = types.get(from);
    const b = types.get(to);
    if (!a || !b || a.file === undefined) continue;
    const iface = (t) => INTERFACE_KINDS.has(t.kind) || (!t.kind && /^I[A-Z]/.test(t.name));
    inherits.push({ from: { path: files[a.file].path, name: a.name, line: a.line }, to: { path: files[b.file].path, name: b.name, line: b.line }, edge: iface(b) && !iface(a) ? 'IMPLEMENTS' : 'EXTENDS' });
  }
  inherits.sort((x, y) => (`${x.from.path}#${x.from.name}>${x.to.path}#${x.to.name}` < `${y.from.path}#${y.from.name}>${y.to.path}#${y.to.name}` ? -1 : 1));

  const byPath = new Map();
  for (const info of files) {
    byPath.set(info.path, {
      language: info.language,
      definitions: info.definitions,
      types: info.types,
      members: info.memberIds.map((id) => ({ ...classify(syms[id]), kind: defKind[id] === 2 ? 'method' : 'member', refs: refs[id], reads: reads[id] })),
    });
  }
  const links = [...pairs.values()]
    .map((p) => ({ from: files[p.src].path, to: files[p.tgt].path, refs: p.refs, calls: p.calls, line: p.line, callLine: p.callLine }))
    .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0));
  const typeList = [...types.values()].map((t) => ({ path: files[t.file].path, name: t.name, line: t.line, interface: INTERFACE_KINDS.has(t.kind) || (!t.kind && /^I[A-Z]/.test(t.name)) }));
  typeList.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { files: byPath, links, inherits, types: typeList, tools: [...tools].sort(), stats: { ...stats, symbols_defined: syms.length, ms: Date.now() - t0 } };
}
