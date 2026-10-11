// Shared, conservative import-resolution primitives. Language-specific syntax readers pass
// a normalized module specifier here; each row's resolution rule lives in the language registry.

import { language as languageRow } from '../../../runtime/graph/languages.mjs';

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
  const row = languageRow(language);
  const rule = row?.flatSibling;
  if (!rule || typeof spec !== 'string' || !spec || spec.includes(rule.separator) || !rule.segment.test(spec)) return null;
  const extension = row.extensions[0] ?? '';
  const hits = [...new Set(rule.candidates.map((pattern) => join(dirOf(importer), pattern.replace('{module}', spec).replace('{extension}', extension))).filter((path) => paths.has(path)))];
  return hits.length === 1 ? { path: hits[0], inferred: true, via: 'flat-sibling' } : null;
}
