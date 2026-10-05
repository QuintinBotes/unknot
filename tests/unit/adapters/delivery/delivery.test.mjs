import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import adapter from '../../../../adapters/delivery/index.mjs';
import { assertFact, nodeFact, prov } from '../../../../runtime/graph/facts.mjs';

const fx = (name) => readFileSync(fileURLToPath(new URL(`../../../fixtures/delivery/${name}`, import.meta.url)), 'utf8');

/** Run extract on a fixture as if it lived at `path` in the repo. */
function run(fixture, path) {
  const facts = adapter.extract({ path, size: 0, language: null, kind: 'config', blob: 'x' }, fx(fixture), {});
  facts.forEach(assertFact);
  return facts;
}
const node = (facts, id) => facts.find((f) => f.kind === 'node' && f.id === id);
const edges = (facts, type, from, to) => facts.filter((f) => f.kind === 'edge' && f.type === type && (!from || f.from === from) && (!to || f.to === to));

const WF = '.github/workflows';

test('adapter shape and capabilities', () => {
  assert.equal(adapter.id, 'delivery');
  assert.equal(adapter.kind, 'delivery');
  assert.equal(adapter.version, '0.1.2');
  assert.equal(adapter.capabilities.network, false);
  assert.deepEqual(adapter.capabilities.executes, []);
  assert.ok(adapter.capabilities.files.includes('Jenkinsfile'));
  assert.deepEqual(adapter.extract({ path: 'README.md' }, 'x', {}), []);
});

test('github actions: workflow attrs, jobs, needs and dependencies', () => {
  const f = run('gha-ci.yml', `${WF}/ci.yml`);
  const wf = node(f, `workflow:${WF}/ci.yml`);
  assert.deepEqual(wf.attrs.triggers, ['pull_request', 'push']);
  assert.deepEqual(wf.attrs.path_filters, ['services/checkout/**']);
  assert.equal(wf.attrs.permissions_broad, false);
  assert.deepEqual(wf.attrs.concurrency, { group: 'ci-${{ github.ref }}', cancel_in_progress: true });
  assert.deepEqual(wf.attrs.env_names, ['NODE_ENV']);
  assert.deepEqual(wf.attrs.secrets, ['CI_API_KEY']);
  assert.equal(wf.provenance.confidence, 'high');
  assert.equal(wf.provenance.extractor, 'delivery@0.1.2');
  const test_ = node(f, `job:${WF}/ci.yml#test`);
  assert.equal(test_.attrs.steps, 5);
  assert.equal(test_.attrs.deploy_signal, false);
  assert.equal(edges(f, 'CONTAINS', `workflow:${WF}/ci.yml`).length, 2);
  assert.equal(edges(f, 'DEPENDS_ON', `job:${WF}/ci.yml#lint`, `job:${WF}/ci.yml#test`).length, 1);

  const checkout = node(f, 'dependency:gha:actions/checkout');
  assert.equal(checkout.attrs.pinned, false);
  assert.equal(checkout.attrs.ref, 'v4');
  const setup = node(f, 'dependency:gha:actions/setup-node');
  assert.equal(setup.attrs.pinned, true);
  const local = node(f, 'dependency:gha:./.github/actions/setup-cache');
  assert.equal(local.attrs.local, true);
  assert.equal(edges(f, 'DEPENDS_ON', `job:${WF}/ci.yml#test`, 'dependency:gha:actions/checkout').length, 1);
});

test('github actions: SHA-pinned action, write-all permissions and secret names only', () => {
  const f = run('gha-release.yml', `${WF}/release.yml`);
  assert.equal(node(f, 'dependency:gha:actions/checkout').attrs.pinned, true);
  const wf = node(f, `workflow:${WF}/release.yml`);
  assert.equal(wf.attrs.permissions_broad, true);
  assert.equal(wf.attrs.permissions, 'write-all');
  assert.deepEqual(wf.attrs.secrets, ['NPM_TOKEN']);
  const job = node(f, `job:${WF}/release.yml#publish`);
  assert.equal(job.attrs.environment, 'npm');
  assert.equal(job.attrs.deploy_signal, true);
  assert.ok(!JSON.stringify(f).includes('NODE_AUTH_TOKEN_VALUE'));
});

test('github actions: pull_request_target checking out the PR head is flagged; missing permissions are broad', () => {
  const f = run('gha-pr-target.yml', `${WF}/label.yml`);
  const wf = node(f, `workflow:${WF}/label.yml`);
  assert.deepEqual(wf.attrs.dangerous_patterns, ['pull_request_target_checkout_pr_head']);
  assert.equal(wf.attrs.permissions_broad, true);
  assert.equal(node(f, `job:${WF}/label.yml#label`).attrs.permissions_broad, true);
  // The same checkout under a plain pull_request trigger is not dangerous.
  const g = run('gha-ci.yml', `${WF}/ci.yml`);
  assert.equal(node(g, `workflow:${WF}/ci.yml`).attrs.dangerous_patterns, undefined);
});

test('github actions: deployable inference from commands, matrix, name and path filters', () => {
  const d = run('gha-deploy.yml', `${WF}/deploy.yml`);
  const job = node(d, `job:${WF}/deploy.yml#deploy-checkout`);
  assert.deepEqual(job.attrs.deploys, ['checkout']);
  assert.deepEqual(job.attrs.deploy_evidence, ['command']);
  assert.equal(node(d, `job:${WF}/deploy.yml#build`).attrs.deploy_signal, false);
  const dep = node(d, 'deployable:checkout');
  assert.equal(dep.provenance.confidence, 'low');
  assert.equal(dep.provenance.source_type, 'inference');
  assert.equal(edges(d, 'DEPLOYS', `job:${WF}/deploy.yml#deploy-checkout`, 'deployable:checkout').length, 1);

  const s = run('gha-deploy-search.yml', `${WF}/search.yml`);
  const ship = node(s, `job:${WF}/search.yml#ship`);
  assert.deepEqual(ship.attrs.deploys, ['search']);
  assert.deepEqual(ship.attrs.deploy_evidence, ['path_filter']);
  const mx = node(s, `job:${WF}/search.yml#matrix-deploy`);
  assert.deepEqual(mx.attrs.deploys, ['billing', 'ledger']);
  assert.deepEqual(mx.attrs.deploy_evidence, ['matrix']);
});

test('gitlab ci: anchors, environments, image pinning, rules:changes and includes', () => {
  const f = run('gitlab-ci.yml', '.gitlab-ci.yml');
  const wf = node(f, 'workflow:.gitlab-ci.yml');
  assert.deepEqual(wf.attrs.stages, ['build', 'test', 'deploy']);
  assert.deepEqual(wf.attrs.path_filters, ['services/checkout/**/*']);
  assert.equal(wf.provenance.confidence, 'medium');
  const build = node(f, 'job:.gitlab-ci.yml#build');
  assert.equal(build.attrs.image, 'node:22');
  assert.equal(build.attrs.image_pinned, false);
  assert.equal(build.attrs.steps, 2);
  assert.equal(edges(f, 'DEPENDS_ON', 'job:.gitlab-ci.yml#unit', 'job:.gitlab-ci.yml#build').length, 1);
  assert.equal(node(f, 'job:.gitlab-ci.yml#deploy_staging').attrs.environment, 'staging');
  assert.equal(node(f, 'job:.gitlab-ci.yml#deploy_staging').attrs.image_pinned, true);
  const prod = node(f, 'job:.gitlab-ci.yml#deploy_prod');
  assert.equal(prod.attrs.environment, 'production');
  assert.equal(prod.attrs.image_pinned, false);
  assert.equal(prod.attrs.manual, true);
  assert.deepEqual(prod.attrs.deploys, ['checkout']);
  assert.equal(node(f, 'dependency:gitlab:platform/ci-templates').attrs.pinned, false);
  assert.equal(node(f, '.base'), undefined);
});

test('circleci, azure, buildkite, bitbucket, jenkins map to the same scheme', () => {
  const c = run('circleci.yml', '.circleci/config.yml');
  assert.equal(node(c, 'dependency:circleci:circleci/node').attrs.pinned, true);
  assert.equal(node(c, 'dependency:circleci:circleci/aws-cli').attrs.pinned, false);
  const cd = node(c, 'job:.circleci/config.yml#deploy');
  assert.deepEqual(cd.attrs.needs, ['build']);
  assert.equal(cd.attrs.conditional, true);
  assert.deepEqual(cd.attrs.deploys, ['billing']);

  const a = run('azure-pipelines.yml', 'azure-pipelines.yml');
  const dl = node(a, 'job:azure-pipelines.yml#DeployLedger');
  assert.equal(dl.attrs.environment, 'prod');
  assert.deepEqual(dl.attrs.deploys, ['ledger']);
  assert.equal(node(a, 'dependency:azure-task:Kubernetes').attrs.ref, '1');
  assert.deepEqual(node(a, 'workflow:azure-pipelines.yml').attrs.path_filters, ['services/ledger/*']);

  const b = run('buildkite-pipeline.yml', '.buildkite/pipeline.yml');
  assert.deepEqual(node(b, 'job:.buildkite/pipeline.yml#ship').attrs.needs, ['test']);
  assert.equal(node(b, 'dependency:buildkite:docker-compose').attrs.pinned, true);
  assert.equal(node(b, 'dependency:buildkite:ecr').attrs.pinned, false);
  assert.equal(node(b, 'job:.buildkite/pipeline.yml#ship').attrs.deploy_signal, true);

  const bb = run('bitbucket-pipelines.yml', 'bitbucket-pipelines.yml');
  const prod = node(bb, 'job:bitbucket-pipelines.yml#deploy-to-production');
  assert.equal(prod.attrs.environment, 'production');
  assert.equal(prod.attrs.conditional, true);
  assert.equal(node(bb, 'dependency:bitbucket-pipe:atlassian/aws-s3-deploy').attrs.pinned, true);

  const j = run('Jenkinsfile', 'Jenkinsfile');
  const dp = node(j, 'job:Jenkinsfile#deploy-pricing');
  assert.equal(dp.provenance.confidence, 'low');
  assert.equal(dp.attrs.deploy_signal, true);
  assert.equal(dp.attrs.conditional, true);
  assert.deepEqual(dp.attrs.deploys, ['pricing']);
  assert.equal(node(j, 'job:Jenkinsfile#build').attrs.deploy_signal, false);
  assert.equal(node(j, 'dependency:jenkins-lib:shared-pipeline').attrs.pinned, true);
});

test('build topology: Makefile targets and dependencies', () => {
  const f = run('Makefile', 'Makefile');
  const ids = f.filter((x) => x.kind === 'node').map((x) => x.id);
  assert.deepEqual(ids, ['build_target:Makefile#all', 'build_target:Makefile#build', 'build_target:Makefile#deploy', 'build_target:Makefile#deps', 'build_target:Makefile#test']);
  assert.equal(node(f, 'build_target:Makefile#build').attrs.phony, true);
  assert.equal(node(f, 'build_target:Makefile#deploy').attrs.deploy_signal, true);
  assert.equal(edges(f, 'DEPENDS_ON', 'build_target:Makefile#build', 'build_target:Makefile#deps').length, 1);
  assert.equal(edges(f, 'DEPENDS_ON', 'build_target:Makefile#all').length, 2);
});

test('build topology: nx, turbo, pnpm, bazel', () => {
  const ws = run('nx.json', 'nx.json');
  assert.equal(node(ws, 'workspace:.').attrs.tool, 'nx');

  const p = run('nx-project-web.json', 'apps/web/project.json');
  const web = node(p, 'build_target:web');
  assert.deepEqual(web.attrs.tags, ['scope:shop', 'type:app']);
  assert.deepEqual(web.attrs.targets, ['build', 'serve', 'test']);
  assert.equal(edges(p, 'DEPENDS_ON', 'build_target:web', 'build_target:ui').length, 1);
  assert.equal(edges(p, 'DEPENDS_ON', 'build_target:web').length, 1);

  const t = run('turbo.json', 'turbo.json');
  assert.equal(edges(t, 'DEPENDS_ON', 'build_target:turbo.json#build', 'build_target:turbo.json#codegen').length, 1);
  assert.equal(node(t, 'build_target:turbo.json#dev').attrs.persistent, true);

  const pn = run('pnpm-workspace.yaml', 'pnpm-workspace.yaml');
  assert.deepEqual(node(pn, 'workspace:.').attrs.package_globs, ['apps/*', 'packages/*']);

  const bz = run('BUILD.bazel', 'services/orders/BUILD.bazel');
  const orders = node(bz, 'build_target://services/orders:orders');
  assert.deepEqual(orders.attrs.deps, ['//libs/log:log', '//services/orders:models']);
  assert.deepEqual(orders.attrs.external_deps, ['@com_github_pkg_errors//:errors']);
  assert.equal(orders.provenance.confidence, 'low');
  assert.equal(edges(bz, 'DEPENDS_ON', 'build_target://services/orders:orders', 'build_target://services/orders:models').length, 1);
});

test('feature flags: launchdarkly and unleash definitions', () => {
  const ld = run('flags.json', 'config/flags.json');
  const nc = node(ld, 'feature_flag:new-checkout');
  assert.equal(nc.attrs.default, true);
  assert.equal(nc.attrs.archived, false);
  assert.equal(nc.attrs.last_modified, 1700000000000);
  assert.equal(node(ld, 'feature_flag:old-banner').attrs.archived, true);
  const un = run('unleash.json', 'ops/unleash-flags.json');
  assert.equal(node(un, 'feature_flag:dark-mode').attrs.source, 'unleash');
  assert.equal(node(un, 'feature_flag:dark-mode').attrs.default, false);
});

test('extraction is deterministic', () => {
  assert.deepEqual(run('gha-deploy.yml', `${WF}/deploy.yml`), run('gha-deploy.yml', `${WF}/deploy.yml`));
});

test('link: co-deployed deployables and duplicate pipelines', () => {
  const factsByFile = new Map();
  for (const [fixture, path] of [
    ['gha-deploy.yml', `${WF}/deploy.yml`],
    ['gha-deploy-staging.yml', `${WF}/deploy-staging.yml`],
    ['gha-deploy-search.yml', `${WF}/search.yml`],
    ['gha-ci.yml', `${WF}/ci.yml`],
  ]) factsByFile.set(path, run(fixture, path));
  const out = adapter.link({ files: new Map(), factsByFile, options: {} });
  out.forEach(assertFact);
  const dep = (name) => out.find((f) => f.id === `deployable:${name}`);
  assert.deepEqual(dep('checkout').attrs.co_deployed_with, ['pricing']);
  assert.deepEqual(dep('pricing').attrs.co_deployed_with, ['checkout']);
  // Same job (matrix) => together; a path-filtered workflow does not group its separate jobs.
  assert.deepEqual(dep('billing').attrs.co_deployed_with, ['ledger']);
  assert.equal(dep('search'), undefined);

  const dups = out.filter((f) => f.type === 'workflow');
  const dup = dups.find((f) => f.attrs.duplicate_of);
  assert.ok(dup, 'near-duplicate deploy workflows are detected');
  assert.ok(dup.attrs.duplicate_similarity >= 0.85);
  assert.deepEqual(new Set([dup.id, dup.attrs.duplicate_of]), new Set([`workflow:${WF}/deploy.yml`, `workflow:${WF}/deploy-staging.yml`]));
  assert.equal(dups.some((f) => f.id === `workflow:${WF}/ci.yml`), false);
});

test('link: flag references recorded by language adapters', () => {
  const p = prov({ source_type: 'ast', source_ref: 'src/a.ts:1', extractor: 'javascript@0.1.0' });
  const factsByFile = new Map([
    ['config/flags.json', run('flags.json', 'config/flags.json')],
    ['src/a.ts', [nodeFact('module', 'src/a.ts', { path: 'src/a.ts', attrs: { flags: ['new-checkout', 'unknown'] } }, p)]],
  ]);
  const out = adapter.link({ files: new Map(), factsByFile, options: {} });
  const flag = out.find((f) => f.id === 'feature_flag:new-checkout');
  assert.deepEqual(flag.attrs.referenced_in, ['src/a.ts']);
  assert.equal(out.filter((f) => f.kind === 'edge').length, 1);
  assert.equal(adapter.link({ files: new Map(), factsByFile: new Map(), options: {} }).length, 0);
});
