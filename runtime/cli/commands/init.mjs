// /unknot:init — detect the project's toolchain and propose a configuration. It writes
// only .unknot/config.proposed.yaml (spec §4.1: config-only write); a human accepts it.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { stringifyYAML } from '../../core/yaml.mjs';
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

/** Detect commands without running anything. Every entry says where it came from. */
export function detect(root) {
  const commands = {};
  const notes = [];
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
  const protectedPaths = [...DEFAULT_CONFIG.protected_paths];
  const evidence = structuredClone(DEFAULT_CONFIG.evidence);
  const top = readdirSync(root);
  if (top.includes('terraform') || top.includes('infra')) protectedPaths.push('**/*.tfstate*');
  return { commands, notes, protectedPaths, evidence };
}

export async function run({ flags }) {
  const { ctx, actor } = open(flags, { create: true });
  const d = detect(ctx.root);
  const proposed = {
    version: 1,
    mode: 'plan',
    scope: { include: [], exclude: DEFAULT_CONFIG.scope.exclude },
    protected_paths: [...new Set(d.protectedPaths)],
    commands: d.commands,
    limits: { max_changed_files: 12, max_diff_lines: 500, max_runtime_minutes: 30, max_network_requests: 0 },
    quality: { forbid_new_cycles: true, public_api_compatibility: 'required' },
    security: { secrets_scan: 'required', sast: 'required_for_high_risk', dependency_changes: 'approval_required' },
    database: { live_access: 'disabled', destructive_execution: 'forbidden' },
    infrastructure: { apply: 'forbidden', destroy: 'forbidden', require_saved_plan: true },
    // Approval roles are left to the built-in defaults (spec §20); a proposal never
    // starts looser than them.
    approvals: { expiry: '72h' },
    telemetry: { enabled: false },
  };
  writeFileSync(ctx.paths.proposedConfig, stringifyYAML(proposed));
  appendEvent(ctx, { type: 'config.proposed', actor, payload: { commands: Object.keys(d.commands) } });
  // .unknot/ itself is ignored only when someone excluded it; its own .gitignore covers local state.
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', '.unknot/config.yaml'], { cwd: ctx.root, stdio: 'ignore' }).status === 0;
  const state_dir = { path: '.unknot', ignored, exclude_line: '.unknot/' };
  const msg = [
    'Wrote .unknot/config.proposed.yaml (mode: plan). Nothing else was changed, and nothing is activated.',
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
  output(flags.json ? { proposed, detected: d, state_dir } : msg.join('\n'), { json: flags.json });
}
