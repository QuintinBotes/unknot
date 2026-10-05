// C# dependencies at type level. Extraction records which PascalCase names (and dotted
// chains) a file mentions plus which of them are only the declared type of an unused
// field or property; linking resolves those names through the namespaces visible to the
// file (own and ancestors, `using`, `global using` anywhere, aliases, `using static`).
// A `using` alone never links anything, so nothing fans out to a whole namespace.

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
const blank = (m) => m.replace(/[^\n]/g, ' ');

/** Escape for use inside a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Names a C# file mentions, minus the types it declares, and the subset of those that are
 * only the declared type of a field/property whose name is never used (`declOnly`).
 * @returns {{ refs: string[], declOnly: Record<string, string> }}
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
  for (const [name, offs] of heads) {
    // Qualified mentions of the same simple name are ordinary uses.
    const members = new Set();
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
  }
  const refs = [...new Set([...heads.keys(), ...chains])].sort();
  return { refs, declOnly };
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
    const hit = (to, spec, line, decl, member) => {
      if (to === path) return;
      let h = hits.get(to);
      if (!h) hits.set(to, (h = { spec, line, decl: true, members: new Set() }));
      if (decl) h.members.add(member);
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
      for (const e of es) hit(e.path, `${e.ns}.${name}`, usings.get(e.ns) ?? 1, ref in declOnly, declOnly[ref]);
    }
    for (const s of statics) for (const p of full.get(s.spec) ?? []) hit(p, s.spec, s.line, false);
    const edges = [...hits].map(([to, h]) => ({
      to, spec: h.spec, line: h.line,
      ...(h.decl && h.members.size && { declared_only: true, unused_member: [...h.members].sort().join(', ') }),
    }));
    return { edges, externals };
  };
}
