// Shared, conservative import-resolution primitives. Language-specific syntax readers pass
// a normalized module specifier here; the resolution rule is data, so adding a language does
// not add another conditional to a linker.

const FLAT_SIBLING_RULES = Object.freeze({
  // A script may put its own directory on sys.path. That makes `from proc import run`
  // reach `proc.py` beside the importing file, but it is not guaranteed for every launch
  // mode, so callers must retain the `inferred` provenance returned below.
  python: Object.freeze({
    separator: '.',
    segment: /^[A-Za-z_]\w*$/,
    candidates: Object.freeze(['{module}.py', '{module}/__init__.py']),
  }),
});

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (dir, path) => (dir ? `${dir}/${path}` : path);

/**
 * Resolve a single-segment import against sibling module layouts declared above.
 *
 * This deliberately returns no target when two local layouts match. Picking one would turn
 * a lexical guess into a false internal dependency; callers can still retain the external
 * import fact. A unique sibling is still inferred because the runtime search path is outside
 * the repository evidence available here.
 *
 * @param {string} language normalized language id
 * @param {string} importer repository-relative importing path
 * @param {string} spec normalized import module specifier
 * @param {Set<string>} paths repository-relative candidate module paths
 * @returns {{path: string, inferred: true, via: 'flat-sibling'} | null}
 */
export function resolveFlatSiblingImport(language, importer, spec, paths) {
  const rule = FLAT_SIBLING_RULES[language];
  if (!rule || typeof spec !== 'string' || !spec || spec.includes(rule.separator) || !rule.segment.test(spec)) return null;
  const hits = [...new Set(rule.candidates.map((pattern) => join(dirOf(importer), pattern.replace('{module}', spec))).filter((path) => paths.has(path)))];
  return hits.length === 1 ? { path: hits[0], inferred: true, via: 'flat-sibling' } : null;
}

export { FLAT_SIBLING_RULES };
