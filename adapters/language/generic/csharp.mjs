// C# dependencies at type level. Extraction records which PascalCase names (and dotted
// chains) a file mentions plus which of them are only the declared type of an unused
// field or property; linking resolves those names through the namespaces visible to the
// file (own and ancestors, `using`, `global using` anywhere, aliases, `using static`).
// A `using` alone never links anything, so nothing fans out to a whole namespace.
// What a file states about its members (declarations, receiver types, reads) is read by the
// language-neutral engine in members.mjs from the C# table in member-syntax.mjs; this file
// keeps what is C# only: namespaces, `using` and the module-level CALLS edges.

import { declaredEdge, memberReach, memberRefs, memberTypes } from './members.mjs';
import { MEMBER_SYNTAX } from './member-syntax.mjs';

const SYNTAX = MEMBER_SYNTAX.csharp;

/** Names a C# file mentions, minus the types it declares, and the member facts of members.mjs. */
export function csharpRefs(lx, an) {
  return memberRefs(lx, memberTypes(an.types), SYNTAX);
}

/**
 * Link-side resolver for every C# module. `mods` maps path to its module fact; the result
 * answers, per file, which other files it uses at type level. `semantic` (path to what a SCIP index
 * decided, see adapters/semantic/scip) replaces the name matching for the files it covers: whether an
 * injected member is used comes from the index, and the name-matched module calls are dropped.
 */
export function csharpLinker(mods, sortedMods, semantic = null) {
  const byName = new Map();
  const full = new Map();
  const known = new Set();
  const globals = new Set();
  const add = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  for (const path of sortedMods) {
    const a = mods.get(path).attrs;
    if (a.language !== 'csharp') continue;
    for (const ns of a.namespaces ?? []) {
      const parts = ns.split('.');
      for (let k = 1; k <= parts.length; k++) known.add(parts.slice(0, k).join('.'));
      for (const t of a.types ?? []) {
        add(byName, t, { ns, path });
        add(full, `${ns}.${t}`, path);
      }
    }
    for (const imp of a.imports ?? []) if (imp.global && imp.kind === 'using') globals.add(imp.spec);
  }

  const csFiles = sortedMods.filter((p) => mods.get(p).attrs.language === 'csharp').map((p) => ({ path: p, attrs: mods.get(p).attrs }));
  const reach = memberReach(csFiles, new Set(byName.keys()), () => true);

  return (path) => {
    const a = mods.get(path).attrs;
    const ownNs = new Set();
    for (const ns of a.namespaces ?? []) {
      const parts = ns.split('.');
      for (let k = 1; k <= parts.length; k++) ownNs.add(parts.slice(0, k).join('.'));
    }
    const usings = new Map();
    for (const g of globals) usings.set(g, 1);
    const alias = new Map();
    const statics = [];
    const externals = [];
    for (const imp of a.imports ?? []) {
      if (imp.kind === 'alias') alias.set(imp.alias, imp);
      else if (imp.kind === 'static') statics.push(imp);
      else {
        usings.set(imp.spec, imp.line);
        if (!known.has(imp.spec)) externals.push(imp);
      }
    }
    const declOnly = a.decl_only ?? {};
    const hits = new Map();
    const declPublic = a.decl_public ?? {};
    const sem = semantic?.get(path) ?? null;
    const hit = (to, spec, line, decl, member, pub = []) => {
      if (to === path) return;
      let h = hits.get(to);
      if (!h) hits.set(to, (h = { spec, line, decl: true, members: new Set(), pub: new Set() }));
      if (decl) {
        h.members.add(member);
        for (const m of pub) h.pub.add(m);
      } else h.decl = false;
    };
    const lookup = (name) => {
      const all = byName.get(name) ?? [];
      const mine = all.filter((e) => ownNs.has(e.ns));
      return mine.length ? mine : all.filter((e) => usings.has(e.ns));
    };
    for (const ref of a.refs ?? []) {
      if (ref.includes('.')) {
        const segs = ref.split('.');
        let done = false;
        for (let k = segs.length; k >= 2 && !done; k--) {
          const name = segs.slice(0, k).join('.');
          for (const prefix of ['', ...[...ownNs, ...usings.keys()].map((n) => `${n}.`)]) {
            const ps = full.get(`${prefix}${name}`);
            if (!ps) continue;
            for (const p of ps) hit(p, `${prefix}${name}`, 1, false);
            done = true;
            break;
          }
        }
        continue;
      }
      const al = alias.get(ref);
      if (al) {
        for (const p of full.get(al.spec) ?? []) hit(p, al.spec, al.line, false);
        continue;
      }
      let name = ref;
      let es = lookup(name);
      if (!es.length) es = lookup((name = `${ref}Attribute`));
      for (const e of es) hit(e.path, `${e.ns}.${name}`, usings.get(e.ns) ?? 1, ref in declOnly, declOnly[ref], declPublic[ref]);
    }
    for (const s of statics) for (const p of full.get(s.spec) ?? []) hit(p, s.spec, s.line, false);
    // A member another file reaches is an ordinary use, however the declaring file treats it. A file a
    // SCIP index covers has the index's verdict instead (see withSemantic), never name matching.
    const owners = a.public_owners ?? {};
    const edges = [...hits].map(([to, h]) => ({ to, line: h.line, attrs: { spec: h.spec, via: 'type', ...declaredEdge(path, h, owners, reach, SYNTAX).attrs } }));
    // Calls: members reached through a receiver whose type is declared in another repository file.
    const callTo = new Map();
    for (const [t, [n, weak, line]] of Object.entries(a.member_calls ?? {})) {
      const es = lookup(t);
      for (const e of es) {
        if (e.path === path) continue;
        const c = callTo.get(e.path) ?? { count: 0, weak: false, line };
        c.count += n;
        c.weak ||= weak === 1 || es.length > 1;
        c.line = Math.min(c.line, line);
        callTo.set(e.path, c);
      }
    }
    const calls = sem ? [] : [...callTo].map(([to, c]) => ({ to, ...c })).sort((x, y) => (x.to < y.to ? -1 : 1));
    return { edges, externals, calls };
  };
}
