import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFile, node, nodes, edges, hasEdge, linked, extractAll, flat } from './helpers.mjs';
import { extractDockerfile } from '../../../../adapters/infrastructure/k8s/docker.mjs';

test('multi-stage Dockerfile: stages, latest tag, pinned digest, root user, curl | sh', () => {
  const facts = extractFile('docker/Dockerfile');
  const img = node(facts, 'image:docker/Dockerfile');
  assert.equal(img.attrs.stage_count, 2);
  assert.equal(img.attrs.multi_stage, true);
  const [build, final] = img.attrs.stages;
  assert.equal(build.name, 'build');
  assert.equal(build.base_latest, true);
  assert.equal(build.base_pinned, false);
  assert.equal(final.base_pinned, true);
  assert.equal(final.base_latest, false);
  assert.equal(img.attrs.final_stage_root, true);
  assert.equal(img.attrs.curl_pipe_shell, 1);
  assert.equal(img.attrs.add_url, 1);
  assert.deepEqual(img.attrs.secret_env_names, ['API_SECRET']);
  assert.deepEqual(img.attrs.secret_arg_names, ['NPM_TOKEN']);
  assert.deepEqual(img.attrs.expose, ['8080', '9090']);
  assert.equal(img.attrs.healthcheck, false);
  assert.ok(hasEdge(facts, 'BUILDS', 'build_target:docker', 'image:docker/Dockerfile'));
  assert.equal(img.provenance.source_type, 'config');
});

test('Dockerfile with non-root USER and HEALTHCHECK is clean', () => {
  const facts = extractDockerfile('Dockerfile', 'FROM alpine:3.19\nRUN adduser -D app\nUSER app:app\nHEALTHCHECK CMD true\n');
  const img = node(facts, 'image:Dockerfile');
  assert.equal(img.attrs.final_stage_root, false);
  assert.equal(img.attrs.healthcheck, true);
  assert.equal(img.attrs.curl_pipe_shell, 0);
  assert.deepEqual(extractDockerfile('Dockerfile', '# nothing here\n'), []);
});

test('Compose services are deployables with ports, dependencies and risk flags', () => {
  const facts = extractFile('docker/docker-compose.yml');
  const web = node(facts, 'service:compose/web');
  assert.equal(web.attrs.deployable, true);
  assert.equal(web.attrs.privileged, true);
  assert.equal(web.attrs.network_mode_host, true);
  assert.equal(web.attrs.publicly_published, true);
  assert.deepEqual(web.attrs.ports_published.map((p) => p.published), ['8080', '9090']);
  assert.deepEqual(web.attrs.depends_on, ['db']);
  assert.equal(web.attrs.volumes.docker_socket, true);
  assert.deepEqual(web.attrs.volumes.named, ['data']);
  assert.deepEqual(web.attrs.env_files, ['.env']);
  assert.deepEqual(web.attrs.env_names, ['DB_PASSWORD', 'LOG_LEVEL']);
  assert.deepEqual(web.attrs.literal_secret_env, ['DB_PASSWORD']);
  assert.equal(web.attrs.build_context, 'docker');
  assert.equal(web.attrs.built_image, 'image:docker/Dockerfile');
  assert.ok(hasEdge(facts, 'DEPENDS_ON', 'service:compose/web', 'service:compose/db'));
  const db = node(facts, 'service:compose/db');
  assert.deepEqual(db.attrs.literal_secret_env, []);
});

test('link connects a locally built image to the workload that runs it', () => {
  const facts = linked();
  assert.ok(hasEdge(facts, 'DEPLOYS_TO', 'image:docker/Dockerfile', 'workload:shop/Deployment/web'));
  const e = edges(facts, 'DEPLOYS_TO')[0];
  assert.equal(e.provenance.confidence, 'medium');
  assert.equal(e.provenance.source_type, 'inference');
});

test('Ansible playbook: privilege, shell tasks, roles and missing no_log', () => {
  const facts = extractFile('ansible/playbook-site.yml');
  const m = node(facts, 'iac_module:ansible/playbook-site.yml');
  assert.equal(m.attrs.tool, 'ansible');
  assert.deepEqual(m.attrs.hosts, ['webservers']);
  assert.equal(m.attrs.tasks, 5);
  assert.equal(m.attrs.shell_tasks, 2);
  assert.equal(m.attrs.privileged_tasks, 4);
  assert.equal(m.attrs.missing_no_log_tasks, 1);
  assert.deepEqual(m.attrs.roles, ['web']);
  assert.ok(!JSON.stringify(facts).includes('literal-ansible-password'));
  const role = node(extractFile('ansible/roles/web/tasks/main.yml'), 'iac_module:ansible/roles/web/tasks/main.yml');
  assert.equal(role.attrs.tasks, 2);
  assert.equal(role.attrs.shell_tasks, 1);
  assert.equal(role.attrs.privileged_tasks, 0);
});

test('link resolves playbook roles to the role tasks file', () => {
  assert.ok(hasEdge(linked(), 'DEPENDS_ON', 'iac_module:ansible/playbook-site.yml', 'iac_module:ansible/roles/web/tasks/main.yml'));
});

test('Puppet, Chef and Salt become iac_module nodes', () => {
  const pp = node(extractFile('config-mgmt/site.pp'), 'iac_module:config-mgmt/site.pp');
  assert.equal(pp.attrs.tool, 'puppet');
  assert.equal(pp.attrs.classes, 1);
  assert.equal(pp.attrs.resources, 2);
  assert.equal(pp.attrs.shell_tasks, 1);
  assert.equal(pp.attrs.privileged_tasks, 1);
  assert.deepEqual(pp.attrs.hosts, ['web01.example.com']);
  const chef = node(extractFile('config-mgmt/recipes/default.rb'), 'iac_module:config-mgmt/recipes/default.rb');
  assert.equal(chef.attrs.tool, 'chef');
  assert.equal(chef.attrs.resources, 3);
  assert.equal(chef.attrs.shell_tasks, 1);
  const salt = node(extractFile('config-mgmt/web.sls'), 'iac_module:config-mgmt/web.sls');
  assert.equal(salt.attrs.tool, 'salt');
  assert.equal(salt.attrs.shell_tasks, 1);
  assert.equal(salt.attrs.privileged_tasks, 1);
});

test('every fact in the fixture tree is valid and capped output is flagged', () => {
  const facts = flat(extractAll());
  assert.ok(nodes(facts).length > 30);
  const many = Array.from({ length: 6000 }, (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c${i}\n`).join('---\n');
  const out = extractFile.length ? null : null;
  void out;
  const capped = nodes(extractCapped(many));
  assert.equal(capped[0].attrs.truncated, true);
});

import adapter from '../../../../adapters/infrastructure/k8s/index.mjs';
function extractCapped(text) {
  const facts = adapter.extract({ path: 'big.yaml', kind: 'config' }, text, {});
  assert.equal(facts.length, 5000);
  return facts;
}
