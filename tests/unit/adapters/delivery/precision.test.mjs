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

test('a script in a deploy/ folder is not a deploy step; a script named deploy is (precision re-check)', async () => {
  const { hasDeployStep } = await import('../../../../adapters/delivery/ci.mjs');
  assert.equal(hasDeployStep([{ run: './deploy/backup/restore-drill.sh' }]), false);
  assert.equal(hasDeployStep([{ run: './scripts/deploy.sh prod' }]), true);
});

test('a release URL in a download command is not a deploy step', async () => {
  const { hasDeployStep } = await import('../../../../adapters/delivery/ci.mjs');
  assert.equal(hasDeployStep([{ run: 'curl -fsSL -o mc "https://dl.min.io/client/mc/release/linux-amd64/archive/mc.RELEASE.2025-08-13T08-35-41Z"' }]), false);
});

test('prose in a script is no deploy, and a job that creates its own cluster tests the deployment', () => {
  const attrsOf = (id, steps) => {
    const yml = `name: Publish\non: push\njobs:\n  ${id}:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
    return adapter.extract({ path: '.github/workflows/p.yml', size: 0, language: null, kind: 'config', blob: 'x' }, yml, {})
      .find((f) => f.kind === 'node' && f.id === `job:.github/workflows/p.yml#${id}`).attrs;
  };
  const prepare = attrsOf('prepare-variables', '      - run: |\n          # Only stable semver releases can be tagged as latest.\n          echo "Tag is not a semver release - skipping"\n          echo "latest=false" >> $GITHUB_OUTPUT');
  assert.ok(!prepare.deploy_signal, 'a comment and an echo naming a release deploy nothing');
  const kind = attrsOf('deploy-and-test-cluster', '      - uses: helm/kind-action@v1\n      - run: kubectl apply -f k8s/\n      - run: kubectl wait --for=condition=ready pod -l app=petclinic');
  assert.ok(!kind.deploy_signal, 'a deploy to a cluster the job creates is a test');
  assert.equal(attrsOf('deploy-prod', '      - run: kubectl apply -f k8s/').deploy_signal, true);
});
