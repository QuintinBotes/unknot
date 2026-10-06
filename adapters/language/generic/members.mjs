// "A module depends on another module only through members it never reads": the language-neutral
// engine. A field, property or constructor-injected parameter whose type lives in another module
// and that nothing ever reads keeps that module coupled for nothing. What a language writes is in
// its table (member-syntax.mjs); everything here is shared.
//
// Extraction (memberRefs) records, per file, which type names it mentions, which of them are
// only the declared type of an unused member, and the receiver-typed member accesses the file
// makes (declarations, parameters, `new T`, casts, patterns, `T.Static`, `this.`), so an
// unrelated `x.name` is not a use of someone else's `name`. A receiver with a declared type
// outside the mapped files is no use of a mapped type's member; one with no declared type at all
// stays a possible use (name-only evidence). Linking (memberReach, declaredEdge) asks, for a
// member other files could reach, whether any of them touches it.

const blank = (m) => m.replace(/[^\n]/g, ' ');
/** Escape for use inside a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lastSeg = (t) => t.split(/\s*\.\s*/).pop();
// `T`, `TEntity`: a generic parameter could be anything.
const GENERIC_PARAM = /^T(?:[A-Z]\w*)?$/;
// Names other files can reach a member by: after a dot, as an initializer or pattern property, or quoted (reflection, binding).
const ACCESSED = /(?:\.|\?\.)\s*([A-Za-z_]\w*)|[{,]\s*([A-Za-z_]\w*)\s*(?:=(?![=>])|:(?!:))|"([A-Za-z_]\w*)"/g;
const QUOTED = /"([A-Za-z_]\w*)"/g;
const LOOSE_COLON = { re: /[{,]\s*([A-Za-z_]\w*)\s*:(?!:)/g, skip: true };
const LOOSE_EQUALS = { re: /[{,]\s*([A-Za-z_]\w*)\s*=(?![=>])/g, skip: true };

/** Matching `}` for the `{` at `open` in blanked code, or -1. */
function closeBrace(code, open) {
  let d = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') d++;
    else if (code[i] === '}' && --d === 0) return i;
  }
  return -1;
}

/**
 * Receiver-typed member accesses. `acc[member][recv]` counts accesses of `member`, where recv is
 * the receiver's declared type, `~Name` (a capitalised bare name: a type if the repository has
 * one, else unknown) or '' (unresolved). `calls[Type]` is `[count, weak, line]`: how often the file
 * reaches members of Type through a resolved receiver or `new Type`; weak when the receiver
 * variable's name carries more than one declaration in the file.
 */
function memberAccess(lx, types, code, syn) {
  const spans = types.map((t) => ({ name: t.name, a: t.startLine, b: t.endLine }));
  const enclosing = (off) => {
    const l = lx.lineOf(off);
    let best = null;
    for (const t of spans) if (t.a <= l && l <= t.b && (!best || t.b - t.a < best.b - best.a)) best = t;
    return best?.name ?? '';
  };
  const notName = new Set(syn.notName);
  const vars = new Map();
  const declare = (name, type) => {
    if (!name || notName.has(name)) return;
    if (!vars.has(name)) vars.set(name, new Set());
    vars.get(name).add(type && !GENERIC_PARAM.test(type) ? type : '');
  };
  for (const d of syn.typed) for (const m of code.matchAll(d.re)) declare(m[d.name], lastSeg(m[d.type]));
  for (const inf of syn.infer ?? []) {
    for (const m of code.matchAll(inf.re)) {
      const rhs = m[inf.rhs] ?? '';
      let t = null;
      for (const r of inf.rhsTypes) if ((t = r.exec(rhs))) break;
      declare(m[inf.name], t ? lastSeg(t[1]) : '');
    }
  }
  for (const u of syn.untyped ?? []) for (const m of code.matchAll(u.re)) for (const n of m[u.names].split(/\s*,\s*/)) declare(n, '');

  // The names that stand for the current instance; where a receiver declares its type (Go), that type.
  const recv = new Map();
  const selfNames = new Set(syn.self);
  if (syn.selfDecl) for (const m of code.matchAll(syn.selfDecl)) { selfNames.add(m[1]); if (m[2]) recv.set(m[1], m[2]); }
  const alt = [...selfNames].map(esc).join('|');
  const ownRe = alt ? new RegExp(`(?:^|[^\\w.@$])(${alt})\\s*$`) : null;
  const selfRe = alt ? new RegExp(`(?:^|[^\\w.@$])(?:${alt})\\s*\\.\\s*([A-Za-z_]\\w*)\\s*$`) : null;

  const acc = {};
  const calls = {};
  const bump = (member, r) => {
    const o = (acc[member] ??= {});
    o[r] = (o[r] ?? 0) + 1;
  };
  const call = (type, weak, off) => {
    const c = (calls[type] ??= [0, 0, lx.lineOf(off) + 1]);
    c[0]++;
    if (weak) c[1] = 1;
  };
  const skip = new Set();
  // `new T { Member = ... }` and `T{member: ...}` assign T's members.
  if (syn.init) {
    for (const m of code.matchAll(syn.init.re)) {
      const t = lastSeg(m[1]);
      const open = m.index + m[0].length - 1;
      const end = closeBrace(code, open);
      if (end < 0) continue;
      let d = 0;
      for (let i = open; i < end; i++) {
        if (code[i] === '{') d++;
        else if (code[i] === '}') d--;
        if (d === 1 && (code[i] === ',' || i === open)) {
          const im = syn.init.key.exec(code.slice(i + 1, i + 200));
          if (im) { bump(im[1], t); skip.add(i + 1 + im[0].indexOf(im[1])); }
        }
      }
    }
  }
  if (syn.news) for (const m of code.matchAll(syn.news)) call(lastSeg(m[1]), false, m.index);
  for (const m of code.matchAll(/\??\.\s*([A-Za-z_]\w*)/g)) {
    let pre = code.slice(Math.max(0, m.index - 120), m.index);
    if (syn.strip) pre = pre.replace(syn.strip, '');
    let weak = false;
    const typesOf = (n) => {
      const set = vars.get(n);
      if (!set) return [/^[A-Z]/.test(n) ? `~${n}` : ''];
      weak = set.size > 1;
      return [...set];
    };
    const self = selfRe?.exec(pre);
    const id = /([A-Za-z_]\w*)\s*$/.exec(pre);
    const own = ownRe?.exec(pre);
    let types;
    if (own) types = [recv.get(own[1]) ?? enclosing(m.index)];
    else if (self) types = typesOf(self[1]);
    else if (!id || /\.\s*$/.test(pre.slice(0, id.index)) || syn.chain.test(id[1])) types = [''];
    else types = typesOf(id[1]);
    for (const t of types) {
      bump(m[1], t);
      if (own || !t) continue;
      if (t.startsWith('~')) call(t.slice(1), false, m.index);
      else call(t, weak || types.includes(''), m.index);
    }
  }
  for (const l of syn.loose ?? [LOOSE_COLON, LOOSE_EQUALS]) {
    for (const m of code.matchAll(l.re)) {
      for (const name of l.split ? m.slice(1).filter(Boolean).flatMap((g) => g.split(',').map((p) => /^\s*([A-Za-z_$][\w$]*)/.exec(p)?.[1]).filter(Boolean)) : [m[1]]) {
        if (!(l.skip && skip.has(m.index + m[0].indexOf(name)))) bump(name, '');
      }
    }
  }
  // Interpolation holes and comments are blanked in `code`; what only the plain text shows is a possible use.
  for (const m of lx.plain.matchAll(ACCESSED)) if (code[m.index] !== lx.plain[m.index] && !m[3]) bump(m[1] ?? m[2], '');
  for (const m of lx.plain.matchAll(syn.quoted ?? QUOTED)) bump(m[1], '');
  return { acc, calls, enclosing };
}

/** The types a file declares, as the engine reads them: `{ name, startLine, endLine, bases }` from `{ name, startLine, endLine, extends, implements, bases }`. */
export const memberTypes = (types) => types.map((t) => ({ name: t.name, startLine: t.startLine, endLine: t.endLine, bases: [...t.extends, ...t.implements, ...t.bases] }));

/** Which form of `syn.forms` the mention of a type at `off` takes, and what it declares; null when none. */
function formAt(syn, code, off, name) {
  const before = code.slice(Math.max(0, off - 160), off);
  const after = code.slice(off + name.length, off + name.length + 200);
  for (const f of syn.forms) {
    const b = f.before ? f.before.exec(before) : null;
    if (f.before && !b) continue;
    const a = f.after ? f.after.exec(after) : null;
    if (f.after && !a) continue;
    if (f.gate && !f.gate.some((g) => g.test(before))) continue;
    const declared = b?.groups?.name ?? a?.groups?.name;
    if (!declared) continue;
    if (f.gateName && !f.gateName.test(declared)) continue;
    const tail = f.tail ? f.tail.exec(before)[1] : (b?.groups?.mods ?? '');
    const start = b ? off - before.length + b.index : off;
    const end = b ? off + name.length + (a ? a[0].length : 0) : off + name.length + a[0].indexOf(declared) + declared.length;
    const weak = f.weak ?? syn.weak ?? null;
    return {
      kind: f.kind,
      name: declared,
      pub: (!f.pubTail || f.pubTail.test(tail)) && (!(f.pubName ?? syn.pubName) || (f.pubName ?? syn.pubName).test(declared)),
      weak: weak ? weak.test(declared) : false,
      start,
      end,
      at: off + name.length + (a ? Math.max(0, a[0].indexOf(declared)) : 0),
    };
  }
  return null;
}

/**
 * What a file states about members, from lexed text and the types it declares (`types`:
 * `{ name, startLine, endLine, bases }`). `declOnly` maps a type name to the member names of
 * that type that are never used (a type with a mention that is not an unused member or
 * parameter is left out); `declPublic` lists, per such name, the members not private to the
 * file and `publicMembers` every injected member visible outside it (used or not). `words` and `accessed` are the identifiers the
 * file contains, `acc` its receiver-typed member accesses and `calls` its resolved calls per type
 * (see memberAccess), so link can ask whether another file touches a member.
 * @returns {{ refs: string[], declOnly: Record<string, string>, declPublic: Record<string, string[]>, publicMembers: string[], publicOwners: Record<string, string>, words: string[], acc: object, calls: object, typeBases: Record<string, string[]> }}
 */
export function memberRefs(lx, types, syn) {
  const code = syn.blank ? lx.code.replace(syn.blank, blank) : lx.code;
  const own = new Set(types.map((t) => t.name));
  const heads = new Map();
  const chains = new Set();
  for (const m of code.matchAll(syn.heads)) {
    const segs = m[1].split(/\s*\.\s*/);
    const head = segs[0];
    if (!/[a-z]/.test(head)) continue;
    if (segs.length > 1) chains.add(segs.join('.'));
    if (own.has(head)) continue;
    if (!heads.has(head)) heads.set(head, []);
    heads.get(head).push(m.index);
  }
  const declOnly = {};
  const declPublic = {};
  const publicMembers = new Set();
  const access = memberAccess(lx, types, code, syn);
  const publicOwners = {};
  // A statement that stores a parameter into a member where nothing declares the member (`self.x = x`).
  const injected = syn.inject ? [...code.matchAll(syn.inject)].map((m) => ({ l: m.groups.l, r: m.groups.r, at: m.index })) : [];
  for (const [name, offs] of heads) {
    // Qualified mentions of the same simple name are ordinary uses.
    const members = new Set();
    const pub = new Set();
    const params = new Set();
    const spans = [];
    let ok = true;
    for (const off of offs) {
      if (spans.length && off < spans[spans.length - 1][1]) continue; // the member's own name, when it equals the type's
      const before = code.slice(Math.max(0, off - 160), off);
      if (syn.nameofBefore?.test(before)) continue; // nameof(Tool) is a compile-time mention
      const f = formAt(syn, code, off, name);
      if (!f) { ok = false; break; }
      if (f.kind !== 'param') {
        members.add(f.name);
        if (f.pub) {
          pub.add(f.name);
          // A member reachable only by convention (Go's unexported fields, Python's `_x`) is not public surface.
          if (!f.weak) publicMembers.add(f.name);
          publicOwners[f.name] = access.enclosing(f.at);
        }
      }
      if (f.kind !== 'member') params.add(f.name);
      spans.push([f.start, f.end]);
    }
    if (!ok) continue;
    for (const i of injected) {
      if (!params.has(i.r)) continue;
      members.add(i.l);
      if (!syn.pubName || syn.pubName.test(i.l)) {
        pub.add(i.l);
        if (!syn.weak?.test(i.l)) publicMembers.add(i.l);
        publicOwners[i.l] = access.enclosing(i.at);
      }
    }
    if (!members.size) continue;
    // Usage is checked on the text with strings intact: interpolation holes (`{_member}`) count as uses.
    let masked = syn.blank ? lx.plain.replace(syn.blank, blank) : lx.plain;
    if (syn.nameof) masked = masked.replace(syn.nameof, blank);
    for (const [a, b] of spans) masked = masked.slice(0, a) + ' '.repeat(b - a) + masked.slice(b);
    // Constructor injection: `member = param;` keeps neither of them in use.
    masked = masked.replace(syn.ctorAssign, (all, l, r) => (members.has(l) && params.has(r) ? ' '.repeat(all.length) : all));
    const used = (n) => new RegExp(`\\b${esc(n.replace(/^#/, ''))}\\b`).test(masked);
    if ([...params].some(used) || [...members].some(used)) continue;
    declOnly[name] = [...members].sort().join(', ');
    if (pub.size) declPublic[name] = [...pub].sort();
  }
  const refs = [...new Set([...heads.keys(), ...chains])].sort();
  const words = new Set(lx.plain.match(/[A-Za-z_]\w+/g));
  const typeBases = {};
  for (const t of types) typeBases[t.name] = [...new Set([...(typeBases[t.name] ?? []), ...t.bases])].sort();
  return { refs, declOnly, declPublic, publicMembers: [...publicMembers].sort(), publicOwners, words: [...words].sort(), acc: access.acc, calls: access.calls, typeBases };
}

/** The attributes memberRefs leaves on a module for link to read; link removes them again (dropMemberAttrs) so they are never persisted. */
export function memberAttrs(r) {
  const a = { refs: r.refs };
  if (Object.keys(r.declOnly).length) a.decl_only = r.declOnly;
  if (Object.keys(r.declPublic).length) a.decl_public = r.declPublic;
  a.words = r.words;
  a.acc = r.acc;
  a.member_calls = r.calls;
  a.type_bases = r.typeBases;
  if (r.publicMembers.length) a.public_members = r.publicMembers;
  if (Object.keys(r.publicOwners).length) a.public_owners = r.publicOwners;
  return a;
}

/** The link-only attributes of memberAttrs; `public_members` stays (the derived public surface reads it). */
export function dropMemberAttrs(a) {
  for (const k of ['refs', 'decl_only', 'decl_public', 'words', 'acc', 'member_calls', 'type_bases', 'public_owners']) delete a[k];
}

/**
 * Link-side reach of members. `files` lists `{ path, attrs }` of one family of languages;
 * `typeNames` the names of the types those files declare. The result answers, per member, how
 * another file reaches it. Inheritance is by simple name across the family: a member reached
 * through a base or a derived type is reached. An access counts when its receiver's type is the
 * declaring type, one related to it by inheritance, or unresolved (name-only evidence); a bare
 * read counts in a derived class where the language allows it. `inScope(declaring, other)` says whether
 * `other` can see the declaring file's members at all (a Go field is private to its package directory).
 */
export function memberReach(files, typeNames, bareOf, inScope = () => true) {
  const add = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  const direct = new Map();
  for (const { attrs: a } of files) {
    for (const [t, bs] of Object.entries(a.type_bases ?? {})) direct.set(t, [...new Set([...(direct.get(t) ?? []), ...bs])]);
  }
  const ancMemo = new Map();
  const anc = (t) => {
    if (ancMemo.has(t)) return ancMemo.get(t);
    const out = new Set();
    ancMemo.set(t, out);
    const stack = [...(direct.get(t) ?? [])];
    while (stack.length) {
      const x = stack.pop();
      if (out.has(x)) continue;
      out.add(x);
      stack.push(...(direct.get(x) ?? []));
    }
    return out;
  };
  const related = (r, d) => !d || r === d || anc(r).has(d) || anc(d).has(r);

  // Members that are held only by an injected declaration: which other files touch each name, and through what?
  const candidates = new Set();
  for (const { attrs: a } of files) for (const ms of Object.values(a.decl_public ?? {})) for (const m of ms) candidates.add(m);
  const touchedBy = new Map();
  if (candidates.size) {
    for (const { path, attrs: a } of files) {
      for (const n of Object.keys(a.acc ?? {})) if (candidates.has(n)) add(touchedBy, n, { path, recvs: Object.keys(a.acc[n]).sort() });
      if (bareOf(a)) for (const n of a.words ?? []) if (candidates.has(n) && !typeNames.has(n)) add(touchedBy, n, { path, bare: a.types ?? [] });
    }
  }
  /**
   * 'typed', 'name-only' or null: how another file reaches `member`, declared by `owner` in `path`.
   * A receiver whose declared type is known by name is a use only when that type is the owner or
   * related to it by inheritance (or shares its simple name); a declared type outside the mapped
   * files is a foreign receiver and no use at all. Only a receiver with no declared type (a call
   * result, `var x = Make()`, a lambda parameter, a bare unknown name) is a possible use; the files
   * holding such receivers are added to `where`.
   */
  return (path, member, owner, where) => {
    let best = null;
    for (const t of touchedBy.get(member) ?? []) {
      if (t.path === path || !inScope(path, t.path)) continue;
      for (const r of t.recvs ?? []) {
        if (r === '' || (r.startsWith('~') && !typeNames.has(r.slice(1)))) {
          best ??= 'name-only';
          where?.add(t.path);
        } else if (related(r.startsWith('~') ? r.slice(1) : r, owner)) return 'typed';
      }
      if ((t.bare ?? []).some((x) => x === owner || anc(x).has(owner))) return 'typed';
    }
    return best;
  };
}

/**
 * The attributes of the edge from `path` to a module it reaches through types. `h` holds what
 * the linker saw: `decl` (every mention of that module's types in the file declares an unused
 * member), the member names, and `pub` (the ones other files could reach). Members other files
 * reach are ordinary uses; a name that only receivers of unknown type read leaves the edge
 * marked as a possible use.
 * @returns {{ declared: boolean, attrs: object }}
 */
export function declaredEdge(path, h, owners, reach, syn) {
  const where = new Set();
  const reaches = h.decl && h.members.size ? [...h.pub].map((m) => reach(path, m, owners[m], where)) : [];
  const declared = h.decl && h.members.size && !reaches.some(Boolean);
  const nameOnly = h.decl && h.members.size && !reaches.includes('typed') && reaches.includes('name-only');
  const weak = syn?.weak && h.pub.size && [...h.pub].every((m) => syn.weak.test(m));
  return {
    declared,
    attrs: {
      ...(declared && { declared_only: true, unused_member: [...h.members].sort().join(', '), member_visibility: h.pub.size ? (weak ? syn.weakLabel : 'public') : 'private' }),
      ...(nameOnly && { use_evidence: 'name-only', possible_use_of: [...h.pub].filter((m, i) => reaches[i]).sort().join(', '), possible_receivers: [...where].sort().join(', ') }),
    },
  };
}

const SEMANTIC_KEYS = ['declared_only', 'unused_member', 'member_visibility', 'unused_evidence', 'use_evidence', 'possible_use_of', 'possible_receivers'];

/**
 * Edges from one module to the modules it reaches, with what a SCIP index decided about it
 * (`sem`: see adapters/semantic/scip; null when the file is not covered). The index replaces the
 * lexical verdict for a covered file in every language: lexical declared-only and name-only
 * evidence are removed, and the index's declared-only edges are set (or added, when no import or
 * type mention made one) with `semantic: true` so the caller records them as compiler evidence.
 * @param {{ declared: Map<string, {members: string[], visibility: string, line: number, type: string}> } | null} sem
 * @param {{ to: string, line: number, attrs: object }[]} edges
 */
export function withSemantic(sem, edges) {
  if (!sem) return edges;
  const seen = new Set();
  const out = edges.map((e) => {
    seen.add(e.to);
    const attrs = { ...e.attrs };
    for (const k of SEMANTIC_KEYS) delete attrs[k];
    const d = sem.declared.get(e.to);
    return d ? { ...e, attrs: { ...attrs, declared_only: true, unused_member: d.members.join(', '), member_visibility: d.visibility, unused_evidence: 'semantic' }, semantic: true } : { ...e, attrs };
  });
  for (const [to, d] of [...sem.declared].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!seen.has(to)) out.push({ to, line: d.line, attrs: { spec: d.type, via: 'type', declared_only: true, unused_member: d.members.join(', '), member_visibility: d.visibility, unused_evidence: 'semantic' }, semantic: true });
  }
  return out;
}
