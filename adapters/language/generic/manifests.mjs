// Build manifests: go.mod, Cargo.toml, pom.xml, Gradle, .csproj/.sln, Gemfile,
// composer.json, Package.swift, CMakeLists.txt. Each reader is a small regex or
// line-oriented parser (no TOML/XML libraries, nothing executed) that yields one
// descriptor; `manifestFacts` turns descriptors into package/workspace/build_target/
// dependency nodes and DEPENDS_ON/CONTAINS edges.

import { edgeFact, nodeFact } from '../../../runtime/graph/facts.mjs';
import { lex } from './lexer.mjs';

export const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/** Resolve `rel` against `dir` into a normalised repo-relative POSIX path ('' for the root). */
export function resolvePath(dir, rel) {
  const out = dir ? dir.split('/') : [];
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

/** Which manifest reader (if any) owns this path. */
export function manifestKind(path) {
  const b = basename(path);
  if (b === 'go.mod') return 'gomod';
  if (b === 'Cargo.toml') return 'cargo';
  if (b === 'pom.xml') return 'maven';
  if (b === 'build.gradle' || b === 'build.gradle.kts') return 'gradle';
  if (b === 'settings.gradle' || b === 'settings.gradle.kts') return 'gradle-settings';
  if (b.endsWith('.csproj')) return 'csproj';
  if (b.endsWith('.sln')) return 'sln';
  if (b === 'Gemfile') return 'gemfile';
  if (b === 'composer.json') return 'composer';
  if (b === 'Package.swift') return 'swiftpm';
  if (b === 'CMakeLists.txt') return 'cmake';
  return null;
}

const dirName = (dir) => basename(dir) || 'root';
const uniq = (a) => [...new Set(a)].sort();

function tomlStrip(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q && line[i - 1] !== '\\') q = null; } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

const tomlBalance = (v) => (v.match(/[[{]/g) ?? []).length - (v.match(/[\]}]/g) ?? []).length;
const unq = (v) => (v == null ? null : (/^\s*(["'])(.*)\1\s*$/.exec(v)?.[2] ?? null));

/** Minimal TOML: sections of key -> raw value text (multi-line arrays joined). */
export function parseToml(text) {
  const sections = new Map([['', new Map()]]);
  let cur = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = tomlStrip(lines[i]).trim();
    if (!l) continue;
    let m = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(l);
    if (m) {
      cur = m[1].replace(/\s/g, '');
      if (!sections.has(cur)) sections.set(cur, new Map());
      continue;
    }
    m = /^("[^"]+"|[\w.-]+)\s*=\s*(.*)$/.exec(l);
    if (!m) continue;
    let val = m[2];
    while (tomlBalance(val) > 0 && i + 1 < lines.length) val += ` ${tomlStrip(lines[++i]).trim()}`;
    sections.get(cur).set(m[1].replace(/"/g, ''), val.trim());
  }
  return sections;
}

function readGoMod(path, text) {
  const t = text.replace(/\/\/.*$/gm, '');
  const mod = /^\s*module\s+(\S+)/m.exec(t)?.[1] ?? dirName(dirname(path));
  const deps = [];
  for (const m of t.matchAll(/^[ \t]*require[ \t]+(?!\()(\S+)[ \t]+\S+/gm)) deps.push({ name: m[1] });
  for (const m of t.matchAll(/^\s*require\s*\(([\s\S]*?)\)/gm)) {
    for (const l of m[1].split('\n')) {
      const mm = /^\s*(\S+)\s+v\S+/.exec(l);
      if (mm) deps.push({ name: mm[1] });
    }
  }
  const local = [...t.matchAll(/^\s*replace\s+\S+(?:\s+\S+)?\s*=>\s*(\.{1,2}\/\S*)/gm)].map((m) => resolvePath(dirname(path), m[1]));
  return { ecosystem: 'go', type: 'package', name: mod, deps, local, attrs: { go_module: mod, go_version: /^\s*go\s+(\S+)/m.exec(t)?.[1] ?? null } };
}

function readCargo(path, text) {
  const s = parseToml(text);
  const pkg = s.get('package');
  const dir = dirname(path);
  const deps = [];
  const local = [];
  const take = (key, val, dev) => {
    let name = key;
    if (val.startsWith('{')) {
      const rename = /\bpackage\s*=\s*"([^"]+)"/.exec(val)?.[1];
      if (rename) name = rename;
      const p = /\bpath\s*=\s*"([^"]+)"/.exec(val)?.[1];
      if (p) local.push(resolvePath(dir, p));
    }
    deps.push({ name, dev });
  };
  for (const [sec, kv] of s) {
    let m = /^(dev-|build-)?dependencies$|^workspace\.dependencies$|^target\..+\.(dev-|build-)?dependencies$/.exec(sec);
    if (m) { for (const [k, v] of kv) take(k, v, Boolean(m[1] || m[2])); continue; }
    m = /^(dev-|build-)?dependencies\.(.+)$/.exec(sec);
    if (m) {
      const p = kv.get('path');
      if (p) local.push(resolvePath(dir, unq(p) ?? ''));
      deps.push({ name: unq(kv.get('package')) ?? m[2], dev: Boolean(m[1]) });
    }
  }
  const membersRaw = s.get('workspace')?.get('members');
  const members = membersRaw ? [...membersRaw.matchAll(/"([^"]+)"/g)].map((m) => resolvePath(dir, m[1])) : [];
  const name = unq(pkg?.get('name'));
  return {
    ecosystem: 'cargo',
    type: name ? 'package' : 'workspace',
    name: name ?? dirName(dir),
    deps,
    local,
    members,
    attrs: { version: unq(pkg?.get('version')), crate_root: name ? dir : null },
  };
}

const xmlStrip = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
const tag = (t, n) => new RegExp(`<${n}>\\s*([^<]*?)\\s*</${n}>`).exec(t)?.[1] ?? null;

function readMaven(path, text) {
  const t = xmlStrip(text).replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(t)?.[1] ?? '';
  const head = t.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<(dependencies|build|profiles|properties|modules|reporting)>[\s\S]*?<\/\1>/g, '');
  const g = tag(head, 'groupId') ?? tag(parent, 'groupId') ?? '';
  const a = tag(head, 'artifactId') ?? dirName(dirname(path));
  const deps = [];
  for (const m of t.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const dg = tag(m[1], 'groupId');
    const da = tag(m[1], 'artifactId');
    if (da) deps.push({ name: `${dg ?? ''}:${da}`, dev: tag(m[1], 'scope') === 'test' });
  }
  const modules = [...(/<modules>([\s\S]*?)<\/modules>/.exec(t)?.[1] ?? '').matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => resolvePath(dirname(path), m[1]));
  return {
    ecosystem: 'maven', type: 'package', name: `${g}:${a}`, deps, local: [], members: modules,
    attrs: { group_id: g, artifact_id: a, packaging: tag(head, 'packaging') ?? 'jar' },
  };
}

function readGradle(path, text) {
  const t = lex(text, 'groovy').plain;
  const deps = [];
  for (const m of t.matchAll(/\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|annotationProcessor|kapt|ksp|classpath|compile|testCompile)\s*\(?\s*(?:platform\(\s*)?(['"])([^'"]+)\2/g)) {
    const [g, a] = m[3].split(':');
    if (a) deps.push({ name: `${g}:${a}`, dev: m[1].startsWith('test') });
  }
  const projects = uniq([...t.matchAll(/\bproject\(\s*(?:path\s*[:=]\s*)?(['"]):([^'"]+)\1/g)].map((m) => m[2]));
  const dir = dirname(path);
  return {
    ecosystem: 'gradle', type: 'package', name: dirName(dir), deps, local: [], members: [],
    attrs: { gradle_projects: projects, group: /^\s*group\s*=\s*['"]([^'"]+)['"]/m.exec(t)?.[1] ?? null },
  };
}

function readGradleSettings(path, text) {
  const t = lex(text, 'groovy').plain.replace(/,\s*\n/g, ', ');
  const dir = dirname(path);
  const members = [];
  for (const m of t.matchAll(/\binclude\b\s*\(?([^\n]*)/g)) {
    for (const s of m[1].matchAll(/['"]:?([^'"]+)['"]/g)) members.push(resolvePath(dir, s[1].replace(/:/g, '/')));
  }
  const name = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(t)?.[1] ?? dirName(dir);
  return { ecosystem: 'gradle', type: 'workspace', name, deps: [], local: [], members: uniq(members), attrs: {} };
}

function readCsproj(path, text) {
  const t = xmlStrip(text);
  const dir = dirname(path);
  const name = tag(t, 'AssemblyName') ?? tag(t, 'PackageId') ?? basename(path).replace(/\.csproj$/, '');
  const deps = [...t.matchAll(/<PackageReference\s+(?:Include|Update)="([^"]+)"/gi)].map((m) => ({ name: m[1] }));
  const local = [...t.matchAll(/<ProjectReference\s+Include="([^"]+)"/gi)].map((m) => resolvePath(dir, m[1]));
  return {
    ecosystem: 'dotnet', type: 'package', name, deps, local, members: [],
    attrs: { target_framework: tag(t, 'TargetFramework') ?? tag(t, 'TargetFrameworks') },
  };
}

function readSln(path, text) {
  const dir = dirname(path);
  const files = [...text.matchAll(/Project\("\{[^}]+\}"\)\s*=\s*"[^"]+"\s*,\s*"([^"]+)"/g)].map((m) => resolvePath(dir, m[1])).filter((p) => /proj$/.test(p));
  return { ecosystem: 'dotnet', type: 'workspace', name: basename(path).replace(/\.sln$/, ''), deps: [], local: [], members: [], attrs: { member_files: uniq(files) } };
}

function readGemfile(path, text) {
  const t = lex(text, 'ruby').plain;
  const dir = dirname(path);
  const deps = [];
  const local = [];
  for (const m of t.matchAll(/^[ \t]*gem\s+(['"])([^'"]+)\1(.*)$/gm)) {
    deps.push({ name: m[2], dev: /:(?:development|test)\b|group:/.test(m[3]) });
    const p = /\bpath:\s*['"]([^'"]+)['"]/.exec(m[3])?.[1];
    if (p) local.push(resolvePath(dir, p));
  }
  return { ecosystem: 'bundler', type: 'package', name: dirName(dir), deps, local, members: [], attrs: {} };
}

function readComposer(path, text) {
  const dir = dirname(path);
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  const obj = j && typeof j === 'object' ? j : {};
  const reqs = (o) => Object.keys(o && typeof o === 'object' ? o : {}).filter((k) => k !== 'php' && !k.startsWith('ext-'));
  const deps = [...reqs(obj.require).map((name) => ({ name })), ...reqs(obj['require-dev']).map((name) => ({ name, dev: true }))];
  const psr4 = [];
  for (const sec of [obj.autoload, obj['autoload-dev']]) {
    for (const [prefix, p] of Object.entries(sec?.['psr-4'] ?? {})) {
      for (const d of Array.isArray(p) ? p : [p]) psr4.push({ prefix: prefix.replace(/\\+$/, ''), dir: resolvePath(dir, String(d)) });
    }
  }
  return {
    ecosystem: 'composer', type: 'package', name: typeof obj.name === 'string' ? obj.name : dirName(dir), deps, local: [], members: [],
    attrs: { psr4, parse_error: j === null || undefined },
  };
}

function balanced(t, open) {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function readSwiftPm(path, text) {
  const t = lex(text, 'swift').plain;
  const dir = dirname(path);
  const name = /\bPackage\s*\(\s*name:\s*"([^"]+)"/.exec(t)?.[1] ?? dirName(dir);
  const deps = [];
  const local = [];
  for (const m of t.matchAll(/\.package\s*\(([^)]*)\)/g)) {
    const url = /\burl:\s*"([^"]+)"/.exec(m[1])?.[1];
    const p = /\bpath:\s*"([^"]+)"/.exec(m[1])?.[1];
    if (url) deps.push({ name: url.replace(/\.git$/, '').split('/').pop() });
    else if (p) local.push(resolvePath(dir, p));
  }
  const targets = [];
  for (const m of t.matchAll(/\.(target|executableTarget|testTarget|plugin|systemLibrary|binaryTarget|macro)\s*\(\s*name:\s*"([^"]+)"/g)) {
    const open = m.index + m[0].indexOf('(');
    const close = balanced(t, open);
    const body = close < 0 ? '' : t.slice(open, close);
    const depChunk = /dependencies:\s*\[([\s\S]*)\]/.exec(body)?.[1] ?? '';
    const links = [];
    const ext = [];
    for (const p of depChunk.matchAll(/\.product\s*\(\s*name:\s*"([^"]+)"/g)) ext.push(p[1]);
    for (const p of depChunk.matchAll(/\.(?:target|byName)\s*\(\s*name:\s*"([^"]+)"/g)) links.push(p[1]);
    for (const p of depChunk.matchAll(/(?<![\w:]\s*)"([^"]+)"/g)) {
      if (!/(?:name|package):\s*$/.test(depChunk.slice(Math.max(0, p.index - 12), p.index))) links.push(p[1]);
    }
    targets.push({ name: m[2], kind: m[1], links: uniq(links), external: uniq(ext), line: 0 });
  }
  return { ecosystem: 'swiftpm', type: 'package', name, deps, local, members: [], targets, attrs: {} };
}

function readCmake(path, text) {
  const t = text.replace(/#.*$/gm, '');
  const dir = dirname(path);
  const targets = [];
  const includeDirs = [];
  const members = [];
  let project = null;
  const mapDir = (d) => (/\$\{(?!CMAKE_CURRENT_SOURCE_DIR|PROJECT_SOURCE_DIR|CMAKE_SOURCE_DIR)/.test(d) ? null : d.replace(/\$\{(?:CMAKE_CURRENT_SOURCE_DIR|PROJECT_SOURCE_DIR|CMAKE_SOURCE_DIR)\}\/?/, ''));
  const addDirs = (args) => {
    for (const a of args) {
      if (/^(?:SYSTEM|BEFORE|AFTER|PUBLIC|PRIVATE|INTERFACE)$/.test(a)) continue;
      const d = mapDir(a);
      if (d !== null && !includeDirs.includes(resolvePath(dir, d))) includeDirs.push(resolvePath(dir, d));
    }
  };
  for (const m of t.matchAll(/\b([A-Za-z_]+)\s*\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const cmd = m[1].toLowerCase();
    const args = (m[2].match(/"[^"]*"|[^\s"]+/g) ?? []).map((a) => a.replace(/^"|"$/g, ''));
    const line = t.slice(0, m.index).split('\n').length;
    if (cmd === 'project' && args[0]) project ??= args[0];
    else if ((cmd === 'add_library' || cmd === 'add_executable') && args[0]) {
      const rest = args.slice(1);
      targets.push({
        name: args[0], kind: cmd === 'add_library' ? 'library' : 'executable', links: [], external: [], line,
        sources: rest.filter((a) => !/^(?:STATIC|SHARED|MODULE|OBJECT|INTERFACE|IMPORTED|ALIAS|EXCLUDE_FROM_ALL|WIN32|MACOSX_BUNDLE)$/.test(a)).slice(0, 50),
      });
    } else if (cmd === 'target_link_libraries' && args[0]) {
      const tg = targets.find((x) => x.name === args[0]);
      const libs = args.slice(1).filter((a) => !/^(?:PUBLIC|PRIVATE|INTERFACE|debug|optimized|general)$/.test(a) && !a.startsWith('$'));
      if (tg) tg.links.push(...libs); else targets.push({ name: args[0], kind: 'unknown', links: libs, external: [], line, sources: [], declaredElsewhere: true });
    } else if (cmd === 'include_directories') addDirs(args);
    else if (cmd === 'target_include_directories') addDirs(args.slice(1));
    else if (cmd === 'add_subdirectory' && args[0]) members.push(resolvePath(dir, args[0]));
  }
  return {
    ecosystem: 'cmake', type: 'package', name: project ?? dirName(dir), deps: [], local: [], members: uniq(members),
    targets: targets.filter((x) => !x.declaredElsewhere),
    attrs: {
      include_dirs: uniq(includeDirs),
      // Links for targets defined in another CMakeLists; link() attaches them to the real target.
      extra_links: Object.fromEntries(targets.filter((x) => x.declaredElsewhere).map((x) => [x.name, uniq(x.links)])),
    },
  };
}

const READERS = {
  gomod: readGoMod, cargo: readCargo, maven: readMaven, gradle: readGradle, 'gradle-settings': readGradleSettings,
  csproj: readCsproj, sln: readSln, gemfile: readGemfile, composer: readComposer, swiftpm: readSwiftPm, cmake: readCmake,
};

/**
 * Facts for one manifest file.
 * @param {string} path
 * @param {string} text
 * @param {(line: number) => object} P provenance factory
 */
export function manifestFacts(path, text, P) {
  const kind = manifestKind(path);
  const d = READERS[kind](path, text);
  const facts = [];
  const type = d.type;
  const id = `${type}:${d.name}`;
  const deps = uniq(d.deps.filter((x) => !x.dev).map((x) => x.name));
  const devDeps = uniq(d.deps.filter((x) => x.dev).map((x) => x.name));
  facts.push(nodeFact(type, d.name, {
    name: d.name,
    path,
    attrs: {
      ecosystem: d.ecosystem, manifest: path, dir: dirname(path), deps, dev_deps: devDeps,
      members: d.members ?? [], local_deps: uniq(d.local ?? []), parse_quality: 'lexical', ...d.attrs,
    },
  }, P(1)));
  for (const name of uniq([...deps, ...devDeps])) {
    facts.push(nodeFact('dependency', name, { name, attrs: { ecosystem: d.ecosystem } }, P(1)));
    facts.push(edgeFact('DEPENDS_ON', id, `dependency:${name}`, { dev: devDeps.includes(name) && !deps.includes(name) }, P(1)));
  }
  const targetNames = new Set((d.targets ?? []).map((x) => x.name));
  for (const tg of d.targets ?? []) {
    facts.push(nodeFact('build_target', tg.name, {
      name: tg.name, path, attrs: { kind: tg.kind, ecosystem: d.ecosystem, sources: tg.sources ?? [], links: tg.links },
    }, P(tg.line || 1)));
    facts.push(edgeFact('CONTAINS', id, `build_target:${tg.name}`, {}, P(tg.line || 1)));
    for (const l of tg.links) {
      if (l === tg.name) continue;
      if (targetNames.has(l)) facts.push(edgeFact('DEPENDS_ON', `build_target:${tg.name}`, `build_target:${l}`, {}, P(tg.line || 1)));
      else {
        facts.push(nodeFact('dependency', l, { name: l, attrs: { ecosystem: d.ecosystem } }, P(tg.line || 1)));
        facts.push(edgeFact('DEPENDS_ON', `build_target:${tg.name}`, `dependency:${l}`, {}, P(tg.line || 1)));
      }
    }
    for (const l of tg.external ?? []) {
      facts.push(nodeFact('dependency', l, { name: l, attrs: { ecosystem: d.ecosystem } }, P(tg.line || 1)));
      facts.push(edgeFact('DEPENDS_ON', `build_target:${tg.name}`, `dependency:${l}`, {}, P(tg.line || 1)));
    }
  }
  const seen = new Set();
  return facts.filter((f) => {
    const k = f.kind === 'node' ? f.id : `${f.type}|${f.from}|${f.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
