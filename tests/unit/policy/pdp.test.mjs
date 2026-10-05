import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';

const { decide, alwaysOn, toOperation } = K.pdp;

after(() => K.cleanup());

const FILES = {
  'src/auth/login.js': 'x\n',
  'src/generated/g.js': 'x\n',
  '.github/workflows/ci.yml': 'x\n',
  'vendor/v.js': 'x\n',
  'dist/o.js': 'x\n',
  'build/b.js': 'x\n',
  'docs/architecture/x.md': 'x\n',
  '.env': 'TOKEN=abc\n',
  '.env.example': 'TOKEN=\n',
  'config/server.pem': 'x\n',
};

let counter = 5000;
/** A project, an apply run, and (optionally) a PATCHING slice with a real worktree. */
function world({ command = 'apply', mode = 'assist', state = 'PATCHING', risk = 'low', include = ['src/**', 'docs/**'], exclude = [], config: over = {}, noSlice = false } = {}) {
  const p = K.makeProject({ files: FILES });
  const config = K.cfg({ mode, ...over });
  const id = `UK-${++counter}`;
  const wtInfo = K.worktree.createWorktree(p.ctx, id, p.commit);
  const slice = noSlice ? null : K.insertSlice(p.ctx, { id, state, risk, body: { scope: { include, exclude } }, worktree: wtInfo.path, baseline: p.commit });
  const { run } = K.startTestRun(p, { command, mode, over, slice_id: noSlice ? null : id });
  return { p, ctx: p.ctx, config, run, slice, wt: wtInfo.path, id };
}

const dec = (w, tool, input, extra = {}) =>
  decide({ ctx: w.ctx, config: w.config, run: w.run, slice: w.slice, op: toOperation(tool, input, w.p.dir), pluginRoot: K.REPO_ROOT, ...extra });
const write = (w, rel, extra) => dec(w, 'Write', { file_path: join(w.wt, rel), content: 'x' }, extra);
const policy = (d) => d.policy_ids[0];

describe('toOperation', () => {
  const cwd = '/proj';
  test('maps tools to operations', () => {
    assert.deepEqual(toOperation('Read', { file_path: 'a.js' }, cwd), { op: 'fs.read', tool: 'Read', paths: ['/proj/a.js'] });
    assert.deepEqual(toOperation('Read', { file_path: '/abs/x' }, cwd).paths, ['/abs/x']);
    assert.deepEqual(toOperation('Grep', {}, cwd).paths, ['/proj']);
    assert.deepEqual(toOperation('Glob', { path: 'src' }, cwd).paths, ['/proj/src']);
    assert.equal(toOperation('Edit', { file_path: 'a' }, cwd).op, 'fs.write');
    assert.equal(toOperation('MultiEdit', { file_path: 'a' }, cwd).op, 'fs.write');
    assert.deepEqual(toOperation('NotebookEdit', { notebook_path: 'n.ipynb' }, cwd).paths, ['/proj/n.ipynb']);
    assert.deepEqual(toOperation('Bash', { command: 'ls' }, cwd), { op: 'exec', tool: 'Bash', command: 'ls' });
    assert.equal(toOperation('Bash', {}, cwd).command, '');
  });

  test('network, agent, mcp, inert, unknown', () => {
    assert.equal(toOperation('WebFetch', { url: 'https://Docs.Example.com/x' }, cwd).domain, 'docs.example.com');
    assert.equal(toOperation('WebFetch', { url: 'not a url' }, cwd).domain, '<invalid>');
    assert.equal(toOperation('WebSearch', { query: 'q' }, cwd).domain, 'web-search');
    assert.deepEqual(toOperation('Task', { subagent_type: 'Explore' }, cwd), { op: 'agent.spawn', tool: 'Task', agent_type: 'Explore' });
    assert.equal(toOperation('Agent', {}, cwd).agent_type, null);
    assert.deepEqual(toOperation('mcp__github__create_issue', {}, cwd), { op: 'mcp', tool: 'mcp__github__create_issue', server: 'github', name: 'create_issue' });
    assert.equal(toOperation('mcp__plugin_unknot_unknot__status', {}, cwd).server, 'plugin_unknot_unknot');
    assert.equal(toOperation('TodoWrite', {}, cwd).op, 'inert');
    assert.equal(toOperation('Teleport', {}, cwd).op, 'unknown');
    assert.equal(toOperation('', {}, cwd).op, 'unknown');
  });

  test('missing write path yields a null path that is denied', () => {
    const w = world();
    const d = dec(w, 'Write', {});
    assert.equal(d.decision, 'deny');
  });
});

describe('decide: reads', () => {
  const w = world({ command: 'diagnose', mode: 'plan', noSlice: true });
  const read = (path, extra) => dec(w, 'Read', { file_path: path }, extra);

  test('ordinary source reads are allowed', () => {
    for (const f of ['src/a.js', 'README.md', 'src/auth/login.js', '.env.example', 'docs/architecture/x.md']) {
      assert.equal(read(join(w.p.dir, f)).decision, 'allow', f);
    }
  });

  test('secret files are denied (case-insensitive, any depth)', () => {
    const secrets = ['.env', '.env.local', '.env.production', 'config/server.pem', 'a/b/.ENV', 'keys/id_rsa', 'keys/id_ed25519.pub', '.npmrc', '.aws/credentials', 'infra/terraform.tfstate', 'infra/prod.tfvars', 'x/secrets.yaml', 'sa/service-account-prod.json', '.git-credentials', 'k/foo.PEM'];
    for (const f of secrets) {
      const d = read(join(w.p.dir, f));
      assert.equal(d.decision, 'deny', f);
      assert.equal(policy(d), 'secrets.read', f);
    }
  });

  test('reads outside the project and outside the plugin are denied', () => {
    for (const f of ['/etc/passwd', '/tmp/x', join(w.p.dir, '..', 'sibling.txt'), w.p.home]) {
      const d = read(f);
      assert.equal(d.decision, 'deny', f);
      assert.equal(policy(d), 'scope.read_outside');
    }
  });

  test('plugin files are readable, only when pluginRoot is supplied', () => {
    const f = join(K.REPO_ROOT, 'README.md');
    assert.equal(read(f).decision, 'allow');
    assert.equal(read(f, { pluginRoot: undefined }).decision, 'deny');
  });

  test('a symlink inside the project pointing outside is denied', () => {
    symlinkSync('/etc', join(w.p.dir, 'src', 'etclink'));
    const d = read(join(w.p.dir, 'src', 'etclink', 'passwd'));
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'scope.read_outside');
  });

  test('a symlink to a secret inside the project is denied by its real name', () => {
    symlinkSync(join(w.p.dir, '.env'), join(w.p.dir, 'src', 'innocent.txt'));
    const d = read(join(w.p.dir, 'src', 'innocent.txt'));
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'secrets.read');
  });

  test('a ../ traversal that lands on a secret is denied', () => {
    assert.equal(read(join(w.p.dir, 'src', '..', '.env')).decision, 'deny');
    assert.equal(read(`${w.p.dir}/src/./../config/server.pem`).decision, 'deny');
  });

  test('a subagent without fs.read in its capability cannot read', () => {
    const cap = { id: 'cap-x', ops: ['unknot.read'], write: [] };
    const d = read(join(w.p.dir, 'src/a.js'), { actor: { agent_id: 'a1', agent_type: 'cartographer' }, capability: cap });
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'capability.read');
  });

  test('foreign agents can read (but see writes below)', () => {
    assert.equal(read(join(w.p.dir, 'src/a.js'), { actor: { agent_id: 'a2', agent_type: 'general-purpose' } }).decision, 'allow');
  });

  test('nothing can outlive the run: wake-ups, monitors, cron and background commands are denied', () => {
    for (const t of ['ScheduleWakeup', 'Monitor', 'CronCreate', 'RemoteTrigger']) assert.equal(policy(dec(w, t, {})), 'tool.unknown', t);
    const bg = dec(w, 'Bash', { command: 'ls', run_in_background: true });
    assert.equal(bg.decision, 'deny');
    assert.equal(policy(bg), 'exec.background');
    assert.notEqual(policy(dec(w, 'Bash', { command: 'ls' })), 'exec.background');
  });

  test('inert tools are allowed; unknown tools are denied', () => {
    assert.equal(dec(w, 'TodoWrite', {}).decision, 'allow');
    for (const t of ['Frobnicate', 'computer', 'ExitWorktree', 'NotebookRead2']) {
      const d = dec(w, t, {});
      assert.equal(d.decision, 'deny', t);
      assert.equal(policy(d), 'tool.unknown');
    }
  });
});

describe('decide: writes', () => {
  test('observe/plan modes and read-only commands never write source', () => {
    for (const [command, mode] of [['diagnose', 'observe'], ['diagnose', 'plan'], ['map', 'observe'], ['plan', 'plan'], ['apply', 'observe'], ['apply', 'plan']]) {
      const w = world({ command, mode });
      for (const target of [join(w.wt, 'src/a.js'), join(w.p.dir, 'src/a.js')]) {
        const d = dec(w, 'Edit', { file_path: target, old_string: 'a', new_string: 'b' });
        assert.equal(d.decision, 'deny', `${command}/${mode} ${target}`);
      }
    }
  });

  test('apply in plan mode is denied with the mode explanation', () => {
    const w = world({ command: 'apply', mode: 'plan' });
    const d = write(w, 'src/a.js');
    assert.equal(policy(d), 'mode.write');
    assert.match(d.reasons[0], /mode: assist/);
  });

  test('apply + assist + PATCHING slice: in-scope write inside the worktree is allowed', () => {
    const w = world();
    const d = write(w, 'src/a.js');
    assert.equal(d.decision, 'allow');
    assert.equal(policy(d), 'fs.write.scoped');
    assert.equal(write(w, 'src/new/deep/file.js').decision, 'allow', 'new files inside scope');
  });

  test('every other slice state denies writes', () => {
    for (const state of K.machine.STATES.filter((s) => s !== 'PATCHING')) {
      const w = world({ state });
      const d = write(w, 'src/a.js');
      assert.equal(d.decision, 'deny', state);
      assert.equal(policy(d), 'slice.not_patching', state);
    }
  });

  test('no slice, or a slice with no worktree, denies writes', () => {
    assert.equal(policy(write(world({ noSlice: true }), 'src/a.js')), 'slice.not_patching');
    const w = world();
    const d = dec(w, 'Write', { file_path: join(w.wt, 'src/a.js') }, { slice: { ...w.slice, worktree: null } });
    assert.equal(policy(d), 'slice.not_patching');
  });

  test('writing the main checkout instead of the worktree is denied', () => {
    const w = world();
    const d = dec(w, 'Write', { file_path: join(w.p.dir, 'src/a.js') });
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'scope.worktree');
  });

  test('writes outside the project are denied', () => {
    const w = world();
    for (const f of ['/etc/passwd', '/tmp/pwn.js', join(w.p.dir, '..', 'pwn.js'), join(w.p.home, 'approvers/x.pem')]) {
      const d = dec(w, 'Write', { file_path: f });
      assert.equal(d.decision, 'deny', f);
    }
    assert.equal(policy(dec(w, 'Write', { file_path: '/tmp/pwn.js' })), 'scope.write_outside');
  });

  test('slice include/exclude globs are enforced', () => {
    const w = world({ include: ['src/**'], exclude: ['src/auth/**', 'src/b.js'] });
    assert.equal(write(w, 'src/a.js').decision, 'allow');
    assert.equal(policy(write(w, 'README.md')), 'scope.slice');
    assert.equal(policy(write(w, 'docs/architecture/x.md')), 'scope.slice');
    assert.equal(policy(write(w, 'src/b.js')), 'scope.slice');
    assert.equal(policy(write(w, 'src/auth/login.js')), 'scope.slice');
    assert.equal(policy(write(w, 'lib/x.js')), 'scope.slice');
  });

  test('empty include means the whole worktree is in scope, exclude still wins', () => {
    const w = world({ include: [], exclude: ['docs/**'] });
    assert.equal(write(w, 'README.md').decision, 'allow');
    assert.equal(policy(write(w, 'docs/x.md')), 'scope.slice');
  });

  test('protected paths are denied unless named explicitly and the slice is high risk', () => {
    const cases = [
      { include: ['src/**'], risk: 'high', target: 'src/auth/login.js', ok: false },
      { include: ['src/auth/login.js'], risk: 'low', target: 'src/auth/login.js', ok: false },
      { include: ['src/auth/login.js'], risk: 'medium', target: 'src/auth/login.js', ok: false },
      { include: ['src/auth/login.js'], risk: 'high', target: 'src/auth/login.js', ok: true },
      { include: ['src/auth/login.js'], risk: 'critical', target: 'src/auth/login.js', ok: true },
      { include: ['src/auth/**'], risk: 'critical', target: 'src/auth/login.js', ok: false },
      { include: ['**'], risk: 'critical', target: '.github/workflows/ci.yml', ok: false },
      { include: ['.github/workflows/ci.yml'], risk: 'high', target: '.github/workflows/ci.yml', ok: true },
    ];
    for (const c of cases) {
      const w = world({ include: c.include, risk: c.risk });
      const d = write(w, c.target);
      assert.equal(d.decision, c.ok ? 'allow' : 'deny', JSON.stringify(c));
      if (!c.ok) {
        assert.equal(policy(d), 'scope.protected');
        assert.equal(d.risk, 'high');
      }
    }
  });

  test('protected path matching is case-insensitive', () => {
    const w = world({ include: ['src/**'], risk: 'low' });
    mkdirSync(join(w.wt, 'src/Auth'), { recursive: true });
    assert.equal(policy(write(w, 'src/Auth/x.js')), 'scope.protected');
  });

  test('generated and vendored paths are denied even when in scope', () => {
    const w = world({ include: ['**'], config: { generated_paths: ['src/generated/**'] } });
    for (const f of ['src/generated/g.js', 'vendor/v.js', 'dist/o.js', 'src/node_modules/x/index.js', 'pkg/vendor/y.js']) {
      const d = write(w, f);
      assert.equal(d.decision, 'deny', f);
      assert.equal(policy(d), 'scope.generated', f);
    }
  });

  test('config scope.exclude entries (build/**, generated/**) are not writable', {}, () => {
    const w = world({ include: ['**'] });
    for (const f of ['build/b.js', 'generated/x.js']) assert.equal(write(w, f).decision, 'deny', f);
  });

  test('a slice cannot rewrite its own worktree copy of .unknot config/state', {}, () => {
    const w = world({ include: ['**'] });
    mkdirSync(join(w.wt, '.unknot'), { recursive: true });
    assert.equal(write(w, '.unknot/config.yaml').decision, 'deny');
  });

  test('git internals are not writable anywhere', () => {
    const w = world({ include: ['**'] });
    for (const f of [join(w.p.dir, '.git/config'), join(w.p.dir, '.git/hooks/pre-commit'), join(w.wt, '.git'), join(w.p.dir, 'src/.git/config')]) {
      const d = dec(w, 'Write', { file_path: f });
      assert.equal(d.decision, 'deny', f);
      assert.equal(policy(d), 'write.git', f);
    }
  });

  test('credential paths are not writable', () => {
    const w = world({ include: ['**'] });
    assert.equal(policy(write(w, '.env')), 'secrets.write');
    assert.equal(policy(write(w, 'config/server.pem')), 'secrets.write');
  });

  test('a symlink inside the worktree pointing outside is denied', () => {
    const w = world({ include: ['**'] });
    symlinkSync('/tmp', join(w.wt, 'src/out'));
    const d = write(w, 'src/out/pwn.js');
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'scope.write_outside');
  });

  test('a symlink inside the worktree pointing at the main checkout is denied', () => {
    const w = world({ include: ['**'] });
    symlinkSync(join(w.p.dir, 'src'), join(w.wt, 'src/main'));
    assert.equal(policy(write(w, 'src/main/a.js')), 'scope.worktree');
  });

  test('a symlink to .git is denied', () => {
    const w = world({ include: ['**'] });
    symlinkSync(join(w.p.dir, '.git'), join(w.wt, 'src/g'));
    assert.equal(write(w, 'src/g/config').decision, 'deny');
  });

  test('a symlinked file whose target is outside the worktree cannot be overwritten', () => {
    const w = world({ include: ['**'] });
    symlinkSync(join(w.p.dir, 'src/b.js'), join(w.wt, 'src/linked.js'));
    assert.equal(write(w, 'src/linked.js').decision, 'deny');
  });

  test('main-agent MultiEdit/NotebookEdit follow the same rules', () => {
    const w = world();
    assert.equal(dec(w, 'MultiEdit', { file_path: join(w.wt, 'src/a.js') }).decision, 'allow');
    assert.equal(dec(w, 'NotebookEdit', { notebook_path: join(w.wt, 'README.md') }).decision, 'deny');
  });

  test('plan/architecture commands may write docs only, and only in mode plan or above', () => {
    const w = world({ command: 'plan', mode: 'plan', noSlice: true });
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, 'docs/architecture/new.md') }).decision, 'allow');
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, 'docs/adr/0001.md') }).decision, 'allow');
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, '.unknot/docs/n.md') }).decision, 'allow');
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, 'src/a.js') }).decision, 'deny');
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, 'docs/other.md') }).decision, 'deny');
    const obs = world({ command: 'plan', mode: 'observe', noSlice: true });
    assert.equal(dec(obs, 'Write', { file_path: join(obs.p.dir, 'docs/architecture/new.md') }).decision, 'deny');
    const diag = world({ command: 'diagnose', mode: 'plan', noSlice: true });
    assert.equal(dec(diag, 'Write', { file_path: join(diag.p.dir, 'docs/architecture/new.md') }).decision, 'deny');
  });

  test('a docs symlink escaping the project is denied', () => {
    const w = world({ command: 'plan', mode: 'plan', noSlice: true });
    symlinkSync('/tmp', join(w.p.dir, 'docs/architecture/esc'));
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, 'docs/architecture/esc/x.md') }).decision, 'deny');
  });
});

describe('decide: subagent capabilities and profiles', () => {
  test('foreign agent types are read-only even for an approved PATCHING slice', () => {
    const w = world();
    for (const type of ['general-purpose', 'Explore', 'Plan', 'someone-elses:refactor']) {
      const actor = { agent_id: 'ag', agent_type: type };
      const d = write(w, 'src/a.js', { actor });
      assert.equal(d.decision, 'deny', String(type));
      assert.equal(d.profile, 'foreign');
      assert.equal(dec(w, 'Read', { file_path: join(w.wt, 'src/a.js') }, { actor }).decision, 'allow');
    }
  });

  test('a subagent event without agent_type is treated as foreign instead of crashing the decision',
    {},
    () => {
      const w = world();
      const actor = { agent_id: 'ag' };
      const d = write(w, 'src/a.js', { actor });
      assert.equal(d.decision, 'deny');
      assert.equal(dec(w, 'Read', { file_path: join(w.p.dir, '.env') }, { actor }).decision, 'deny');
    });

  test('analysis agents cannot write', () => {
    const w = world();
    for (const type of ['unknot:cartographer', 'unknot:verifier', 'unknot:security-reviewer', 'unknot:domain-analyst']) {
      assert.equal(write(w, 'src/a.js', { actor: { agent_id: 'a', agent_type: type } }).decision, 'deny', type);
    }
  });

  test('refactorer with a <worktree-scope> capability writes inside slice scope only', () => {
    const w = world();
    const cap = { id: 'cap-1', ops: ['fs.read', 'fs.write', 'unknot.read'], write: ['<worktree-scope>'] };
    const actor = { agent_id: 'r1', agent_type: 'unknot:refactorer' };
    assert.equal(write(w, 'src/a.js', { actor, capability: cap }).decision, 'allow');
    assert.equal(policy(write(w, 'README.md', { actor, capability: cap })), 'scope.slice');
  });

  test('refactorer capability write globs narrow the slice scope', () => {
    const w = world();
    const cap = { id: 'cap-2', ops: ['fs.read', 'fs.write'], write: ['src/a.js', 'src/sub/**'] };
    const actor = { agent_id: 'r1', agent_type: 'unknot:refactorer' };
    assert.equal(write(w, 'src/a.js', { actor, capability: cap }).decision, 'allow');
    assert.equal(write(w, 'src/sub/x/y.js', { actor, capability: cap }).decision, 'allow');
    const d = write(w, 'src/b.js', { actor, capability: cap });
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'capability.write');
    assert.equal(policy(write(w, 'src/sub.js', { actor, capability: cap })), 'capability.write');
  });

  test('documentation-curator writes docs, not source', () => {
    const w = world({ command: 'architecture', mode: 'plan', noSlice: true });
    const actor = { agent_id: 'd1', agent_type: 'unknot:documentation-curator' };
    const cap = { id: 'cap-d', ops: ['fs.read', 'fs.write'], write: ['<docs>'] };
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, 'docs/architecture/a.md') }, { actor, capability: cap }).decision, 'allow');
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, 'src/a.js') }, { actor, capability: cap }).decision, 'deny');
    assert.equal(dec(w, 'Write', { file_path: join(w.p.dir, 'docs/architecture/.env') }, { actor, capability: cap }).decision, 'deny');
  });

  test('delegation depth', () => {
    const run = (limit, actor) => {
      const w = world({ config: { limits: { max_delegation_depth: limit } } });
      return dec(w, 'Task', { subagent_type: 'unknot:cartographer' }, { actor: actor ?? {} });
    };
    assert.equal(run(1).decision, 'allow', 'main agent spawns at depth 1');
    assert.equal(run(0).decision, 'deny', 'limit 0');
    assert.equal(policy(run(0)), 'budget.delegation_depth');
    assert.equal(run(1, { agent_id: 'a', agent_type: 'unknot:cartographer' }).decision, 'deny', 'a subagent spawning is depth 2');
    assert.equal(run(2, { agent_id: 'a', agent_type: 'unknot:cartographer' }).decision, 'allow');
    assert.equal(dec(world(), 'Agent', {}).decision, 'allow');
  });
});

describe('decide: network and MCP', () => {
  test('network is denied at max_network_requests 0, even for allowlisted domains', () => {
    const w = world({ config: { network: { allowed_domains: ['example.com'] } } });
    const d = dec(w, 'WebFetch', { url: 'https://example.com/x' });
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'network.disabled');
    assert.equal(policy(dec(w, 'WebSearch', { query: 'x' })), 'network.disabled');
  });

  test('non-allowlisted domains are denied, allowlisted allowed and charged', () => {
    const w = world({ config: { limits: { max_network_requests: 5 }, network: { allowed_domains: ['example.com', '*.docs.dev'] } } });
    assert.equal(policy(dec(w, 'WebFetch', { url: 'https://evil.com/' })), 'network.domain');
    assert.equal(policy(dec(w, 'WebFetch', { url: 'https://example.com.evil.com/' })), 'network.domain');
    assert.equal(policy(dec(w, 'WebFetch', { url: 'https://notexample.com/' })), 'network.domain');
    assert.equal(policy(dec(w, 'WebFetch', { url: 'https://evildocs.dev/' })), 'network.domain');
    assert.equal(policy(dec(w, 'WebFetch', { url: 'https://docs.dev/' })), 'network.domain', 'wildcard needs a subdomain');
    assert.equal(policy(dec(w, 'WebFetch', { url: 'garbage' })), 'network.domain');
    const ok = dec(w, 'WebFetch', { url: 'https://example.com/page' });
    assert.equal(ok.decision, 'allow');
    assert.deepEqual(ok.charge, { network_requests: 1 });
    assert.equal(dec(w, 'WebFetch', { url: 'https://a.docs.dev/x' }).decision, 'allow');
    assert.equal(dec(w, 'WebFetch', { url: 'https://EXAMPLE.com/' }).decision, 'allow', 'hostnames are lower-cased by URL');
  });

  test('WebSearch is only allowed if "web-search" is explicitly allowlisted', () => {
    const w = world({ config: { limits: { max_network_requests: 5 }, network: { allowed_domains: ['example.com'] } } });
    assert.equal(dec(w, 'WebSearch', { query: 'q' }).decision, 'deny');
  });

  test('MCP: own server allowed, others denied unless allowlisted', () => {
    const w = world({ config: { mcp: { allowed_servers: ['github'] } } });
    assert.equal(policy(dec(w, 'mcp__plugin_unknot_unknot__status', {})), 'mcp.self');
    assert.equal(policy(dec(w, 'mcp__github__create_issue', {})), 'mcp.allowlisted');
    for (const t of ['mcp__slack__post', 'mcp__githubx__a', 'mcp__GitHub__a', 'mcp__unknot__a', 'mcp__xplugin_unknot_a__b']) {
      const d = dec(w, t, {});
      assert.equal(d.decision, 'deny', t);
      assert.equal(policy(d), 'mcp.server');
    }
  });
});

describe('alwaysOn protections (no active run required)', () => {
  const w = world({ command: 'diagnose', mode: 'plan', noSlice: true });
  const on = (tool, input, opExtra = {}) => {
    const op = { ...toOperation(tool, input, w.p.dir), ...opExtra };
    return alwaysOn(w.ctx, op, { pluginRoot: K.REPO_ROOT });
  };

  test('writes to .unknot config and state are denied', () => {
    for (const f of ['.unknot/config.yaml', '.unknot/decisions.jsonl', '.unknot/.gitignore', '.unknot/state/unknot.db', '.unknot/state/hook-errors.log', '.unknot/cas/sha256/ab/cd', '.unknot/runs/r/command-log.jsonl', '.unknot/campaigns/C-1.yaml', '.unknot/slices/UK-1.yaml', '.unknot/telemetry/t.json', '.unknot/./config.yaml', 'src/../.unknot/config.yaml']) {
      for (const tool of ['Write', 'Edit', 'MultiEdit']) {
        const d = on(tool, { file_path: join(w.p.dir, f) });
        assert.equal(d?.decision, 'deny', `${tool} ${f}`);
        assert.equal(policy(d), 'state.protected');
      }
    }
  });

  test('docs and the proposed config remain writable by tools', () => {
    assert.equal(on('Write', { file_path: join(w.p.dir, '.unknot/docs/n.md') }), null);
    assert.equal(on('Write', { file_path: join(w.p.dir, '.unknot/config.proposed.yaml') }), null);
    assert.equal(on('Write', { file_path: join(w.p.dir, 'src/a.js') }), null);
  });

  test('a symlink that resolves into .unknot/state is denied', () => {
    symlinkSync(join(w.p.dir, '.unknot/state'), join(w.p.dir, 'src/st'));
    assert.equal(on('Write', { file_path: join(w.p.dir, 'src/st/unknot.db') })?.decision, 'deny');
  });

  test('UNKNOT_HOME is neither readable nor writable', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'Grep']) {
      const d = on(tool, { file_path: join(w.p.home, 'approvers/alice.pem'), path: join(w.p.home, 'projects') });
      assert.equal(d?.decision, 'deny', tool);
      assert.equal(policy(d), 'keys.protected');
    }
    assert.equal(policy(on('Read', { file_path: w.p.home })), 'keys.protected');
    assert.equal(on('Read', { file_path: join(w.p.dir, 'src/a.js') }), null);
  });

  test('human-only unknot commands are denied in Bash', () => {
    for (const c of ['unknot approve UK-0001', 'node /x/bin/unknot keys generate me', 'unknot config accept', 'unknot run end run-1', 'unknot policy sign x', 'bin/unknot shred', 'unknot unlock']) {
      const d = on('Bash', { command: c });
      assert.equal(d?.decision, 'deny', c);
      assert.equal(policy(d), 'approval.human_only');
    }
  });

  test('Bash direct access to state or key material is denied', () => {
    for (const c of ['sqlite3 .unknot/state/unknot.db .dump', 'python3 -c "import sqlite3" .unknot/state/unknot.db', 'cat ~/.config/unknot/projects/x/audit.pem', 'UNKNOT_HOME=/tmp/x unknot status']) {
      assert.equal(policy(on('Bash', { command: c })), 'state.protected', c);
    }
  });

  test('Bash writes aimed at state are denied (redirects, rm, mv, tee, cp, touch)', () => {
    for (const c of ['echo x > .unknot/config.yaml', 'echo x >> .unknot/state/unknot.db', 'rm .unknot/state/unknot.db', 'mv x .unknot/config.yaml', 'cp x .unknot/decisions.jsonl', 'tee .unknot/config.yaml', 'touch .unknot/slices/UK-1.yaml', 'chmod 777 .unknot/config.yaml', 'ln -sf /x .unknot/config.yaml']) {
      const d = on('Bash', { command: c }, { cwd: w.p.dir });
      assert.equal(d?.decision, 'deny', c);
    }
  });

  test('reads and ordinary Bash are not blocked here', () => {
    assert.equal(on('Bash', { command: 'ls src' }, { cwd: w.p.dir }), null);
    assert.equal(on('Bash', { command: 'cat .unknot/config.yaml' }, { cwd: w.p.dir }), null);
    assert.equal(on('Glob', {}), null);
  });
});

describe('decide: Bash', () => {
  const w = world({ command: 'diagnose', mode: 'plan', noSlice: true });
  const bash = (command, extra) => dec(w, 'Bash', { command }, extra);

  test('read-only commands pass; mutations are denied with exec.shell', () => {
    assert.equal(bash('ls -la src').decision, 'allow');
    assert.equal(bash('git status').decision, 'allow');
    const d = bash('rm -rf src');
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'exec.shell');
  });

  test('stdin redirect from a secret is denied', () => {
    assert.equal(policy(bash('cat < .env')), 'secrets.read');
    assert.equal(policy(bash('wc -c < config/server.pem')), 'secrets.read');
  });

  test('cat of a secret file named as an argument is denied', {}, () => {
    assert.equal(bash('cat .env').decision, 'deny');
    assert.equal(bash('head -c 100 config/server.pem').decision, 'deny');
    assert.equal(bash('grep -r TOKEN .env').decision, 'deny');
  });

  test('Bash reads outside the project are denied', {}, () => {
    assert.equal(bash('cat /etc/passwd').decision, 'deny');
    assert.equal(bash(`cat ${w.p.home}/projects/x/audit.pem`).decision, 'deny');
    assert.equal(bash('ls /Users').decision, 'deny');
  });
});

describe('security review: command write ceilings bound subagents too', () => {
  test('a refactorer subagent cannot write during a map run, even into a PATCHING slice worktree', () => {
    const w = world({ command: 'map' });
    const d = write(w, 'src/a.js', { actor: { agent_id: 'ag-1', agent_type: 'unknot:refactorer' } });
    assert.equal(d.decision, 'deny');
    assert.equal(policy(d), 'capability.write');
  });
  test('the same write is allowed in an apply run', () => {
    const w = world({ command: 'apply' });
    assert.equal(write(w, 'src/a.js', { actor: { agent_id: 'ag-1', agent_type: 'unknot:refactorer' } }).decision, 'allow');
  });
});
