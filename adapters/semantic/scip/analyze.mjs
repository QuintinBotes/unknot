// What a SCIP index says about a repository, computed in two streaming passes so that only
// one document is in memory at a time (plus a table of the symbols the repository defines):
//   pass 1  which file defines each symbol; types and their kinds; implementation relationships
//   pass 2  every non-definition occurrence of a defined symbol: references (module to module),
//           calls (the symbol is a method) and, per member symbol, how often it is referenced
//           outside its own definition, and how often that is a read; and, per file, which of its
//           member symbols hold a type defined elsewhere (see unused dependencies below).
// A symbol the index does not define in a mapped file (a library, a generated file) is ignored.
//
// Unused dependency members, for every indexed language. A member symbol (a field, property or
// attribute stored on the instance, including a constructor parameter kept as a property) defined in
// file F whose declared type is defined in another module M, and that has no read outside its own
// definition, is an unused dependency member. Write occurrences (SymbolRole WriteAccess without
// ReadAccess) are not reads; an occurrence with no role is a read. The member's declared type is,
// in order: the symbol's `is_type_definition` relationship; a type defined elsewhere that occurs
// inside the member's definition range (its enclosing range, else its line); the declared type of
// a parameter stored into the member (a parameter read on the line of a write to the member).
// F then holds M only through unused members when every other occurrence in F of a symbol
// defined in M is one of: an import (role Import, or a type occurrence outside every type
// definition range); a type occurrence inside the definition range of an unused member; or a type
// occurrence in the declaration of a parameter that is only stored into unused members or never
// read. Any member reached, method called or type used elsewhere is a real use and F is left alone.
// The edge F -> M is then declared-only (`unused_evidence: 'semantic'`), naming the members.

import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE, rangeOf, scipRecords } from './reader.mjs';
import { classify, descriptors } from './symbols.mjs';

// SymbolInformation.Kind values: Interface 21, Protocol 42, Trait 53.
const INTERFACE_KINDS = new Set([21, 42, 53]);

const isLocal = (s) => s.startsWith('local ');
// SymbolInformation.Kind Parameter.
const PARAMETER = 37;

const contains = (box, line, col) => (line > box[0] || (line === box[0] && col >= box[1])) && (line < box[2] || (line === box[2] && col <= box[3]));
const area = (box) => (box[2] - box[0]) * 1e6 + (box[3] - box[1]);
/** The smallest of `items` (each with a `box`) containing the position, or null. */
function innermost(items, line, col) {
  let best = null;
  for (const it of items) if (contains(it.box, line, col) && (!best || area(it.box) < area(best.box))) best = it;
  return best;
}
/** A private name by convention: the leading underscore or hash, or an unexported Go name. */
const privateName = (name, path) => /^[_#]/.test(name) || (/\.go$/.test(path) && /^[a-z]/.test(name));

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
  const typeRel = new Map(); // symbol → the symbol of its type, from is_type_definition relationships
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
      for (const r of s.relationships) {
        if (r.is_implementation && r.symbol && !isLocal(r.symbol)) rels.push([s.symbol, r.symbol]);
        if (r.is_type_definition && r.symbol && !isLocal(r.symbol)) typeRel.set(s.symbol, r.symbol);
      }
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
  const readsOut = new Uint32Array(syms.length); // reads that are not inside the member's own definition
  const memberLine = new Uint32Array(syms.length);
  const memberTypes = new Map(); // member id → type symbols occurring in its definition range
  const storedTypes = new Map(); // member id → type symbols of the parameters stored into it
  const paramState = new Map(); // file + parameter symbol → { other reads, member ids it is stored into }
  const pairs = new Map(); // "src>tgt" → { src, tgt, refs, calls, line, callLine }
  eachDocument((d, path) => {
    const fi = path ? fileOf.get(path) : undefined;
    if (fi === undefined) return;
    // A method calling itself is not a use of it from outside: its own enclosing range is skipped.
    const own = new Map();
    for (const o of d.occurrences) if (o.enclosing && (o.roles & ROLE.Definition) && defKind[defs.get(o.symbol)] === 2) own.set(o.symbol, o.enclosing);
    // This file's definitions the unused-dependency decision needs: members, parameters, type bodies, and the writes to members.
    const kindOf = new Map(d.symbols.map((x) => [x.symbol, x.kind]));
    const boxOf = (o) => (o.enclosing?.length ? rangeOf(o.enclosing) : [o.range[0] ?? 0, 0, o.range[0] ?? 0, Infinity]);
    const mdefs = [];
    const pdefs = new Map();
    const bodies = [];
    const writes = [];
    for (const o of d.occurrences) {
      if (!o.symbol) continue;
      const id = defs.get(o.symbol);
      if ((o.roles & ROLE.Definition) && id === undefined && (kindOf.get(o.symbol) === PARAMETER || (!isLocal(o.symbol) && descriptors(o.symbol)?.at(-1)?.suffix === 'param'))) {
        pdefs.set(o.symbol, { key: `${fi}\0${o.symbol}`, box: boxOf(o), types: new Set(), other: 0, stores: new Set() });
      }
      if (id === undefined) continue;
      if (defKind[id] === 1 && (o.roles & ROLE.Definition) && o.enclosing?.length) bodies.push({ box: rangeOf(o.enclosing) });
      if (defKind[id] !== 3 || defFile[id] !== fi) continue;
      if (o.roles & ROLE.Definition) {
        mdefs.push({ id, box: boxOf(o), types: new Set() });
        memberLine[id] = (o.range[0] ?? 0) + 1;
      }
      if ((o.roles & ROLE.Definition) || ((o.roles & ROLE.WriteAccess) && !(o.roles & ROLE.ReadAccess))) writes.push({ id, line: o.range[0] ?? 0, col: o.range[1] ?? 0 });
    }
    const mdefOf = new Map(mdefs.map((m) => [m.id, m]));
    for (const o of d.occurrences) {
      if (!o.symbol || (o.roles & (ROLE.Definition | ROLE.ForwardDefinition))) continue;
      const pd = pdefs.get(o.symbol);
      if (pd) {
        // A parameter read on the line of a write to a member is stored there, not used.
        const line = o.range[0] ?? 0;
        const col = o.range[1] ?? 0;
        let at = null;
        for (const w of writes) if (w.line === line && w.col < col && (!at || w.col > at.col)) at = w;
        if (at) pd.stores.add(at.id);
        else pd.other++;
        continue;
      }
      if (isLocal(o.symbol)) continue;
      const id = defs.get(o.symbol);
      if (id === undefined) continue;
      const enclosing = own.get(o.symbol);
      if (enclosing && inside(enclosing, o.range)) continue;
      refs[id]++;
      const writeOnly = (o.roles & ROLE.WriteAccess) && !(o.roles & ROLE.ReadAccess);
      if (!writeOnly) reads[id]++;
      if (defKind[id] === 3 && !writeOnly) {
        const m = mdefOf.get(id);
        if (!m || !contains(m.box, o.range[0] ?? 0, o.range[1] ?? 0)) readsOut[id]++;
      }
      const tf = defFile[id];
      if (tf === fi) continue;
      const key = `${fi}>${tf}`;
      let p = pairs.get(key);
      if (!p) pairs.set(key, (p = { src: fi, tgt: tf, refs: 0, calls: 0, line: 0, callLine: 0, importLike: 0, inMember: new Map(), inParam: new Map() }));
      {
        const pl = o.range[0] ?? 0;
        const pc = o.range[1] ?? 0;
        if (o.roles & ROLE.Import) p.importLike++;
        else if (defKind[id] === 1) {
          const m = innermost(mdefs, pl, pc);
          const q = m ? null : innermost(pdefs.values(), pl, pc);
          if (m) {
            m.types.add(o.symbol);
            p.inMember.set(m.id, (p.inMember.get(m.id) ?? 0) + 1);
          } else if (q) {
            q.types.add(o.symbol);
            p.inParam.set(q.key, (p.inParam.get(q.key) ?? 0) + 1);
          } else if (bodies.length && !bodies.some((b) => contains(b.box, pl, pc))) p.importLike++;
        }
      }
      const line = (o.range[0] ?? 0) + 1;
      if (defKind[id] === 2) {
        p.calls++;
        if (!p.callLine || line < p.callLine) p.callLine = line;
      } else {
        p.refs++;
        if (!p.line || line < p.line) p.line = line;
      }
    }
    for (const m of mdefs) if (m.types.size) memberTypes.set(m.id, m.types);
    for (const pd of pdefs.values()) {
      paramState.set(pd.key, { other: pd.other, stores: [...pd.stores] });
      for (const id of pd.stores) {
        if (!pd.types.size) continue;
        const set = storedTypes.get(id) ?? new Set();
        for (const t of pd.types) set.add(t);
        storedTypes.set(id, set);
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

  // Unused dependency members (see the top of this file), per file and the module each one holds.
  const typeSymbolsOf = (id) => {
    const rel = typeRel.get(syms[id]);
    if (rel && types.has(rel)) return [rel];
    return [...(memberTypes.get(id) ?? storedTypes.get(id) ?? [])];
  };
  const deps = new Map();
  for (const p of pairs.values()) {
    const unused = files[p.src].memberIds.filter((id) => defKind[id] === 3 && !readsOut[id] && typeSymbolsOf(id).some((t) => types.get(t)?.file === p.tgt));
    if (!unused.length) continue;
    let excused = p.importLike;
    for (const [id, n] of p.inMember) if (!readsOut[id]) excused += n;
    for (const [key, n] of p.inParam) {
      const st = paramState.get(key);
      if (st && !st.other && st.stores.every((id) => !readsOut[id])) excused += n;
    }
    if (p.refs + p.calls - excused > 0) continue;
    const from = files[p.src].path;
    const names = [...new Set(unused.map((id) => classify(syms[id]).name))].sort();
    const list = deps.get(from) ?? [];
    list.push({
      to: files[p.tgt].path,
      members: names,
      visibility: names.every((n) => privateName(n, from)) ? 'private' : 'public',
      line: Math.min(...unused.map((id) => memberLine[id] || 1)),
      type: types.get(typeSymbolsOf(unused[0]).find((t) => types.get(t)?.file === p.tgt)).name,
    });
    deps.set(from, list);
  }
  for (const list of deps.values()) list.sort((a, b) => (a.to < b.to ? -1 : 1));

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
  return { files: byPath, links, inherits, deps, types: typeList, tools: [...tools].sort(), stats: { ...stats, symbols_defined: syms.length, ms: Date.now() - t0 } };
}
