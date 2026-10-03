// /unknot:init — detect the project's toolchain and propose a configuration. It writes
// only .unknot/config.proposed.yaml (spec §4.1: config-only write); a human accepts it.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringifyYAML } from '../../core/yaml.mjs';
import { DEFAULT_CONFIG } from '../../policy/defaults.mjs';
import { appendEvent } from '../../state/ledger.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

function readJSON(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
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
    approvals: { medium: ['code-owner'], high: ['code-owner', 'security-owner'], expiry: '72h' },
    telemetry: { enabled: false },
  };
  writeFileSync(ctx.paths.proposedConfig, stringifyYAML(proposed));
  appendEvent(ctx, { type: 'config.proposed', actor, payload: { commands: Object.keys(d.commands) } });
  const msg = [
    'Wrote .unknot/config.proposed.yaml (mode: plan). Nothing else was changed.',
    `Detected commands: ${Object.entries(d.commands).map(([k, v]) => `${k} = ${v.join(' ')}`).join('; ') || 'none'}.`,
    ...d.notes,
    'To review: unknot config diff. To accept (a human, in a terminal): unknot config accept.',
    'To register yourself as an approver: unknot keys generate <name>, then add the printed block under approvers:.',
  ];
  output(flags.json ? { proposed, detected: d } : msg.join('\n'), { json: flags.json });
}
