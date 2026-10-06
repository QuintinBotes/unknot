// /unknot:init — detect the project's toolchain and propose a configuration. It writes
// only .unknot/config.proposed.yaml (spec §4.1: config-only write); a human accepts it.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { matchAny } from '../../core/glob.mjs';
import { commandMatches, loadGuidance } from '../../core/guidance.mjs';
import { stringifyYAML } from '../../core/yaml.mjs';
import { itemKey, writeSources } from '../../policy/config-diff.mjs';
import { DEFAULT_CONFIG } from '../../policy/defaults.mjs';
import { appendEvent } from '../../state/ledger.mjs';
import { humanCommand, output } from '../util.mjs';
import { open } from './_shared.mjs';

function readJSON(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function onPath(exe) {
  return (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, exe)));
}

function has(root, ...names) {
  return names.some((n) => existsSync(join(root, n)));
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'vendored', 'bin', 'obj', '.unknot', '.claude']);

/** Files up to `depth` directories below the root, as sorted root-relative paths (bounded). */
function walk(root, depth) {
  const out = [];
  const rec = (rel, d) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 20000) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Another checkout inside this one (a git worktree, a nested clone) is not this project.
        if (d < depth && !SKIP_DIRS.has(e.name.toLowerCase()) && !existsSync(join(root, p, '.git'))) rec(p, d + 1);
      } else if (e.isFile()) out.push(p);
    }
  };
  rec('', 0);
  return out.sort();
}

const depthOf = (p) => p.split('/').length - 1;
const readText = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

// Azure DevOps pipelines: build keys next to a pipeline-level key, or an extends template.
// Compose files, Kubernetes manifests and OpenAPI documents share the extension, not the shape.
function isAzurePipeline(text) {
  const keys = new Set([...text.matchAll(/^([A-Za-z_][\w-]*):/gm)].map((m) => m[1]));
  if (['apiVersion', 'kind', 'openapi', 'swagger', 'services'].some((k) => keys.has(k))) return false;
  if (['stages', 'jobs', 'steps'].some((k) => keys.has(k)) && ['trigger', 'pr', 'pool', 'resources', 'variables', 'extends'].some((k) => keys.has(k))) return true;
  return keys.has('extends') && /^\s+template:/m.test(text);
}

/** Pipeline directories (root-relative, '' for the root) with the files that made them count. */
function azurePipelineDirs(root, files) {
  const found = new Map();
  const seen = new Set();
  const add = (f) => {
    seen.add(f);
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    found.set(dir, [...(found.get(dir) ?? []), f]);
  };
  const yaml = files.filter((f) => /\.ya?ml$/i.test(f) && depthOf(f) <= 4 && !f.startsWith('.github/workflows/'));
  for (const f of yaml) {
    const text = readText(join(root, f));
    if (!isAzurePipeline(text)) continue;
    if (!seen.has(f)) add(f);
    const base = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    for (const m of text.matchAll(/^\s*-?\s*template:\s*['"]?([^\s'"@#]+)['"]?\s*$/gm)) {
      const out = [];
      for (const s of (m[1].startsWith('/') ? m[1].slice(1) : base ? `${base}/${m[1]}` : m[1]).split('/')) s === '..' ? out.pop() : s !== '.' && out.push(s);
      const t = out.join('/');
      if (!seen.has(t) && yaml.includes(t) && !/^(apiVersion|kind):/m.test(readText(join(root, t)))) add(t);
    }
  }
  return found;
}

const HINT_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'];

/**
 * What the repository's guidance says to validate with, as [file, heading, command] (root files
 * only), the command shapes it says not to run, the paths it says not to edit, and the text
 * dropped because it tried to grant something. See runtime/core/guidance.mjs.
 */
function guidanceHints(root) {
  const { docs, flagged } = loadGuidance(root);
  const hints = HINT_FILES.flatMap((f) => docs.filter((d) => d.file === f).flatMap((d) => d.commands.map((c) => [f, c.heading, c.command])));
  const all = docs.slice().sort((a, b) => a.file.localeCompare(b.file));
  // Only repository-wide, unflagged prohibitions are enforced; scoped and conflicting ones are reported.
  const enforced = (r) => r.enforced !== false;
  return { hints, forbidden: all.flatMap((d) => d.forbiddenCommands).filter(enforced), paths: all.flatMap((d) => d.forbiddenPaths).filter(enforced), flagged, unenforced: all.flatMap((d) => [...d.forbiddenCommands, ...d.forbiddenPaths]).filter((r) => !enforced(r)) };
}

const ROOT_MANIFESTS = ['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Makefile', '*.sln', '*.slnx', '*.csproj', '*.fsproj'];
const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|setup\.py|requirements\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Makefile|[^/]+\.(slnx?|csproj|fsproj))$/;

/** .NET: the shallowest solution (root first, then up to depth 3), else a root project file. */
function detectDotnet(root, files, commands, notes) {
  const sols = files.filter((f) => /\.slnx?$/i.test(f) && depthOf(f) <= 3).sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  const target = sols[0] ?? files.find((f) => !f.includes('/') && /\.(cs|fs)proj$/i.test(f));
  if (!target) return null;
  commands.build ??= ['dotnet', 'build', target];
  commands.test_unit ??= ['dotnet', 'test', target];
  notes.push(`dotnet: ${sols.length ? 'solution' : 'project'} ${target}${sols.length > 1 ? `; other solutions not used: ${sols.slice(1).join(', ')}` : ''}`);
  if (!onPath('dotnet')) notes.push('dotnet is not on PATH: install the .NET SDK before baseline checks run, or every check will fail');
  const sdk = readJSON(join(root, 'global.json'))?.sdk?.version;
  if (sdk) notes.push(`global.json pins .NET SDK ${sdk}`);
  return target;
}

/** The 1-based line of the first match of `re` in a root-relative file, else 1. */
function lineOf(root, file, re) {
  const i = readText(join(root, file)).split('\n').findIndex((l) => re.test(l));
  return i < 0 ? 1 : i + 1;
}

/** The build file and line a detected command came from, as { file, line }. */
function commandSource(root, argv, pkg) {
  const first = (...names) => names.find((n) => existsSync(join(root, n))) ?? names[0];
  const last = argv.at(-1);
  if (pkg) {
    if (pkg.scripts?.[last]) return { file: 'package.json', line: lineOf(root, 'package.json', new RegExp(`^\\s*"${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`)) };
    if (argv.includes('eslint')) return { file: 'package.json', line: lineOf(root, 'package.json', /"eslint"/) };
    if (argv.includes('tsc')) return { file: 'package.json', line: lineOf(root, 'package.json', /"typescript"/) };
  }
  const exe = argv[0];
  if (exe === 'make') return { file: 'Makefile', line: lineOf(root, 'Makefile', new RegExp(`^${last}:`)) };
  if (exe === 'dotnet') return { file: argv[2], line: 1 };
  if (exe === 'go') return { file: 'go.mod', line: 1 };
  if (exe === 'cargo') return { file: 'Cargo.toml', line: 1 };
  if (exe === 'mvn') return { file: 'pom.xml', line: 1 };
  if (exe === 'gradle' || exe === './gradlew') return { file: first('build.gradle', 'build.gradle.kts'), line: 1 };
  if (exe === 'ruff') return { file: 'pyproject.toml', line: lineOf(root, 'pyproject.toml', /\[tool\.ruff/) };
  if (exe === 'mypy') return { file: 'pyproject.toml', line: lineOf(root, 'pyproject.toml', /\[tool\.mypy/) };
  const py = first('pyproject.toml', 'setup.py', 'requirements.txt', 'pytest.ini', 'tox.ini');
  return { file: py, line: 1 };
}

/** Detect commands without running anything. Every entry says where it came from. */
export function detect(root) {
  const commands = {};
  const notes = [];
  const files = walk(root, 4);
  const pkg = readJSON(join(root, 'package.json'));
  if (pkg) {
    const pm = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : has(root, 'bun.lockb', 'bun.lock') ? 'bun' : 'npm';
    const scripts = pkg.scripts ?? {};
    const map = { build: ['build'], test_unit: ['test:unit', 'test'], test_integration: ['test:integration', 'test:e2e'], lint: ['lint'], typecheck: ['typecheck', 'type-check', 'tsc'], format_check: ['format:check', 'prettier:check'] };
    for (const [name, candidates] of Object.entries(map)) {
      const s = candidates.find((c) => scripts[c]);
      if (s) commands[name] = pm === 'npm' && s !== 'test' ? ['npm', 'run', s] : [pm, ...(pm === 'npm' ? [] : ['run']), s].filter(Boolean);
    }
    if (commands.test_unit?.[0] === 'npm' && commands.test_unit[2] === 'test') commands.test_unit = ['npm', 'test'];
    // Linting and type checking often run through hooks (husky, lint-staged) rather than a
    // script; the tool's own config plus a dependency on it is enough to propose a command.
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const runner = pm === 'npm' ? ['npx', '--no'] : pm === 'yarn' ? ['yarn'] : [pm, 'exec'];
    const eslintConfig = readdirSync(root).some((f) => /^(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/.test(f)) || Boolean(pkg.eslintConfig);
    if (!commands.lint && deps.eslint && eslintConfig) {
      commands.lint = [...runner, 'eslint', '.'];
      notes.push('lint: proposed from the ESLint config and dependency (no lint script)');
    }
    if (!commands.typecheck && deps.typescript && has(root, 'tsconfig.json')) {
      commands.typecheck = [...runner, 'tsc', '--noEmit'];
      notes.push('typecheck: proposed from tsconfig.json and the TypeScript dependency (no typecheck script)');
    }
    if (Object.keys(deps).length && !has(root, 'node_modules')) notes.push('node_modules is missing: install dependencies before baseline checks run, or every check will fail');
    for (const [name, argv] of Object.entries(commands)) {
      const script = argv[0] === pm && scripts[argv.at(-1)];
      const exe = typeof script === 'string' ? script.trim().split(/\s+/)[0] : null;
      if (exe && !/[=/]/.test(exe) && !['node', 'npm', 'npx', 'yarn', 'pnpm', 'bun'].includes(exe) && !onPath(exe) && !has(root, `node_modules/.bin/${exe}`)) {
        notes.push(`${name} runs \`${exe}\`, which is not on PATH or in node_modules/.bin`);
      }
    }
    notes.push(`node: package manager ${pm}, scripts ${Object.keys(scripts).join(', ') || 'none'}`);
  }
  if (has(root, 'pyproject.toml', 'setup.py', 'requirements.txt', 'pytest.ini', 'tox.ini')) {
    const pyproject = existsSync(join(root, 'pyproject.toml')) ? readFileSync(join(root, 'pyproject.toml'), 'utf8') : '';
    commands.test_unit ??= ['python3', '-m', 'pytest', '-q'];
    if (/\[tool\.ruff/.test(pyproject)) commands.lint ??= ['ruff', 'check', '.'];
    if (/\[tool\.mypy/.test(pyproject)) commands.typecheck ??= ['mypy', '.'];
    notes.push('python project detected');
  }
  if (has(root, 'go.mod')) {
    commands.build ??= ['go', 'build', './...'];
    commands.test_unit ??= ['go', 'test', './...'];
    commands.lint ??= ['go', 'vet', './...'];
  }
  if (has(root, 'Cargo.toml')) {
    commands.build ??= ['cargo', 'build'];
    commands.test_unit ??= ['cargo', 'test'];
    commands.lint ??= ['cargo', 'clippy', '--', '-D', 'warnings'];
  }
  if (has(root, 'pom.xml')) commands.test_unit ??= ['mvn', '-q', 'test'];
  if (has(root, 'build.gradle', 'build.gradle.kts')) commands.test_unit ??= [has(root, 'gradlew') ? './gradlew' : 'gradle', 'test'];
  if (has(root, 'Makefile')) {
    const mk = readFileSync(join(root, 'Makefile'), 'utf8');
    for (const t of ['test', 'lint', 'build']) {
      const key = t === 'test' ? 'test_unit' : t;
      if (new RegExp(`^${t}:`, 'm').test(mk)) commands[key] ??= ['make', t];
    }
  }
  const dotnet = detectDotnet(root, files, commands, notes);
  const protectedPaths = [...DEFAULT_CONFIG.protected_paths];
  // Where each non-template line came from: commands by name, protected paths by glob.
  const sources = { commands: {}, protected: {}, omitted: [] };
  for (const [name, argv] of Object.entries(commands)) sources.commands[name] = { source: 'detected', ...commandSource(root, argv, pkg) };
  const evidence = structuredClone(DEFAULT_CONFIG.evidence);
  const top = readdirSync(root);
  if (top.includes('terraform') || top.includes('infra')) protectedPaths.push('**/*.tfstate*');
  if (dotnet) {
    for (const g of ['**/Directory.Build.props', '**/Directory.Build.targets', '**/Directory.Packages.props', 'global.json', '**/NuGet.config', '**/nuget.config']) {
      protectedPaths.push(g);
      sources.protected[g] = { source: 'detected', file: dotnet, line: 1 };
    }
  }
  // One note per proposed path, however many pipeline directories it covers.
  const pipelineGlobs = new Map();
  for (const [dir, fs] of azurePipelineDirs(root, files)) {
    const segs = dir.split('/');
    const at = segs.indexOf('pipelines');
    const globs = !dir ? fs.filter((f) => !matchAny(f, protectedPaths)) : at >= 0 ? [`${segs.slice(0, at + 1).join('/')}/**`] : [`${dir}/**/*.yml`, `${dir}/**/*.yaml`];
    if (!globs.length) continue;
    const key = globs.join(', ');
    pipelineGlobs.set(key, [...(pipelineGlobs.get(key) ?? []), ...fs]);
    protectedPaths.push(...globs);
    for (const g of globs) sources.protected[g] ??= { source: 'detected', file: fs[0], line: 1 };
  }
  for (const [key, fs] of pipelineGlobs) notes.push(`protected ${key}: Azure DevOps pipeline definitions (${fs.length} file${fs.length === 1 ? '' : 's'}: ${fs.slice(0, 3).join(', ')}${fs.length > 3 ? ', ...' : ''})`);
  if (!Object.keys(commands).length) {
    const below = files.filter((f) => f.includes('/') && depthOf(f) <= 3 && MANIFEST_RE.test(f));
    notes.push(`no commands detected: looked for ${ROOT_MANIFESTS.join(', ')} at the root; ${below.length ? `found below the root: ${below.slice(0, 8).join(', ')}${below.length > 8 ? ', ...' : ''}` : 'nothing found up to depth 3 below it'}`);
  }
  // A command the repository's guidance says not to run is not proposed, whatever detected it.
  const guidance = guidanceHints(root);
  for (const [name, argv] of Object.entries(commands)) {
    const rule = guidance.forbidden.find((f) => commandMatches(argv, f));
    if (!rule) continue;
    delete commands[name];
    delete sources.commands[name];
    sources.omitted.push({ key: `commands.${name}`, argv, source: 'guidance', file: rule.file, line: rule.line, sentence: rule.sentence });
    notes.push(`${name} not proposed: ${rule.file} (${rule.heading}) says "${rule.sentence}"`);
    if (rule.prefix === 'dotnet test') {
      const projects = files.filter((f) => /(^|\/)[^/]*(UnitTests|\.Tests|Tests)\.(cs|fs)proj$/i.test(f)).slice(0, 6);
      if (projects.length) notes.push(`test projects that could be run one at a time instead: ${projects.join(', ')}`);
    }
  }
  // Paths the guidance says not to edit are proposed as protected; a person accepts them.
  for (const r of guidance.paths) {
    if (matchAny(r.glob, protectedPaths) || protectedPaths.includes(r.glob)) continue;
    protectedPaths.push(r.glob);
    sources.protected[r.glob] = { source: 'guidance', file: r.file, line: r.line, sentence: r.sentence };
    notes.push(`protected ${r.glob}: ${r.file}:${r.line} says "${r.sentence}"`);
  }
  for (const f of guidance.flagged) {
    if (f.kind === 'conflict') notes.push(`not enforced: ${f.forbidden.file}:${f.forbidden.line} forbids "${f.forbidden.sentence}" but ${f.required.file}:${f.required.line} requires \`${f.required.command}\`; a person decides`);
    else notes.push(`ignored ${f.file}:${f.line} (${f.kind} marker; guidance can only add restrictions)`);
  }
  for (const r of guidance.unenforced.filter((u) => u.scope)) notes.push(`not enforced: ${r.file}:${r.line} is scoped to ${Object.values(r.scope)[0]} ("${r.sentence}")`);
  const known = Object.entries(commands).map(([k, v]) => [k, v.join(' ')]);
  for (const [file, heading, cmd] of guidance.hints) {
    const same = known.find(([, c]) => c === cmd);
    notes.push(`${file} (${heading}) mentions: ${cmd}${same ? `, which confirms ${same[0]}` : ' (a hint; not proposed as a command)'}`);
  }
  return { commands, notes, protectedPaths, evidence, sources };
}

/** The template proposal for a root, or its accepted configuration plus what is newly detected. */
export async function baseProposal(ctx) {
  const d = detect(ctx.root);
  const proposed = {
    version: 1,
    mode: 'plan',
    scope: { include: [], exclude: DEFAULT_CONFIG.scope.exclude },
    protected_paths: [...new Set(d.protectedPaths)],
    commands: d.commands,
    limits: { max_changed_files: 12, max_diff_lines: 500, max_runtime_minutes: 30, max_network_requests: 0 },
    // Unknot cannot tell published library API from application code; a person sets false when accepting.
    repository: { publishes_api: true },
    quality: { forbid_new_cycles: true, public_api_compatibility: 'required' },
    security: { secrets_scan: 'required', sast: 'required_for_high_risk', dependency_changes: 'approval_required' },
    database: { live_access: 'disabled', destructive_execution: 'forbidden' },
    infrastructure: { apply: 'forbidden', destroy: 'forbidden', require_saved_plan: true },
    // Approval roles are left to the built-in defaults (spec §20); a proposal never
    // starts looser than them.
    approvals: { expiry: '72h' },
    telemetry: { enabled: false },
  };
  // With a configuration already accepted, a fresh default proposal would drop its mode and
  // approvers on acceptance. Propose the accepted one plus what is newly detected instead.
  const acceptedText = ctx.store.meta('accepted_config_text');
  let update = null;
  if (acceptedText) {
    const { parseConfigText } = await import('../../policy/config.mjs');
    const accepted = parseConfigText(acceptedText, '<accepted>');
    const commands = Object.fromEntries(Object.entries(d.commands).filter(([k]) => !accepted.commands?.[k]));
    const paths = proposed.protected_paths.filter((p) => !(accepted.protected_paths ?? []).includes(p));
    update = { added_commands: commands, added_protected_paths: paths };
    Object.keys(proposed).forEach((k) => delete proposed[k]);
    Object.assign(proposed, accepted, { commands: { ...(accepted.commands ?? {}), ...commands }, protected_paths: [...(accepted.protected_paths ?? []), ...paths] });
  }
  return { d, proposed, update };
}

export async function run({ flags }) {
  const { ctx, actor } = open(flags, { create: true });
  const { d, proposed, update } = await baseProposal(ctx);
  const nothingNew = update && !Object.keys(update.added_commands).length && !update.added_protected_paths.length;
  if (!nothingNew) {
    const proposedText = `# repository.publishes_api: true treats public members as possible library API, so removing one is never a proven deletion.\n# Set it to false only if this repository publishes no library API and its public members are internal.\n${stringifyYAML(proposed)}`;
    writeFileSync(ctx.paths.proposedConfig, proposedText);
    const entries = {};
    for (const k of Object.keys(proposed.commands ?? {})) if (d.sources.commands[k]) entries[`commands.${k}`] = d.sources.commands[k];
    for (const g of proposed.protected_paths ?? []) if (d.sources.protected[g]) entries[itemKey('protected_paths', g)] = d.sources.protected[g];
    writeSources(ctx.paths, proposedText, { entries, omitted: d.sources.omitted.filter((o) => !proposed.commands?.[o.key.slice('commands.'.length)]) });
    appendEvent(ctx, { type: 'config.proposed', actor, payload: { commands: Object.keys(d.commands), ...(update && { added_commands: Object.keys(update.added_commands), added_protected_paths: update.added_protected_paths }) } });
  }
  // .unknot/ itself is ignored only when someone excluded it; its own .gitignore covers local state.
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', '.unknot/config.yaml'], { cwd: ctx.root, stdio: 'ignore' }).status === 0;
  const state_dir = { path: '.unknot', ignored, exclude_line: '.unknot/' };
  const head = !update
    ? ['Wrote .unknot/config.proposed.yaml (mode: plan). Nothing else was changed, and nothing is activated.']
    : nothingNew
      ? ['A configuration is already accepted and has everything detected here; no new proposal was written.']
      : [
        'A configuration is already accepted. Wrote .unknot/config.proposed.yaml: the accepted configuration (its mode and approvers unchanged) plus what was detected now:',
        ...Object.entries(update.added_commands).map(([k, v]) => `  + command ${k} = ${v.join(' ')}`),
        ...update.added_protected_paths.map((p) => `  + protected path ${p}`),
        'It applies only once a person accepts it.',
      ];
  const msg = [
    ...head,
    `Detected commands: ${Object.entries(d.commands).map(([k, v]) => `${k} = ${v.join(' ')}`).join('; ') || 'none'}.`,
    ...d.notes,
    '',
    ignored
      ? '.unknot/ is ignored by git here, so nothing in it will be committed.'
      : '.unknot/ holds config, decisions and records meant to be committed; local state (state/, cas/, runs/, worktrees/, telemetry/, config.proposed.yaml) is already ignored by .unknot/.gitignore. To keep Unknot out of a shared repository, add `.unknot/` to .git/info/exclude (local only) or .gitignore.',
    '',
    'A read-only assessment (map, diagnose, decompose, explain) works now. Accepting the configuration, keys and approvals are only for changing code.',
    `To review the proposal: ${humanCommand('config diff')}`,
    'To accept it (a person, in a separate terminal window): unknot config accept. To register as an approver: unknot keys generate <name>, then add the printed block under approvers:.',
  ];
  output(flags.json ? { proposed, detected: d, state_dir, ...(update && { update: { ...update, written: !nothingNew } }) } : msg.join('\n'), { json: flags.json });
}
