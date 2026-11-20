// Which declarations a file's build lets it see (#71). A file belongs to the project whose
// manifest directory is its nearest ancestor, and to every project that compiles it as a linked
// file. A reference from project P may link only to a declaration in P or in a project P reaches
// through project references, and only to a type the language does not hide from P (a C#
// `internal` or Kotlin `internal` type outside its project unless the project names P as a friend
// assembly; a Java package-private type outside its package). A file in no project, or in a
// project whose file could not be read, keeps plain name matching.

import { languagesForEcosystem, language } from '../../../runtime/graph/languages.mjs';

// shortcut: only .NET project references are trusted to be complete. Maven and Gradle declare
// module dependencies in ways the manifest readers do not follow (property-substituted group ids,
// inherited parent dependencies, Gradle accessors and convention plugins), so cutting edges by them
// would drop real dependencies; their projects still hide `internal` types. Add an ecosystem here
// once its reader follows every form of module dependency it allows.
const CLOSED = new Set(['dotnet']);

/**
 * @param {object[]} units package facts (one per project manifest)
 * @param {Map<string, object[]>} dependsOn package id → packages it references
 * @param {Map<string, object>} mods path → module fact
 * @param {Map<string, object[]>} types type name → class/interface facts
 */
export function buildGraph(units, dependsOn, mods, types) {
  const byDepth = [...units].sort((a, b) => b.attrs.dir.length - a.attrs.dir.length || a.id.localeCompare(b.id));
  const compat = new Map();
  const fits = (p, lang) => {
    if (!compat.has(p.attrs.ecosystem)) compat.set(p.attrs.ecosystem, languagesForEcosystem(p.attrs.ecosystem));
    return compat.get(p.attrs.ecosystem).includes(lang);
  };
  const unitCache = new Map();
  const unitsOf = (path) => {
    if (unitCache.has(path)) return unitCache.get(path);
    const lang = mods.get(path)?.attrs.language;
    const own = byDepth.find((p) => fits(p, lang) && (p.attrs.dir === '' || path.startsWith(`${p.attrs.dir}/`)));
    const linked = units.filter((p) => p !== own && fits(p, lang) && p.attrs.compile_includes?.includes(path));
    const out = own ? [own, ...linked] : linked;
    unitCache.set(path, out);
    return out;
  };
  const open = (q) => !CLOSED.has(q.attrs.ecosystem) || q.attrs.parse_error || q.attrs.references_unresolved;
  // Projects each project reaches; null when a project on the way is open (its references unknown).
  const reachCache = new Map();
  const reach = (p) => {
    if (reachCache.has(p.id)) return reachCache.get(p.id);
    let out = new Set([p.id]);
    const queue = [p];
    while (queue.length) {
      const q = queue.shift();
      if (open(q)) { out = null; break; }
      for (const r of dependsOn.get(q.id) ?? []) if (!out.has(r.id)) { out.add(r.id); queue.push(r); }
    }
    reachCache.set(p.id, out);
    return out;
  };
  const assembly = (p) => (p.attrs.assembly ?? p.name).toLowerCase();
  const friends = new Map();
  for (const p of units) friends.set(p.id, new Set((p.attrs.internals_visible_to ?? []).map((n) => n.toLowerCase())));
  for (const [path, m] of mods) {
    for (const n of m.attrs.internals_visible_to ?? []) for (const p of unitsOf(path)) friends.get(p.id)?.add(n.toLowerCase());
  }
  // A type is hidden when no declaration of it in the project says public (a partial type's other parts inherit it).
  const nonPublic = new Map();
  const hiddenIn = (q, name, p) => {
    const k = `${q.id}|${name}`;
    if (!nonPublic.has(k)) {
      const decls = (types.get(name) ?? []).filter((t) => unitsOf(t.path).includes(q));
      nonPublic.set(k, decls.length > 0 && !decls.some((t) => t.attrs.exported));
    }
    return nonPublic.get(k) && !friends.get(q.id).has(assembly(p));
  };

  const rejected = new Map(); // from → targets a reference was refused
  const unread = units.filter((p) => CLOSED.has(p.attrs.ecosystem) && open(p)).map((p) => p.attrs.manifest).sort();
  /** Whether a reference to `name` (when known) from file `from` may link to a declaration in file `to`. */
  const allowed = (from, to, name) => {
    if (from === to) return true;
    const rule = language(mods.get(to)?.attrs.language)?.genericSyntax.nonPublic;
    const ok = (() => {
      if (rule === 'package' && name) {
        const decls = (types.get(name) ?? []).filter((t) => t.path === to);
        if (decls.length && !decls.some((t) => t.attrs.exported) && mods.get(from).attrs.package !== mods.get(to).attrs.package) return false;
      }
      const fu = unitsOf(from);
      const tu = unitsOf(to);
      if (!fu.length || !tu.length) return true;
      return fu.some((p) => tu.some((q) => {
        if (p === q) return true;
        const r = reach(p);
        if (r && !r.has(q.id)) return false;
        return !(rule === 'unit' && name && hiddenIn(q, name, p));
      }));
    })();
    if (!ok) (rejected.get(from) ?? rejected.set(from, new Set()).get(from)).add(to);
    return ok;
  };
  return { allowed, rejected, unread };
}
