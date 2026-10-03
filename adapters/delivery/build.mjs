// Build topology: Makefiles, Nx, Turborepo, Lerna, pnpm, Rush and Bazel (spec §9.4 step 5).
// Everything here becomes `workspace:` and `build_target:` nodes. Structured JSON/YAML
// manifests are high confidence; Makefile and Bazel are scanned textually (medium / low)
// because their real semantics need an evaluator we deliberately do not embed.

import { parseYAML } from '../../runtime/core/yaml.mjs';
import { nodeFact, edgeFact } from '../../runtime/graph/facts.mjs';
import { DEPLOY_RE } from './ci.mjs';
import {
  P, clean, isObj, asArray, uniqSorted, dirname, parseJsonLoose, capFacts,
} from './util.mjs';

const wsKey = (dir) => dir;

export function parseMakefile(path, text) {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const targets = new Map();
  const phony = new Set();
  let current = [];
  lines.forEach((line, idx) => {
    if (line.startsWith('\t')) {
      for (const t of current) {
        const e = targets.get(t);
        if (e && line.trim()) e.recipe.push(line.trim());
      }
      return;
    }
    const m = /^([^\s#:=$][^:=#]*?)\s*:(?![=:])\s*([^#]*)/.exec(line);
    if (!m || /^\s*(?:ifn?eq|ifn?def|else|endif|define|endef|export|override|include|-include)\b/.test(line)) {
      current = [];
      return;
    }
    const names = m[1].trim().split(/\s+/);
    const prereqs = m[2].split(';')[0].trim().split(/\s+/).filter((p) => p && !p.startsWith('|'));
    if (names[0] === '.PHONY') {
      for (const p of prereqs) phony.add(p);
      current = [];
      return;
    }
    current = names.filter((n) => !n.startsWith('.') || n === '.');
    for (const n of current) {
      const e = targets.get(n) ?? { prereqs: [], recipe: [], line: idx + 1 };
      e.prereqs.push(...prereqs);
      targets.set(n, e);
    }
    const inline = m[2].split(';')[1];
    if (inline) for (const n of current) targets.get(n).recipe.push(inline.trim());
  });
  const facts = [];
  const dir = dirname(path);
  for (const [name, e] of [...targets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const id = `${path}#${name}`;
    const recipeText = e.recipe.join('\n');
    facts.push(nodeFact('build_target', id, {
      name,
      path,
      attrs: clean({
        tool: 'make',
        root: dir,
        phony: phony.has(name) || undefined,
        recipe_lines: e.recipe.length,
        deploy_signal: DEPLOY_RE.test(`${name}\n${recipeText}`) || undefined,
        prerequisites: uniqSorted(e.prereqs),
      }),
    }, P(path, e.line, 'medium')));
    for (const p of uniqSorted(e.prereqs)) {
      // Only targets declared in this Makefile become edges; files and variables do not.
      if (targets.has(p)) facts.push(edgeFact('DEPENDS_ON', `build_target:${id}`, `build_target:${path}#${p}`, {}, P(path, e.line, 'medium')));
    }
  }
  return capFacts(facts);
}

export function parseNx(path, text) {
  const doc = JSON.parse(text);
  const dir = dirname(path);
  return [nodeFact('workspace', wsKey(dir), {
    name: dir === '.' ? 'nx workspace' : dir,
    path: dir === '.' ? null : dir,
    attrs: clean({
      tool: 'nx',
      config: path,
      target_defaults: isObj(doc.targetDefaults) ? Object.keys(doc.targetDefaults).sort() : undefined,
      named_inputs: isObj(doc.namedInputs) ? Object.keys(doc.namedInputs).sort() : undefined,
    }),
  }, P(path, 1, 'high'))];
}

export function parseNxProject(path, text) {
  const doc = JSON.parse(text);
  const dir = dirname(path);
  const name = typeof doc.name === 'string' ? doc.name : dir.split('/').pop();
  const id = `build_target:${name}`;
  const facts = [nodeFact('build_target', name, {
    name,
    path,
    attrs: clean({
      tool: 'nx',
      root: doc.root ?? dir,
      project_type: doc.projectType,
      tags: asArray(doc.tags).sort(),
      targets: isObj(doc.targets) ? Object.keys(doc.targets).sort() : [],
      implicit_dependencies: asArray(doc.implicitDependencies).sort(),
    }),
  }, P(path, 1, 'high'))];
  for (const dep of asArray(doc.implicitDependencies)) {
    // `!name` removes an inferred dependency; it is not an edge.
    if (typeof dep === 'string' && !dep.startsWith('!')) facts.push(edgeFact('DEPENDS_ON', id, `build_target:${dep}`, { via: 'implicitDependencies' }, P(path, 1, 'high')));
  }
  return facts;
}

export function parseTurbo(path, text) {
  const doc = parseJsonLoose(text);
  const dir = dirname(path);
  const tasks = isObj(doc.tasks) ? doc.tasks : isObj(doc.pipeline) ? doc.pipeline : {};
  const facts = [nodeFact('workspace', wsKey(dir), { name: dir === '.' ? 'turbo workspace' : dir, path: dir === '.' ? null : dir, attrs: { tool: 'turbo', config: path } }, P(path, 1, 'high'))];
  for (const [name, t] of Object.entries(tasks).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const dependsOn = asArray(t?.dependsOn).filter((d) => typeof d === 'string');
    facts.push(nodeFact('build_target', `${path}#${name}`, {
      name,
      path,
      attrs: clean({
        tool: 'turbo',
        depends_on: dependsOn,
        outputs: asArray(t?.outputs),
        cache: t?.cache,
        persistent: t?.persistent,
      }),
    }, P(path, 1, 'high')));
    for (const d of dependsOn) {
      // `^build` means "build in upstream packages"; the same-named task in this file is the nearest node.
      const local = d.replace(/^\^/, '');
      if (!local.includes('#') && local in tasks && local !== name) {
        facts.push(edgeFact('DEPENDS_ON', `build_target:${path}#${name}`, `build_target:${path}#${local}`, { upstream: d.startsWith('^') }, P(path, 1, 'high')));
      }
    }
  }
  return facts;
}

export function parseLerna(path, text) {
  const doc = JSON.parse(text);
  const dir = dirname(path);
  return [nodeFact('workspace', wsKey(dir), {
    name: dir === '.' ? 'lerna workspace' : dir,
    path: dir === '.' ? null : dir,
    attrs: clean({
      tool: 'lerna',
      config: path,
      package_globs: asArray(doc.packages).length ? asArray(doc.packages) : ['packages/*'],
      version: doc.version,
      npm_client: doc.npmClient,
    }),
  }, P(path, 1, 'high'))];
}

export function parsePnpmWorkspace(path, text) {
  const doc = parseYAML(text, { filename: path });
  const dir = dirname(path);
  return [nodeFact('workspace', wsKey(dir), {
    name: dir === '.' ? 'pnpm workspace' : dir,
    path: dir === '.' ? null : dir,
    attrs: { tool: 'pnpm', config: path, package_globs: asArray(isObj(doc) ? doc.packages : []) },
  }, P(path, 1, 'high'))];
}

export function parseRush(path, text) {
  const doc = parseJsonLoose(text);
  const dir = dirname(path);
  const facts = [nodeFact('workspace', wsKey(dir), {
    name: dir === '.' ? 'rush workspace' : dir,
    path: dir === '.' ? null : dir,
    attrs: { tool: 'rush', config: path, rush_version: doc.rushVersion, projects: asArray(doc.projects).length },
  }, P(path, 1, 'high'))];
  for (const p of asArray(doc.projects)) {
    if (!isObj(p) || typeof p.packageName !== 'string') continue;
    facts.push(nodeFact('build_target', p.packageName, {
      name: p.packageName,
      path: p.projectFolder ? `${dir === '.' ? '' : `${dir}/`}${p.projectFolder}` : null,
      attrs: clean({ tool: 'rush', project_folder: p.projectFolder, review_category: p.reviewCategory, should_publish: p.shouldPublish }),
    }, P(path, 1, 'high')));
  }
  return facts;
}

// ---- Bazel (low confidence: Starlark is not evaluated) ------------------------------------

function matchParen(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === '\'') quote = c;
    else if (c === '#') while (i < src.length && src[i] !== '\n') i++;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return src.length;
}

export function parseBazelBuild(path, text) {
  const pkg = dirname(path) === '.' ? '' : dirname(path);
  const facts = [];
  const re = /^([a-z_][a-z0-9_]*)\s*\(/gm;
  let m;
  while ((m = re.exec(text))) {
    const kind = m[1];
    const open = m.index + m[0].length - 1;
    const end = matchParen(text, open);
    const body = text.slice(open + 1, end);
    re.lastIndex = end;
    const nm = /\bname\s*=\s*"([^"]+)"/.exec(body);
    if (!nm || kind === 'load' || kind === 'package' || kind === 'exports_files') continue;
    const label = `//${pkg}:${nm[1]}`;
    const line = text.slice(0, m.index).split('\n').length;
    const depsMatch = /\bdeps\s*=\s*\[([\s\S]*?)\]/.exec(body);
    const deps = depsMatch ? [...depsMatch[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    const resolved = deps
      .filter((d) => !d.startsWith('@'))
      .map((d) => (d.startsWith(':') ? `//${pkg}${d}` : d))
      .sort();
    facts.push(nodeFact('build_target', label, {
      name: label,
      path,
      attrs: clean({ tool: 'bazel', rule: kind, deps: resolved, external_deps: deps.filter((d) => d.startsWith('@')).sort() }),
    }, P(path, line, 'low')));
    for (const d of resolved) facts.push(edgeFact('DEPENDS_ON', `build_target:${label}`, `build_target:${d}`, {}, P(path, line, 'low')));
  }
  return capFacts(facts);
}

export function parseBazelWorkspace(path, text) {
  const dir = dirname(path);
  const nm = /workspace\s*\(\s*name\s*=\s*"([^"]+)"/.exec(text);
  return [nodeFact('workspace', wsKey(dir), {
    name: nm ? nm[1] : (dir === '.' ? 'bazel workspace' : dir),
    path: dir === '.' ? null : dir,
    attrs: { tool: 'bazel', config: path },
  }, P(path, 1, 'low'))];
}
