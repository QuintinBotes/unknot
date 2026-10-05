import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detect } from '../../../runtime/cli/commands/init.mjs';
import { DEFAULT_CONFIG } from '../../../runtime/policy/defaults.mjs';
import { matchAny } from '../../../runtime/core/glob.mjs';

test('lint and typecheck are proposed from tool config plus dependency when no script exists; missing tools are noted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-init-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'no-such-runner-xyz test' }, devDependencies: { eslint: '^8', typescript: '^5' } }));
    writeFileSync(join(dir, '.eslintrc'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    mkdirSync(join(dir, '.husky'));
    const d = detect(dir);
    assert.deepEqual(d.commands.lint, ['npx', '--no', 'eslint', '.']);
    assert.deepEqual(d.commands.typecheck, ['npx', '--no', 'tsc', '--noEmit']);
    assert.ok(d.notes.some((n) => /node_modules is missing/.test(n)));
    assert.ok(d.notes.some((n) => /test_unit runs `no-such-runner-xyz`/.test(n)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CI definitions of every parsed system and git hooks are protected by default', () => {
  for (const p of ['.gitlab-ci.yml', '.gitlab/ci/deploy.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'ci/Jenkinsfile', '.buildkite/pipeline.yml', 'bitbucket-pipelines.yml', '.husky/pre-commit', '.github/workflows/ci.yml']) {
    assert.ok(matchAny(p, DEFAULT_CONFIG.protected_paths), p);
  }
});
