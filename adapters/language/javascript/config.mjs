// package.json and tsconfig/jsconfig handling. These files are data, so they are parsed with
// JSON (after stripping JSONC comments and trailing commas) and never evaluated.

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';

export const EXTRACTOR = 'javascript@0.1.8';

const DEP_GROUPS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];

/** Parses JSON with comments and trailing commas (tsconfig style). Throws SyntaxError on bad input. */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: a comma followed only by whitespace and a closer.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

export function isPackageJson(path) {
  return baseOf(path) === 'package.json';
}

export function isTsConfig(path) {
  const b = baseOf(path);
  return /^tsconfig(?:\.[\w.-]+)?\.json$/.test(b) || b === 'jsconfig.json';
}

function sortedKeys(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).sort() : [];
}

/** Facts for a package.json: a package node plus DEPENDS_ON edges to dependency nodes. */
export function packageFacts(path, text) {
  const json = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new SyntaxError('package.json must be an object');
  const dir = dirOf(path);
  const name = typeof json.name === 'string' && json.name ? json.name : null;
  const key = name ?? (dir || '.');
  const p = (confidence = 'high') => prov({ source_type: 'config', source_ref: `${path}:1`, extractor: EXTRACTOR, confidence });
  let workspaces = json.workspaces;
  if (workspaces && !Array.isArray(workspaces)) workspaces = Array.isArray(workspaces.packages) ? workspaces.packages : [];
  const dependencies = {};
  for (const g of DEP_GROUPS) if (json[g] && typeof json[g] === 'object') dependencies[g] = Object.fromEntries(sortedKeys(json[g]).map((k) => [k, String(json[g][k])]));
  const attrs = {
    name: name ?? null,
    version: typeof json.version === 'string' ? json.version : null,
    dir,
    private: json.private === true,
    type: typeof json.type === 'string' ? json.type : null,
    workspaces: Array.isArray(workspaces) ? workspaces.filter((w) => typeof w === 'string') : [],
    main: typeof json.main === 'string' ? json.main : null,
    module: typeof json.module === 'string' ? json.module : null,
    types: typeof json.types === 'string' ? json.types : typeof json.typings === 'string' ? json.typings : null,
    exports: json.exports ?? null,
    scripts: sortedKeys(json.scripts),
    dependencies,
  };
  const facts = [nodeFact('package', key, { name: name ?? key, path, attrs }, p())];
  const seen = new Set();
  for (const g of DEP_GROUPS) {
    for (const dep of sortedKeys(dependencies[g])) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      facts.push(nodeFact('dependency', dep, { name: dep, attrs: { external: true } }, p()));
      facts.push(edgeFact('DEPENDS_ON', `package:${key}`, `dependency:${dep}`, { range: dependencies[g][dep], group: g }, p()));
    }
  }
  return facts;
}

/** Facts for a tsconfig/jsconfig: one build_target node. */
export function tsconfigFacts(path, text) {
  const json = parseJsonc(text);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new SyntaxError('tsconfig must be an object');
  const co = json.compilerOptions && typeof json.compilerOptions === 'object' ? json.compilerOptions : {};
  const ext = json.extends;
  const attrs = {
    baseUrl: typeof co.baseUrl === 'string' ? co.baseUrl : null,
    paths: co.paths && typeof co.paths === 'object' ? co.paths : null,
    rootDir: typeof co.rootDir === 'string' ? co.rootDir : null,
    extends: typeof ext === 'string' ? ext : Array.isArray(ext) ? ext.filter((x) => typeof x === 'string')[0] ?? null : null,
    include: Array.isArray(json.include) ? json.include.filter((x) => typeof x === 'string') : null,
    dir: dirOf(path),
  };
  return [nodeFact('build_target', path, { name: path, path, attrs }, prov({ source_type: 'config', source_ref: `${path}:1`, extractor: EXTRACTOR, confidence: 'high' }))];
}
