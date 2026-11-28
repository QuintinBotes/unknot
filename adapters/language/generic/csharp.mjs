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
import { LANGUAGE_IDS, language } from '../../../runtime/graph/languages.mjs';

const SYNTAX = MEMBER_SYNTAX[LANGUAGE_IDS.CSHARP];

/** Friend assemblies an `[assembly: InternalsVisibleTo("Name, PublicKey=…")]` attribute names. */
export const friendAssemblies = (lx) => [...new Set([...lx.plain.matchAll(/\[\s*assembly\s*:\s*(?:[\w.]+\.)?InternalsVisibleTo(?:Attribute)?\s*\(\s*@?"([^",]+)/g)].map((m) => m[1].trim()))].sort();

/** Names a C# file mentions, minus the types it declares, and the member facts of members.mjs. */
export function csharpRefs(lx, an) {
  return memberRefs(lx, memberTypes(an.types), SYNTAX);
}

/**
 * Link-side resolver for every C# module. `mods` maps path to its module fact; the result
 * answers, per file, which other files it uses at type level. `semantic` (path to what a SCIP index
 * decided, see adapters/semantic/scip) replaces the name matching for the files it covers: whether an
 * injected member is used comes from the index, and the name-matched module calls are dropped.
 * `allowed(from, to, name)` says whether the build lets `from` see `name` declared in `to` (build-graph.mjs).
 * `wiring` (di-ops.mjs propertyWiring) says which classes a container registration injects properties into.
 */
export function csharpLinker(mods, sortedMods, semantic = null, allowed = () => true, rec = () => {}, wiring = new Map()) {
  const byName = new Map();
  const full = new Map();
  const known = new Set();
  const globals = new Map(); // global using spec → its first declaration
  const add = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  for (const path of sortedMods) {
    const a = mods.get(path).attrs;
    if (language(a.language)?.genericSyntax?.memberLinker !== 'namespace') continue;
    for (const ns of a.namespaces ?? []) {
      const parts = ns.split('.');
      for (let k = 1; k <= parts.length; k++) known.add(parts.slice(0, k).join('.'));
      for (const t of a.types ?? []) {
        add(byName, t, { ns, path });
        add(full, `${ns}.${t}`, path);
      }
    }
    for (const imp of a.imports ?? []) if (imp.global && imp.kind === 'using' && !globals.has(imp.spec)) globals.set(imp.spec, imp);
  }

  const csFiles = sortedMods.filter((p) => language(mods.get(p).attrs.language)?.genericSyntax?.memberLinker === 'namespace').map((p) => ({ path: p, attrs: mods.get(p).attrs }));
  const reachAll = memberReach(csFiles, new Set(byName.keys()), () => true);
  // `rec` notes each key a file's link looks up, for incremental linking (generic/index.mjs).
  const reach = (path, member, ...rest) => (rec(`reach:${member}`), reachAll(path, member, ...rest));
  for (const [m, tag] of [[byName, 'cs.name'], [full, 'cs.full'], [known, 'cs.ns']]) {
    const get = m.get?.bind(m);
    const has = m.has.bind(m);
    if (get) m.get = (k) => (rec(`${tag}:${k}`), get(k));
    m.has = (k) => (rec(`${tag}:${k}`), has(k));
  }

  /**
   * The registrations (`path:line`) that inject every wired member of `wired` (member → declaring
   * type), or null when one of them is not injected. A registration names the class by simple
   * name: it counts when that name is declared in one file only, or in the registering file.
   */
  const injectedBy = (path, wired) => {
    const at = new Set();
    for (const [member, owner] of Object.entries(wired)) {
      rec(`di.wired:${owner}`);
      const declared = new Set((byName.get(owner) ?? []).map((e) => e.path));
      const regs = (wiring.get(owner) ?? []).filter((r) => (r.properties === 'autowired' || r.properties.includes(member)) && (declared.size === 1 || r.path === path));
      if (!regs.length) return null;
      for (const r of regs) at.add(r.at);
    }
    return at;
  };

  return (path) => {
    rec('cs.globals');
    const a = mods.get(path).attrs;
    const ownNs = new Set();
    for (const ns of a.namespaces ?? []) {
      const parts = ns.split('.');
      for (let k = 1; k <= parts.length; k++) ownNs.add(parts.slice(0, k).join('.'));
    }
    const usings = new Map();
    for (const g of globals.keys()) usings.set(g, 1);
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
    // A global using in another file reaches this one: a test that relies on `global using Moq;` still uses Moq (#125).
    for (const [spec, imp] of globals) if (!known.has(spec)) externals.push({ ...imp, line: 1 }); // the edge is deduplicated: a file's own `using` of it wins
    const declOnly = a.decl_only ?? {};
    const hits = new Map();
    const declPublic = a.decl_public ?? {};
    const declWired = a.decl_wired ?? {};
    const sem = semantic?.get(path) ?? null;
    const hit = (to, spec, line, decl, member, pub = [], by = null) => {
      if (to === path) return;
      let h = hits.get(to);
      if (!h) hits.set(to, (h = { spec, line, decl: true, members: new Set(), pub: new Set(), names: new Set(), by: new Set() }));
      h.names.add(spec.slice(spec.lastIndexOf('.') + 1));
      if (decl) {
        h.members.add(member);
        for (const m of pub) h.pub.add(m);
        for (const r of by ?? []) h.by.add(r);
      } else h.decl = false;
    };
    const ok = (to, spec) => allowed(path, to, spec.slice(spec.lastIndexOf('.') + 1));
    // Only a declaration the namespaces make visible is asked about, so a refusal counts an edge name matching would have drawn.
    const lookup = (name) => {
      const all = byName.get(name) ?? [];
      const mine = all.filter((e) => ownNs.has(e.ns) && ok(e.path, name));
      return mine.length ? mine : all.filter((e) => usings.has(e.ns) && ok(e.path, name));
    };
    for (const ref of a.refs ?? []) {
      if (ref.includes('.')) {
        const segs = ref.split('.');
        let done = false;
        for (let k = segs.length; k >= 2 && !done; k--) {
          const name = segs.slice(0, k).join('.');
          for (const prefix of ['', ...[...ownNs, ...usings.keys()].map((n) => `${n}.`)]) {
            const ps = full.get(`${prefix}${name}`)?.filter((p) => ok(p, name));
            if (!ps?.length) continue;
            for (const p of ps) hit(p, `${prefix}${name}`, 1, false);
            done = true;
            break;
          }
        }
        continue;
      }
      const al = alias.get(ref);
      if (al) {
        for (const p of full.get(al.spec) ?? []) if (ok(p, al.spec)) hit(p, al.spec, al.line, false);
        continue;
      }
      let name = ref;
      let es = lookup(name);
      if (!es.length) es = lookup((name = `${ref}Attribute`));
      // A public settable property is an injected member only where a registration injects it.
      const by = es.length && ref in declWired ? injectedBy(path, declWired[ref]) : null;
      const decl = ref in declOnly && (!(ref in declWired) || by !== null);
      for (const e of es) hit(e.path, `${e.ns}.${name}`, usings.get(e.ns) ?? 1, decl, declOnly[ref], declPublic[ref], by);
    }
    for (const s of statics) for (const p of full.get(s.spec) ?? []) if (ok(p, s.spec)) hit(p, s.spec, s.line, false);
    // A member another file reaches is an ordinary use, however the declaring file treats it. A file a
    // SCIP index covers has the index's verdict instead (see withSemantic), never name matching.
    const owners = a.public_owners ?? {};
    const edges = [...hits].map(([to, h]) => {
      const d = declaredEdge(path, h, owners, reach, SYNTAX);
      return { to, line: h.line, attrs: { spec: h.spec, via: 'type', ...(a.is_test && { names: [...h.names].sort() }), ...d.attrs, ...(d.declared && h.by.size && { injected_by: [...h.by].sort().join(', ') }) } };
    });
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
