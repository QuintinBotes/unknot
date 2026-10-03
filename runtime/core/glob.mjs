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

/** Include/exclude scope test. Empty include means everything. Exclude always wins. */
export function inScope(path, { include = [], exclude = [] } = {}) {
  if (matchAny(path, exclude)) return false;
  return include.length === 0 || matchAny(path, include);
}
