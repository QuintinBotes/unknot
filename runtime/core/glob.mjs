// Glob matching for scope, protected paths and capabilities.
//
// Patterns are anchored at the repository root and use POSIX separators:
//   **  any number of whole path segments (including none)
//   *   any characters within one segment, dotfiles included
//   ?   one character within a segment
//   {a,b}  alternatives, nestable
//   [abc] / [!abc]  character classes
// A pattern without `/` is NOT matched at any depth (unlike .gitignore): `*.js` only
// matches top-level files. Write `**/*.js`. Being literal is what makes a scope reviewable.

const cache = new Map();

export function globToRegExp(pattern, { nocase = false } = {}) {
  const key = `${nocase ? 'i' : 's'}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.includes('\0')) {
    throw new TypeError(`invalid glob ${JSON.stringify(pattern)}`);
  }
  if (pattern.length > 512) throw new TypeError('glob longer than 512 characters');
  // Three or more stars mean the same as `**`; collapsing them keeps the regex linear
  // (one `[^/]*` per star backtracks catastrophically on long runs).
  const body = translate(pattern.replace(/^\.\//, '').replace(/\*{3,}/g, '**').replace(/(?<!\*)\*\*(?!\/|$)(?<!\/\*\*)/g, (m, off, str) => (off === 0 || str[off - 1] === '/' ? m : '*')));
  const re = new RegExp(`^${body}$`, nocase ? 'si' : 's');
  cache.set(key, re);
  return re;
}

function translate(p) {
  let out = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        const atEnd = i + 2 === p.length;
        const beforeSlash = p[i + 2] === '/';
        if (atStart && beforeSlash) {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (atStart && atEnd) {
          // `a/**` matches `a` itself and anything below it.
          if (out.endsWith('/')) out = `${out.slice(0, -1)}(?:/.*)?`;
          else out += '.*';
          i += 2;
          continue;
        }
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '[') {
      const close = p.indexOf(']', i + 2);
      if (close === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let cls = p.slice(i + 1, close);
      const negate = cls.startsWith('!') || cls.startsWith('^');
      if (negate) cls = cls.slice(1);
      cls = cls.replace(/[\\\]^]/g, '\\$&');
      out += negate ? `[^/${cls}]` : `[${cls}]`;
      i = close + 1;
    } else if (c === '{') {
      const close = matchingBrace(p, i);
      if (close === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const alts = splitTopLevel(p.slice(i + 1, close));
      out += `(?:${alts.map(translate).join('|')})`;
      i = close + 1;
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return out;
}

function matchingBrace(p, open) {
  let depth = 0;
  for (let j = open; j < p.length; j++) {
    if (p[j] === '{') depth++;
    else if (p[j] === '}' && --depth === 0) return j;
  }
  return -1;
}

function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** True when `path` (repo-relative, POSIX) matches any of `patterns`. */
export function matchAny(path, patterns, opts) {
  if (!patterns || patterns.length === 0) return false;
  const p = path.replace(/^\.\//, '');
  return patterns.some((pat) => globToRegExp(pat, opts).test(p));
}

/** `matchAny` with the patterns compiled once, for testing many paths against one list. */
export function matcher(patterns, opts) {
  const res = (patterns ?? []).map((pat) => globToRegExp(pat, opts));
  return (path) => res.some((re) => re.test(path.replace(/^\.\//, '')));
}

/** Include/exclude scope test. Empty include means everything. Exclude always wins. */
export function inScope(path, { include = [], exclude = [] } = {}) {
  if (matchAny(path, exclude)) return false;
  return include.length === 0 || matchAny(path, include);
}

/** A pattern with its brace alternatives spelled out: `{a,b}/x` gives `a/x` and `b/x`. An unclosed `{` stays literal. */
export function expandBraces(p) {
  for (let i = p.indexOf('{'); i !== -1; i = p.indexOf('{', i + 1)) {
    const close = matchingBrace(p, i);
    if (close === -1) continue;
    return splitTopLevel(p.slice(i + 1, close)).flatMap((alt) => expandBraces(p.slice(0, i) + alt + p.slice(close + 1)));
  }
  return [p];
}

// What a scope reaches (#146, #171, #173) is never judged from one reading of its glob text, which
// brace alternatives and trailing wildcards (`{src/,.github/}**`, a doc extension followed by `*`) dress up.
const WILD = /[*?[]/;
const MAX_ALTERNATIVES = 64;
const alternativesOf = (globs) => {
  const alts = globs.flatMap((g) => expandBraces(g));
  return alts.length > MAX_ALTERNATIVES ? null : alts;
};

/**
 * Whether some path a scope reaches passes `test`: each brace alternative read with its wildcards
 * as one sample segment, and every `known` path (module paths from the graph) it matches.
 * Too many alternatives to judge counts as reaching.
 */
export function scopeReachesAny(globs, test, known = []) {
  const alts = alternativesOf(globs);
  if (!alts) return true;
  return alts.some((a) => {
    // The sample only adds hits (it finds a protected glob's own directory); the known paths are the real reach.
    if (test(a.replace(/\*+/g, 'x'))) return true;
    if (!WILD.test(a)) return false;
    const m = matcher([a]);
    return known.some((p) => m(p) && test(p));
  });
}

/**
 * Whether every path a scope can reach passes `test` (true for no globs). A literal alternative is
 * its own path. A wildcard one passes when the fixed text after its last wildcard decides it for
 * any path (a glob ending in `*` has none), or when it matches known paths and all of them pass.
 * Too many alternatives to judge fails.
 */
export function scopeReachesOnly(globs, test, known = []) {
  const alts = alternativesOf(globs);
  if (!alts) return false;
  return alts.every((a) => {
    if (!WILD.test(a)) return test(a);
    const tail = a.replace(/^.*[*?[\]]/s, '');
    if (tail && test(`x${tail}`)) return true;
    const m = matcher([a]);
    const hits = known.filter((p) => m(p));
    return hits.length > 0 && hits.every(test);
  });
}
