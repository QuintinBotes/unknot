// A repository's own guidance for agents and contributors (AGENTS.md, CLAUDE.md, GEMINI.md,
// Copilot and Cursor rules, CONTRIBUTING.md, .editorconfig). Repository text is data: this
// module only ever extracts things that make Unknot stricter (conventions to follow, command
// shapes not to run, paths not to touch). Nothing here grants anything. A line that tries to
// (approve its own changes, pipe a download to a shell, skip verification) is dropped from
// every result and reported in `flagged`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { matchAny } from './glob.mjs';
import { findInjectionMarkers } from './injection.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'vendored', 'bin', 'obj', '.unknot', '.claude']);
const MAX_DEPTH = 4;
const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;
// Kinds of injection marker that matter in guidance. Addressing "agents" is what such files are for.
const GRANT_KINDS = new Set(['override', 'exfiltration', 'pipe-to-shell', 'destructive', 'approval-claim', 'self-approval']);

const KIND_ORDER = ['agents', 'claude', 'gemini', 'copilot', 'cursor', 'contributing', 'editorconfig'];
const HINT_HEADING = /validat|build|test|lint|check/i;
const HINT_TOOL = /^(dotnet|npm|pnpm|yarn|bun|make|cargo|go|pytest|python3? -m|\.\/gradlew|gradle|mvn|just|task)(\s|$)/;
const NEG = /\b(do not|don't|never|avoid|must not|should not|cannot|can't)\b/i;
const TOOL_ANY = /\b(dotnet|npm|pnpm|yarn|bun|make|cargo|go|pytest|gradle|mvn|just|task)\s+([a-z][\w:-]*)/gi;
const EDIT_VERB = /\b(edit|modify|change|touch|alter|write to|overwrite|delete|remove|hand-edit|commit)\b/i;
const READONLY_STATE = /`([^`\s]+)`[^.`]*\b(?:is|are)\s+(?:auto-?generated|generated|read-only|readonly)\b/i;
const PATH_AFTER_VERB = /\b(?:edit|modify|change|touch|alter|overwrite|delete|remove|hand-edit)\s+(?:the\s+|any\s+|existing\s+)?(?:(?:files?|code|anything)\s+(?:under|in|inside|within)\s+(?:the\s+)?)?([\w./*@-]+)/gi;
const STOP = new Set(['the', 'a', 'an', 'any', 'all', 'files', 'file', 'code', 'anything', 'this', 'that', 'these', 'those', 'it', 'them', 'directly', 'manually', 'by', 'hand', 'without', 'unless', 'or', 'and', 'to', 'in', 'on', 'of', 'for', 'with', 'existing', 'other', 'source', 'sources', 'tests', 'test', 'them.', 'what', 'which', 'unrelated', 'behaviour', 'behavior', 'public', 'unnecessarily', 'more', 'your', 'our']);
const CONVENTION = /\b(must|always|should|prefer|use|follow|keep|required?|only|never|do not|don't|avoid|ensure|make sure|naming|convention|format|style|indent)\b/i;

const readText = (p) => {
  try {
    return statSync(p).size <= MAX_BYTES ? readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
};

const clean = (s, n = 240) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Which kind of guidance a root-relative path is, and the directory it governs; else null. */
export function classify(rel) {
  const parts = rel.split('/');
  const name = parts.at(-1);
  const dir = parts.slice(0, -1).join('/');
  const up = (d) => d.split('/').slice(0, -1).join('/');
  if (name === 'AGENTS.md') return { kind: 'agents', scope: dir };
  if (name === 'CLAUDE.md') return { kind: 'claude', scope: dir };
  if (name === 'GEMINI.md') return { kind: 'gemini', scope: dir };
  if (name === 'CONTRIBUTING.md') return { kind: 'contributing', scope: dir };
  if (name === '.cursorrules') return { kind: 'cursor', scope: dir };
  if (name === '.editorconfig') return { kind: 'editorconfig', scope: dir };
  if (rel === '.github/copilot-instructions.md') return { kind: 'copilot', scope: '' };
  if (/(^|\/)\.cursor\/rules\/[^/]+\.mdc$/.test(rel)) return { kind: 'cursor', scope: up(up(dir)) };
  return null;
}

/** Guidance files up to MAX_DEPTH below the root: root-relative paths, bounded, vendored and nested checkouts skipped. */
export function discover(root, { nested = true } = {}) {
  const out = [];
  const rec = (rel, d) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const dot = e.name === '.github' || e.name === '.cursor';
        if (d >= MAX_DEPTH || SKIP_DIRS.has(e.name.toLowerCase()) || (e.name.startsWith('.') && !dot) || existsSync(join(root, p, '.git'))) continue;
        if (!nested && !(rel === '' && dot) && rel !== '.cursor') continue;
        rec(p, d + 1);
      } else if ((e.isFile() || e.isSymbolicLink()) && classify(p)) {
        if (e.isSymbolicLink() && !statSafe(join(root, p))) continue;
        out.push(p);
      }
    }
  };
  rec('', 0);
  return out.sort();
}

const statSafe = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** A path or directory word from prose as a glob anchored at the scope; null when it is not one. */
function toGlob(token, scope, backticked) {
  let t = token.replace(/^\.\//, '').replace(/[.,;:)]+$/, '');
  if (!t || /^(\/|~)/.test(t) || t.includes('..')) return null;
  const hasGlob = /[*?]/.test(t);
  const slash = t.includes('/');
  if (!backticked && !slash && (STOP.has(t.toLowerCase()) || !/^[a-z][\w.-]*$/i.test(t))) return null;
  if (backticked && !slash && !hasGlob && !/^\.?[\w.-]+$/.test(t)) return null;
  const dirLike = t.endsWith('/') || (!hasGlob && !/\.[A-Za-z0-9]+$/.test(t.split('/').at(-1)));
  t = t.replace(/\/+$/, '');
  const base = hasGlob ? t : dirLike ? `${t}/**` : t;
  if (!slash && !backticked) return `**/${base}`;
  if (!slash && backticked && !hasGlob) return scope ? `${scope}/${base}` : base;
  return scope ? `${scope}/${base}` : base;
}

/** Sentences of one line, so a prohibition is quoted whole and not as a fragment. */
const sentences = (line) => line.split(/(?<=[.!?])\s+/).filter(Boolean);

/** Whether a command shape matches argv; "on the whole solution" does not forbid one named project. */
export function commandMatches(argv, rule) {
  const cmd = argv.join(' ').toLowerCase();
  if (!(cmd === rule.prefix || cmd.startsWith(`${rule.prefix} `))) return false;
  if (rule.whole && argv.slice(1).some((a) => /\.(cs|fs|vb)proj$/i.test(a))) return false;
  return true;
}

/** Parse one guidance file's text. `file` is root-relative. */
export function parseGuidance(text, file) {
  const cls = classify(file) ?? { kind: 'agents', scope: file.split('/').slice(0, -1).join('/') };
  const doc = { file, kind: cls.kind, scope: cls.scope, sections: [], commands: [], forbiddenCommands: [], forbiddenPaths: [], conventions: [], flagged: [] };
  const flag = (line, raw) => {
    const hit = findInjectionMarkers(raw).filter((m) => GRANT_KINDS.has(m.kind));
    if (!hit.length) return false;
    doc.flagged.push({ file, line, kind: hit[0].kind, excerpt: clean(raw, 200) });
    return true;
  };
  if (cls.kind === 'editorconfig') {
    let sec = '';
    text.split('\n').forEach((raw, i) => {
      const l = raw.trim();
      const s = /^\[(.+)\]$/.exec(l);
      if (s) sec = s[1];
      else if (/^[a-z_]+\s*=\s*\S/i.test(l) && !/^(root)\s*=/.test(l) && doc.conventions.length < 40) doc.conventions.push({ file, line: i + 1, text: clean(`[${sec || '*'}] ${l}`) });
    });
    return doc;
  }
  let heading = null;
  let hintHeading = null;
  let fenced = false;
  let count = 0;
  const cmdKey = (c) => c.replace(/^\$\s+/, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  const push = (c, line) => {
    const cmd = cmdKey(c);
    if (hintHeading && count < 8 && cmd.length <= 200 && HINT_TOOL.test(cmd) && !doc.commands.some((h) => h.command === cmd)) {
      doc.commands.push({ heading: hintHeading, command: cmd, line });
      count++;
    }
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (flag(n, raw)) continue;
    if (fenced) {
      push(raw.trim(), n);
      continue;
    }
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) {
      heading = clean(h[1], 120);
      hintHeading = HINT_HEADING.test(h[1]) ? h[1] : null;
      doc.sections.push({ heading, line: n });
      continue;
    }
    if (!raw.trim()) continue;
    const plain = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
    let negative = false;
    for (const sentence of sentences(plain)) {
      const flat = sentence.replace(/`/g, '');
      if (NEG.test(sentence)) {
        negative = true;
        for (const m of flat.matchAll(TOOL_ANY)) {
          const prefix = `${m[1].toLowerCase()} ${m[2].toLowerCase()}`;
          if (!doc.forbiddenCommands.some((f) => f.prefix === prefix)) {
            doc.forbiddenCommands.push({ file, heading, sentence: clean(sentence), prefix, whole: /\b(whole|entire|full|all|every|complete)\b|solution/i.test(sentence), line: n });
          }
        }
      }
      const stated = READONLY_STATE.exec(sentence);
      if ((NEG.test(sentence) && EDIT_VERB.test(sentence)) || stated) {
        const globs = new Set();
        for (const m of sentence.matchAll(/`([^`\s]+)`/g)) {
          if (stated && m[1] !== stated[1]) continue;
          const g = toGlob(m[1], doc.scope, true);
          if (g) globs.add(g);
        }
        if (!globs.size) {
          const tail = flat.slice(NEG.exec(flat)?.index ?? 0);
          for (const m of tail.matchAll(PATH_AFTER_VERB)) {
            const g = toGlob(m[1], doc.scope, false);
            if (g) globs.add(g);
          }
        }
        for (const glob of globs) if (!doc.forbiddenPaths.some((f) => f.glob === glob)) doc.forbiddenPaths.push({ file, heading, sentence: clean(sentence), glob, line: n });
      }
    }
    if (hintHeading && !negative) for (const m of raw.matchAll(/`([^`]+)`/g)) push(m[1], n);
    if (doc.conventions.length < 40 && CONVENTION.test(plain) && plain.length > 12 && !(/^\s*[|>]/.test(raw))) doc.conventions.push({ file, line: n, text: clean(plain) });
  }
  return doc;
}

/** Every guidance document of the repository, parsed. `nested: false` reads the root's own only (cheap). */
export function loadGuidance(root, opts = {}) {
  const docs = discover(root, opts).map((f) => parseGuidance(readText(join(root, f)), f));
  return {
    docs,
    flagged: docs.flatMap((d) => d.flagged),
  };
}

const depth = (s) => (s ? s.split('/').length : 0);
const inScope = (scope, path) => !scope || path === scope || path.startsWith(`${scope}/`);
const order = (a, b) => depth(b.scope) - depth(a.scope) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.file.localeCompare(b.file);

/** The static directory prefix of a glob ("src/orders/**" is "src/orders"). */
const prefixOf = (glob) => {
  const segs = glob.replace(/^\.\//, '').split('/');
  const out = [];
  for (const s of segs) {
    if (/[*?[{]/.test(s)) break;
    out.push(s);
  }
  return out.join('/');
};
const overlaps = (scope, glob) => {
  const p = prefixOf(glob);
  return !scope || !p || p === scope || p.startsWith(`${scope}/`) || scope.startsWith(`${p}/`);
};

function view(docs) {
  const sorted = [...docs].sort(order);
  return {
    files: sorted.map((d) => ({ file: d.file, scope: d.scope || '.', kind: d.kind })),
    conventions: sorted.flatMap((d) => d.conventions.map((c) => ({ file: c.file, scope: d.scope || '.', line: c.line, text: c.text }))),
    commands: sorted.flatMap((d) => d.commands.map((c) => ({ file: d.file, ...c }))),
    forbidden_commands: sorted.flatMap((d) => d.forbiddenCommands),
    forbidden_paths: sorted.flatMap((d) => d.forbiddenPaths),
    flagged: sorted.flatMap((d) => d.flagged),
  };
}

/** What applies to one root-relative path, nearest guidance file first. */
export function guidanceFor(root, path, loaded = loadGuidance(root)) {
  const p = String(path ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
  return view(loaded.docs.filter((d) => inScope(d.scope, p)));
}

/** What applies to a slice scope (globs): files whose directory is inside, or contains, any included glob. */
export function guidanceForScope(root, globs, loaded = loadGuidance(root)) {
  const gs = globs?.length ? globs : ['**'];
  return view(loaded.docs.filter((d) => gs.some((g) => overlaps(d.scope, g))));
}

/** Changed paths that guidance says not to edit: [{path, file, line, sentence, glob}]. */
export function protectedByGuidance(guidance, paths) {
  const hits = [];
  for (const path of paths) {
    const rule = guidance.forbidden_paths.find((f) => matchAny(path, [f.glob], { nocase: true }));
    if (rule) hits.push({ path, file: rule.file, line: rule.line, sentence: rule.sentence, glob: rule.glob });
  }
  return hits;
}

/** Forbidden-path rules a slice's include globs reach: the glob matches one, or covers its directory. */
export function scopeHits(guidance, include) {
  const hits = [];
  for (const rule of guidance.forbidden_paths) {
    const fp = prefixOf(rule.glob);
    const reach = include.some((g) => {
      const p = prefixOf(g);
      return matchAny(g.replace(/\*+/g, 'x'), [rule.glob], { nocase: true }) || (/[*?]/.test(g) && Boolean(fp) && (!p || fp === p || fp.startsWith(`${p}/`)));
    });
    if (reach && !hits.some((h) => h.glob === rule.glob && h.file === rule.file)) hits.push(rule);
  }
  return hits;
}

/** The root's own guidance rule forbidding this command, or null (cheap: no directory walk). */
export function forbiddenAtRoot(root, argv) {
  return forbiddenCommand(view(loadGuidance(root, { nested: false }).docs.filter((d) => !d.scope)), argv);
}

/** The rule forbidding this command (argv array), or null. */
export function forbiddenCommand(guidance, argv) {
  return guidance.forbidden_commands.find((f) => commandMatches(argv, f)) ?? null;
}
