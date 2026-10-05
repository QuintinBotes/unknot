import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferTargets } from '../../../../adapters/delivery/ci.mjs';
import adapter from '../../../../adapters/delivery/index.mjs';

const job = (id) => ({ id, steps: [], matrix: {}, workingDirectories: [] });
const targets = (id) => inferTargets(job(id), []).targets;

test('job-name targets keep service words and non-ASCII letters', () => {
  assert.deepEqual(targets('deploy-upload-service'), ['upload-service']);
  assert.deepEqual(targets('rollout-update-api'), ['rollout-update-api']);
  assert.deepEqual(targets('deploy-preview-qa-web'), ['web']);
  assert.deepEqual(targets('deploy-café'), ['café']);
  assert.deepEqual(targets('🚀 deploy'), []);
});

test('deploy_step: a restore drill runs no deploy step, a kubectl job does', () => {
  const wf = (steps) => `name: Drill\non: push\njobs:\n  restore-drill:\n    runs-on: ubuntu-latest\n    environment: staging\n    steps:\n${steps}\n`;
  const attrs = (yml) => adapter.extract({ path: '.github/workflows/drill.yml', size: 0, language: null, kind: 'config', blob: 'x' }, yml, {})
    .find((f) => f.kind === 'node' && f.id === 'job:.github/workflows/drill.yml#restore-drill').attrs;
  const drill = attrs(wf('      - uses: actions/checkout@v4\n      - run: python manage.py migrate # backup restore'));
  assert.equal(drill.deploy_step, false);
  assert.equal(attrs(wf('      - run: kubectl apply -f k8s/')).deploy_step, true);
});
