// Clone-detection adapter (spec §11). Language-agnostic: each file is reduced to a token
// stream with comments and strings removed, identifiers collapsed to `I` and literals to
// `L` (so renamed copies still match), then k-gram hashes are thinned by winnowing so a
// shared region of any reasonable length yields at least one shared fingerprint. `link`
// compares fingerprints across files and reports clone ranges. It never reads files or
// runs anything; output is deterministic.

import { nodeFact, prov } from '../../runtime/graph/facts.mjs';

export const EXTRACTOR = 'quality@0.1.0';
const K = 25; // k-gram length in tokens
const WINDOW = 4; // winnowing window (guarantee: any shared run of K+WINDOW-1 tokens is detected)
const MAX_FINGERPRINTS = 2000;
const MAX_CLONES = 50;
const MAX_POSTINGS = 20; // a hash seen in more files than this is boilerplate, not a clone signal
const MIN_SHARED = 8;
const MIN_SHARED_RATIO = 0.3;
const MIN_RANGE_LINES = 6;
const MERGE_GAP = 1;

const C_LIKE = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'go', 'java', 'kt', 'kts', 'cs', 'rs', 'php', 'swift', 'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh']);

const KEYWORDS = new Set((
  'if else elif for foreach while do switch case default break continue return function def class interface struct enum trait impl '
  + 'import from export const let var val public private protected static final abstract async await try catch finally throw throws '
  + 'new this self super null nil None true false True False undefined in of is not and or yield lambda with as pass raise except '
  + 'fn func mod use pub match loop mut package namespace using extends implements override virtual readonly typeof instanceof '
  + 'delete void goto defer go select chan range fun object when unless until begin end rescue ensure module require elsif then'
).split(' '));

const extOf = (path) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '');

/** Which comment/string syntax family a file belongs to. */
function familyOf(ext) {
  if (ext === 'py') return 'python';
  if (ext === 'rb') return 'ruby';
  if (C_LIKE.has(ext)) return ext === 'rs' ? 'rust' : ext === 'php' ? 'php' : 'c';
  return null;
}

const isIdStart = (ch) => /[A-Za-z_$\u0080-￿]/.test(ch);
const isIdPart = (ch) => /[A-Za-z0-9_$\u0080-￿]/.test(ch);

/**
 * Tokenise to [{ t, line }]. `t` is `I`, `L`, a keyword or a single punctuation character.
 * Deliberately forgiving: an unterminated string or comment just runs to end of input.
 */
export function tokenize(text, family) {
  const toks = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const slashSlash = family !== 'python' && family !== 'ruby';
  const hashComment = family === 'python' || family === 'ruby' || family === 'php';
  const push = (t, ln) => toks.push({ t, line: ln });
  const skipTo = (end) => {
    // Consume up to and including `end`, counting newlines; end of input if not found.
    const at = text.indexOf(end, i);
    const stop = at === -1 ? n : at + end.length;
    for (let j = i; j < stop; j++) if (text.charCodeAt(j) === 10) line++;
    i = stop;
  };
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (slashSlash && ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (slashSlash && ch === '/' && text[i + 1] === '*') { i += 2; skipTo('*/'); continue; }
    if (hashComment && ch === '#' && !(family === 'php' && text[i + 1] === '[')) { while (i < n && text[i] !== '\n') i++; continue; }
    if (family === 'ruby' && ch === '=' && text.startsWith('=begin', i) && (i === 0 || text[i - 1] === '\n')) { skipTo('\n=end'); continue; }
    if (family === 'python' && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3);
      const startLine = line;
      i += 3;
      skipTo(q);
      push('L', startLine);
      continue;
    }
    if (ch === '"' || ch === '`' || (ch === "'" && family !== 'rust')) {
      const startLine = line;
      const multi = ch === '`';
      i++;
      while (i < n && text[i] !== ch) {
        if (text[i] === '\\') i++;
        else if (text[i] === '\n') { if (!multi) break; line++; }
        i++;
      }
      i++;
      push('L', startLine);
      continue;
    }
    if (ch === "'") {
      // Rust: a char literal is 'x' or '\x..'; anything else is a lifetime and just punctuation.
      const m = /^'(\\.[^']*|[^\\'])'/.exec(text.slice(i, i + 12));
      if (m) { push('L', line); i += m[0].length; } else { push("'", line); i++; }
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      while (i < n && /[0-9A-Za-z_.]/.test(text[i])) i++;
      push('L', line);
      continue;
    }
    if (isIdStart(ch)) {
      const s = i;
      while (i < n && isIdPart(text[i])) i++;
      const word = text.slice(s, i);
      push(KEYWORDS.has(word) ? word : 'I', line);
      continue;
    }
    push(ch, line);
    i++;
  }
  return toks;
}

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const BASE = 1000003;

/** Winnowed k-gram fingerprints: [[hash, startLine, endLine], ...] in position order. */
export function fingerprint(tokens, k = K, window = WINDOW) {
  if (tokens.length < k) return { fingerprints: [], lines: tokens.length ? tokens[tokens.length - 1].line : 0 };
  const ids = tokens.map((x) => hashString(x.t));
  let pow = 1;
  for (let i = 0; i < k - 1; i++) pow = Math.imul(pow, BASE);
  const hashes = [];
  let h = 0;
  for (let i = 0; i < k; i++) h = (Math.imul(h, BASE) + ids[i]) | 0;
  hashes.push(h >>> 0);
  for (let i = k; i < ids.length; i++) {
    h = (Math.imul((h - Math.imul(ids[i - k], pow)) | 0, BASE) + ids[i]) | 0;
    hashes.push(h >>> 0);
  }
  const picked = [];
  let last = -1;
  const w = Math.min(window, hashes.length);
  for (let s = 0; s + w <= hashes.length; s++) {
    let min = s;
    for (let j = s + 1; j < s + w; j++) if (hashes[j] <= hashes[min]) min = j; // rightmost minimum
    if (min !== last) { picked.push(min); last = min; }
  }
  return {
    fingerprints: picked.map((p) => [hashes[p], tokens[p].line, tokens[p + k - 1].line]),
    lines: tokens[tokens.length - 1].line,
  };
}

const isTestPath = (p) => /(^|\/)(tests?|__tests__|spec|specs)\/|(\.|_)(test|spec)\.[a-z]+$|(^|\/)test_[^/]*$/.test(p);

function covered(ranges) {
  const set = new Set();
  for (const [s, e] of ranges) for (let l = s; l <= e; l++) set.add(l);
  return set.size;
}

/** Merge k-gram matches [sa, ea, sb, eb] into maximal clone ranges. */
function mergeMatches(matches) {
  const sorted = [...matches].sort((x, y) => x[0] - y[0] || x[2] - y[2] || x[1] - y[1] || x[3] - y[3]);
  const merged = [];
  for (const m of sorted) {
    let target = null;
    for (const r of merged) {
      if (m[0] <= r[1] + MERGE_GAP && m[2] <= r[3] + MERGE_GAP && m[2] >= r[2] - MERGE_GAP) { target = r; break; }
    }
    if (target) {
      target[1] = Math.max(target[1], m[1]);
      target[3] = Math.max(target[3], m[3]);
      target[2] = Math.min(target[2], m[2]);
    } else merged.push([...m]);
  }
  return merged.filter((r) => r[1] - r[0] + 1 >= MIN_RANGE_LINES && r[3] - r[2] + 1 >= MIN_RANGE_LINES);
}

export default {
  id: 'quality',
  version: '0.1.0',
  kind: 'language',
  capabilities: {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,go,java,kt,kts,cs,rs,rb,php,swift,scala,c,h,cc,cpp,cxx,hpp,hh}'],
    executes: [],
    network: false,
  },

  extract(file, text) {
    if (file.kind === 'generated' || file.kind === 'vendored' || file.kind === 'binary') return [];
    const family = familyOf(extOf(file.path));
    if (!family) return [];
    const { fingerprints, lines } = fingerprint(tokenize(text, family));
    const truncated = fingerprints.length > MAX_FINGERPRINTS;
    const attrs = { fingerprints: fingerprints.slice(0, MAX_FINGERPRINTS), fp_lines: lines };
    if (truncated) attrs.fp_truncated = { dropped: fingerprints.length - MAX_FINGERPRINTS, cap: MAX_FINGERPRINTS };
    return [nodeFact('module', file.path, { name: file.path, path: file.path, attrs }, prov({
      source_type: 'ast', source_ref: `${file.path}:1`, extractor: EXTRACTOR, confidence: 'medium',
    }))];
  },

  link(ctx) {
    const mods = [];
    for (const [path, facts] of [...(ctx.factsByFile ?? new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const f = facts.find((x) => x.kind === 'node' && x.type === 'module' && x.provenance?.extractor === EXTRACTOR && Array.isArray(x.attrs?.fingerprints));
      if (!f || !f.attrs.fingerprints.length) continue;
      const kind = ctx.files?.get?.(path)?.kind;
      if (kind === 'generated' || kind === 'vendored') continue;
      mods.push({ path, fps: f.attrs.fingerprints, lines: f.attrs.fp_lines ?? 0, test: kind === 'test' || (kind == null && isTestPath(path)) });
    }

    const postings = new Map();
    mods.forEach((m, mi) => m.fps.forEach((fp, fi) => {
      const list = postings.get(fp[0]);
      if (list) list.push([mi, fi]); else postings.set(fp[0], [[mi, fi]]);
    }));

    const pairs = new Map(); // "i,j" -> Map of "fi,fj" -> [sa,ea,sb,eb]
    for (const list of postings.values()) {
      if (list.length < 2 || list.length > MAX_POSTINGS) continue;
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const [mi, fi] = list[x];
          const [mj, fj] = list[y];
          if (mi === mj) continue;
          const [a, fa, b, fb] = mi < mj ? [mi, fi, mj, fj] : [mj, fj, mi, fi];
          if (mods[a].test && mods[b].test) continue; // test-to-test repetition is idiomatic
          const key = `${a},${b}`;
          if (!pairs.has(key)) pairs.set(key, new Map());
          const fpA = mods[a].fps[fa];
          const fpB = mods[b].fps[fb];
          pairs.get(key).set(`${fa},${fb}`, [fpA[1], fpA[2], fpB[1], fpB[2]]);
        }
      }
    }

    const clones = new Map(); // module index -> clone entries
    const add = (idx, entry) => {
      if (!clones.has(idx)) clones.set(idx, []);
      clones.get(idx).push(entry);
    };
    for (const key of [...pairs.keys()].sort()) {
      const [a, b] = key.split(',').map(Number);
      const matches = [...pairs.get(key).values()];
      const smaller = Math.min(mods[a].fps.length, mods[b].fps.length);
      if (matches.length < MIN_SHARED && !(matches.length >= 3 && matches.length >= MIN_SHARED_RATIO * smaller)) continue;
      const ranges = mergeMatches(matches);
      if (!ranges.length) continue;
      const covA = covered(ranges.map((r) => [r[0], r[1]]));
      const covB = covered(ranges.map((r) => [r[2], r[3]]));
      const denom = Math.max(1, Math.min(mods[a].lines, mods[b].lines));
      const similarity = Math.min(1, +(Math.min(covA, covB) / denom).toFixed(3));
      add(a, { other: mods[b].path, similarity, lines: covA, ranges });
      add(b, { other: mods[a].path, similarity, lines: covB, ranges: ranges.map((r) => [r[2], r[3], r[0], r[1]]) });
    }

    const out = [];
    for (const idx of [...clones.keys()].sort((x, y) => x - y)) {
      const list = clones.get(idx)
        .sort((x, y) => y.lines - x.lines || (x.other < y.other ? -1 : 1))
        .slice(0, MAX_CLONES);
      const m = mods[idx];
      out.push(nodeFact('module', m.path, { name: m.path, path: m.path, attrs: { clones: list } }, prov({
        source_type: 'inference', source_ref: `${m.path}:${list[0].ranges[0][0]}`, extractor: EXTRACTOR, confidence: 'medium',
      })));
    }
    return out;
  },
};
