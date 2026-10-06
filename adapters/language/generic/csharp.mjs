// C# dependencies at type level. Extraction records which PascalCase names (and dotted
// chains) a file mentions plus which of them are only the declared type of an unused
// field or property; linking resolves those names through the namespaces visible to the
// file (own and ancestors, `using`, `global using` anywhere, aliases, `using static`).
// A `using` alone never links anything, so nothing fans out to a whole namespace.
// Member accesses are attributed to a receiver type where the file states it (declarations,
// parameters, `new T`, casts, `as`, patterns, `T.Static`, `this.`), so an unrelated `x.Name` is not
// a use of someone else's `Name`; an unresolved receiver stays a possible use (name-only evidence).
// The same resolution yields module-level CALLS edges.

const MODS = '(?:(?:public|private|protected|internal|static|readonly|virtual|override|required|new|sealed|volatile|abstract|partial|unsafe)\\s+)';
// A member can only be "unused" when nothing outside the file can reach it: it is private/readonly,
// or a dependency-injection attribute sits directly before it. Public contract members stay ordinary uses.
const ATTRIBUTED = new RegExp(`\\[[^\\]]*\\b(?:Dependency|Inject|FromServices|Import|ImportMany|Autowired)\\b[^\\]]*\\]\\s*(?:\\[[^\\]]*\\]\\s*)*${MODS}*$`);
const PRIVATE = new RegExp(`(?:^|[;{}\\]])\\s*(?=${MODS}*\\b(?:private|readonly)\\b)(?!${MODS}*\\b(?:public|protected|internal)\\b)${MODS}+$`);
const BEFORE_PARAM = /[(,]\s*(?:(?:this|ref|in|out|params|readonly)\s+)*$/;
const AFTER_MEMBER = /^(?:\s*<[^;{}()=]*>)?\??\s+([A-Za-z_]\w*)\s*(\{\s*(?:\[[^\]]*\]\s*)*(?:get|set|init)\b|;|=(?![=>]))/;
const AFTER_PARAM = /^(?:\s*<[^;{}()=]*>)?\??\s+([A-Za-z_]\w*)\s*(?=[,)]|=\s*(?:null|default)\s*[,)])/;
const USING_LINE = /^[ \t]*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?[\w.]+\s*;|\bnamespace\s+[\w.]+/gm;
// `nameof(x)` names a symbol without using it.
const NAMEOF = /\bnameof\s*\(\s*[\w.]+\s*\)/g;
const NAMEOF_BEFORE = /\bnameof\s*\(\s*(?:[\w]+\s*\.\s*)*$/;
const GUARD = '(?:\\s*\\?\\?\\s*throw\\s+new\\s+[\\w.]+\\s*\\([^;]*\\))?';
// The modifiers right before a member's type; anything but private/default is reachable from other files.
const MODS_TAIL = new RegExp(`(${MODS}*)$`);
const NON_PRIVATE = /\b(?:public|protected|internal)\b/;
// Names other files can reach a member by: after a dot, as an initializer or pattern property, or quoted (reflection, binding).
const ACCESSED = /(?:\.|\?\.)\s*([A-Za-z_]\w*)|[{,]\s*([A-Za-z_]\w*)\s*(?:=(?![=>])|:(?!:))|"([A-Za-z_]\w*)"/g;
const blank = (m) => m.replace(/[^\n]/g, ' ');

const BUILTIN = 'string|int|long|short|byte|bool|char|decimal|double|float|object|uint|ulong|ushort|sbyte|nint|nuint';
const TYPED = new RegExp(`(?<![\\w.@$])(${BUILTIN}|[A-Z]\\w*(?:\\s*\\.\\s*[A-Z]\\w*)*)(?:\\s*<[^;(){}=]*?>)?\\??(?:\\s*\\[[,\\s]*\\])*\\s+@?([A-Za-z_]\\w*)\\s*(?=[=;,):]|\\?(?![?.])|&&|\\|\\||=>|\\b(?:in|when|and|or)\\b|\\{\\s*(?:\\[[^\\]]*\\]\\s*)*(?:get|set|init)\\b)`, 'g');
const NOT_NAME = new Set(['in', 'is', 'as', 'when', 'and', 'or', 'new', 'return', 'await', 'out', 'ref']);
// `T`, `TEntity`: a generic parameter could be anything.
const GENERIC_PARAM = /^T(?:[A-Z]\w*)?$/;
const lastSeg = (t) => t.split(/\s*\.\s*/).pop();

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
function csharpAccess(lx, an, code) {
  const spans = an.types.map((t) => ({ name: t.name, a: t.startLine, b: t.endLine }));
  const enclosing = (off) => {
    const l = lx.lineOf(off);
    let best = null;
    for (const t of spans) if (t.a <= l && l <= t.b && (!best || t.b - t.a < best.b - best.a)) best = t;
    return best?.name ?? '';
  };
  const vars = new Map();
  const declare = (name, type) => {
    if (NOT_NAME.has(name)) return;
    if (!vars.has(name)) vars.set(name, new Set());
    vars.get(name).add(type && !GENERIC_PARAM.test(type) ? type : '');
  };
  for (const m of code.matchAll(TYPED)) declare(m[2], lastSeg(m[1]));
  for (const m of code.matchAll(/\bvar\s+@?(\w+)(\s*=\s*[^;]*)?/g)) {
    const rhs = m[2] ?? '';
    const t = /^\s*=\s*new\s+([A-Z][\w.]*)/.exec(rhs) ?? /^\s*=\s*\(\s*([A-Z][\w.]*)(?:<[^()]*>)?\s*\)\s*[\w(]/.exec(rhs) ?? /\bas\s+([A-Z][\w.]*)/.exec(rhs);
    declare(m[1], t ? lastSeg(t[1]) : '');
  }
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*=>/g)) declare(m[1], '');
  for (const m of code.matchAll(/\(\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*\)\s*=>/g)) for (const n of m[1].split(/\s*,\s*/)) declare(n, '');

  const acc = {};
  const calls = {};
  const bump = (member, recv) => {
    const o = (acc[member] ??= {});
    o[recv] = (o[recv] ?? 0) + 1;
  };
  const call = (type, weak, off) => {
    const c = (calls[type] ??= [0, 0, lx.lineOf(off) + 1]);
    c[0]++;
    if (weak) c[1] = 1;
  };
  const skip = new Set();
  // `new T { Member = ... }` assigns T's members.
  for (const m of code.matchAll(/\bnew\s+([A-Z][\w.]*)(?:\s*<[^;(){}=]*?>)?\s*(?:\([^()]*\))?\s*\{/g)) {
    const t = lastSeg(m[1]);
    const open = m.index + m[0].length - 1;
    const end = closeBrace(code, open);
    if (end < 0) continue;
    let d = 0;
    for (let i = open; i < end; i++) {
      if (code[i] === '{') d++;
      else if (code[i] === '}') d--;
      if (d === 1 && (code[i] === ',' || i === open)) {
        const im = /^\s*([A-Za-z_]\w*)\s*=(?![=>])/.exec(code.slice(i + 1, i + 200));
        if (im) { bump(im[1], t); skip.add(i + 1 + im[0].indexOf(im[1])); }
      }
    }
  }
  for (const m of code.matchAll(/\bnew\s+([A-Z][\w.]*)/g)) call(lastSeg(m[1]), false, m.index);
  for (const m of code.matchAll(/\??\.\s*([A-Za-z_]\w*)/g)) {
    const pre = code.slice(Math.max(0, m.index - 120), m.index);
    let weak = false;
    const typesOf = (n) => {
      const set = vars.get(n);
      if (!set) return [/^[A-Z]/.test(n) ? `~${n}` : ''];
      weak = set.size > 1;
      return [...set];
    };
    const self = /(?:^|[^\w.@$])this\s*\.\s*([A-Za-z_]\w*)\s*$/.exec(pre);
    const id = /([A-Za-z_]\w*)\s*$/.exec(pre);
    const own = /(?:^|[^\w.@$])this\s*$/.test(pre);
    let types;
    if (own) types = [enclosing(m.index)];
    else if (self) types = typesOf(self[1]);
    else if (!id || /\.\s*$/.test(pre.slice(0, id.index)) || /^(?:base|typeof|nameof)$/.test(id[1])) types = [''];
    else types = typesOf(id[1]);
    for (const t of types) {
      bump(m[1], t);
      if (own || !t) continue;
      if (t.startsWith('~')) call(t.slice(1), false, m.index);
      else call(t, weak || types.includes(''), m.index);
    }
  }
  for (const m of code.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*:(?!:)/g)) bump(m[1], '');
  for (const m of code.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*=(?![=>])/g)) if (!skip.has(m.index + m[0].indexOf(m[1]))) bump(m[1], '');
  // Interpolation holes and comments are blanked in `code`; what only the plain text shows is a possible use.
  for (const m of lx.plain.matchAll(ACCESSED)) if (code[m.index] !== lx.plain[m.index] && !m[3]) bump(m[1] ?? m[2], '');
  for (const m of lx.plain.matchAll(/"([A-Za-z_]\w*)"/g)) bump(m[1], '');
  return { acc, calls, enclosing };
}

/** Escape for use inside a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Names a C# file mentions, minus the types it declares, and the subset of those that are
 * only the declared type of a field/property whose name is never used (`declOnly`).
 * `declPublic` lists, per such name, the members not private to the file; `publicMembers` is
 * every attribute-injected member visible outside it (used or not); `words`/`accessed` are the
 * identifiers the file contains, `acc` its receiver-typed member accesses and `calls` its resolved
 * calls per type (see csharpAccess), so link can ask whether another file touches a public member.
 * @returns {{ refs: string[], declOnly: Record<string, string>, declPublic: Record<string, string[]>, publicMembers: string[], publicOwners: Record<string, string>, words: string[], acc: object, calls: object, typeBases: Record<string, string[]> }}
 */
export function csharpRefs(lx, an) {
  const code = lx.code.replace(USING_LINE, blank);
  const own = new Set(an.types.map((t) => t.name));
  const heads = new Map();
  const chains = new Set();
  const re = /(?<![\w.@$])([A-Z]\w*(?:\s*\.\s*[A-Z]\w*)*)/g;
  for (const m of code.matchAll(re)) {
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
  const access = csharpAccess(lx, an, code);
  const publicOwners = {};
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
      if (NAMEOF_BEFORE.test(before)) continue; // nameof(Tool) is a compile-time mention
      const after = code.slice(off + name.length, off + name.length + 200);
      const mm = AFTER_MEMBER.exec(after);
      if (mm && (ATTRIBUTED.test(before) || PRIVATE.test(before))) {
        members.add(mm[1]);
        if (NON_PRIVATE.test(MODS_TAIL.exec(before)[1])) { pub.add(mm[1]); publicMembers.add(mm[1]); publicOwners[mm[1]] = access.enclosing(off + name.length + mm[0].indexOf(mm[1])); }
        spans.push([off, off + name.length + mm[0].indexOf(mm[1]) + mm[1].length]);
        continue;
      }
      const pm = AFTER_PARAM.exec(after);
      if (pm && BEFORE_PARAM.test(before)) {
        params.add(pm[1]);
        spans.push([off, off + name.length + pm[0].indexOf(pm[1]) + pm[1].length]);
        continue;
      }
      ok = false;
      break;
    }
    if (!ok || !members.size) continue;
    // Usage is checked on the text with strings intact: interpolation holes (`{_member}`) count as uses.
    let masked = lx.plain.replace(USING_LINE, blank).replace(NAMEOF, blank);
    for (const [a, b] of spans) masked = masked.slice(0, a) + ' '.repeat(b - a) + masked.slice(b);
    // Constructor injection: `member = param;` (or `param ?? throw ...;`) keeps neither of them in use.
    masked = masked.replace(new RegExp(`(?:\\bthis\\s*\\.\\s*)?\\b(\\w+)\\s*=\\s*(\\w+)${GUARD}\\s*;`, 'g'), (all, l, r) => (members.has(l) && params.has(r) ? ' '.repeat(all.length) : all));
    const used = (n) => new RegExp(`\\b${esc(n)}\\b`).test(masked);
    if ([...params].some(used) || [...members].some(used)) continue;
    declOnly[name] = [...members].sort().join(', ');
    if (pub.size) declPublic[name] = [...pub].sort();
  }
  const refs = [...new Set([...heads.keys(), ...chains])].sort();
  const words = new Set(lx.plain.match(/[A-Za-z_]\w+/g));
  const typeBases = {};
  for (const t of an.types) typeBases[t.name] = [...new Set([...(typeBases[t.name] ?? []), ...t.extends, ...t.implements, ...t.bases])].sort();
  return { refs, declOnly, declPublic, publicMembers: [...publicMembers].sort(), publicOwners, words: [...words].sort(), acc: access.acc, calls: access.calls, typeBases };
}

/**
 * Link-side resolver for every C# module. `mods` maps path to its module fact; the result
 * answers, per file, which other files it uses at type level.
 */
export function csharpLinker(mods, sortedMods) {
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

  // Inheritance by simple name across the repository: a member reached through a base or a derived type is reached.
  const direct = new Map();
  for (const path of sortedMods) {
    const a = mods.get(path).attrs;
    if (a.language !== 'csharp') continue;
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

  // Public members that are held only by an injected declaration: which other files touch each name,
  // and through what? An access counts when its receiver's type is the declaring type, one related to
  // it by inheritance, or unresolved (name-only evidence). A bare read counts in a derived class.
  const candidates = new Set();
  for (const path of sortedMods) for (const ms of Object.values(mods.get(path).attrs.decl_public ?? {})) for (const m of ms) candidates.add(m);
  const touchedBy = new Map();
  const typeNames = new Set(byName.keys());
  if (candidates.size) {
    for (const path of sortedMods) {
      const a = mods.get(path).attrs;
      if (a.language !== 'csharp') continue;
      for (const n of Object.keys(a.acc ?? {})) if (candidates.has(n)) add(touchedBy, n, { path, recvs: Object.keys(a.acc[n]).sort() });
      for (const n of a.words ?? []) if (candidates.has(n) && !typeNames.has(n)) add(touchedBy, n, { path, bare: a.types ?? [] });
    }
  }
  /** 'typed', 'name-only' or null: how another file reaches `member`, declared by `owner` in `path`. */
  const reach = (path, member, owner) => {
    let best = null;
    for (const t of touchedBy.get(member) ?? []) {
      if (t.path === path) continue;
      for (const r of t.recvs ?? []) {
        if (r === '') best ??= 'name-only';
        else if (r.startsWith('~')) {
          if (!typeNames.has(r.slice(1))) best ??= 'name-only';
          else if (related(r.slice(1), owner)) return 'typed';
        } else if (related(r, owner)) return 'typed';
      }
      if ((t.bare ?? []).some((x) => x === owner || anc(x).has(owner))) return 'typed';
    }
    return best;
  };

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
    const hit = (to, spec, line, decl, member, pub = []) => {
      if (to === path) return;
      let h = hits.get(to);
      if (!h) hits.set(to, (h = { spec, line, decl: true, members: new Set(), pub: new Set() }));
      if (decl) { h.members.add(member); for (const m of pub) h.pub.add(m); }
      else h.decl = false;
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
    // A member another file reaches is an ordinary use, however the declaring file treats it.
    const owners = a.public_owners ?? {};
    const edges = [...hits].map(([to, h]) => {
      const reaches = h.decl && h.members.size ? [...h.pub].map((m) => reach(path, m, owners[m])) : [];
      const declared = h.decl && h.members.size && !reaches.some(Boolean);
      const nameOnly = h.decl && h.members.size && !reaches.includes('typed') && reaches.includes('name-only');
      return {
        to, spec: h.spec, line: h.line,
        ...(declared && { declared_only: true, unused_member: [...h.members].sort().join(', '), member_visibility: h.pub.size ? 'public' : 'private' }),
        ...(nameOnly && { use_evidence: 'name-only', possible_use_of: [...h.pub].filter((m, i) => reaches[i]).sort().join(', ') }),
      };
    });
    // Calls: members reached through a receiver whose type is declared in another repository file.
    const callTo = new Map();
    for (const [t, [n, weak, line]] of Object.entries(a.calls ?? {})) {
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
    const calls = [...callTo].map(([to, c]) => ({ to, ...c })).sort((x, y) => (x.to < y.to ? -1 : 1));
    return { edges, externals, calls };
  };
}
