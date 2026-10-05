// Adversarial coverage of the always-on protections (state, keys, approvals) and the
// path handling the PDP relies on. Each BUG test documents a real bypass.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as K from '../helpers/kernel.mjs';

after(() => K.cleanup());

const p = K.makeProject({ files: { '.env': 'T=1\n', 'src/auth/login.js': 'x\n' }, config: 'version: 1\nmode: plan\n' });
const { dir } = p;
const toOp = (tool, input) => ({ ...K.pdp.toOperation(tool, input, dir), cwd: dir });
const always = (tool, input) => K.pdp.alwaysOn(p.ctx, toOp(tool, input), { pluginRoot: K.REPO_ROOT });
const bash = (command) => always('Bash', { command });
const caseInsensitive = (() => {
  writeFileSync(join(dir, 'CaseProbe'), 'x');
  return existsSync(join(dir, 'caseprobe'));
})();

describe('state protection against path tricks (Write/Edit)', () => {
  const variants = [
    '.unknot/config.yaml', './.unknot/config.yaml', '.unknot//config.yaml', '.unknot/./config.yaml', 'src/../.unknot/config.yaml',
    '.unknot/state/unknot.db', '.unknot/state/unknot.db-wal', '.unknot/state/deep/er/x', '.unknot/cas/sha256/aa/bb',
    '.unknot/runs/run-1/command-log.jsonl', '.unknot/campaigns/C-0001.yaml', '.unknot/slices/UK-0001.yaml', '.unknot/telemetry/x.json',
    '.unknot/decisions.jsonl', '.unknot/.gitignore',
  ];
  for (const rel of variants) {
    test(`denies ${rel}`, () => {
      for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.equal(always(tool, { file_path: join(dir, rel) })?.decision, 'deny', tool);
    });
  }

  test('relative paths resolve against the event cwd', () => {
    assert.equal(always('Write', { file_path: '.unknot/config.yaml' })?.decision, 'deny');
    assert.equal(always('NotebookEdit', { notebook_path: '.unknot/state/n.ipynb' })?.decision, 'deny');
  });

  test('symlinks into .unknot, direct and via a directory, are followed', () => {
    symlinkSync(join(dir, '.unknot', 'config.yaml'), join(dir, 'src', 'cfg-link'));
    symlinkSync(join(dir, '.unknot', 'state'), join(dir, 'src', 'state-link'));
    assert.equal(always('Write', { file_path: join(dir, 'src/cfg-link') })?.decision, 'deny');
    assert.equal(always('Write', { file_path: join(dir, 'src/state-link/new-file') })?.decision, 'deny');
  });

  test('a symlink chain (link -> link -> state) is followed', () => {
    symlinkSync(join(dir, 'src', 'state-link'), join(dir, 'src', 'chain'));
    assert.equal(always('Write', { file_path: join(dir, 'src/chain/x') })?.decision, 'deny');
  });

  test('UNKNOT_HOME is protected for every file tool, by path and through symlinks', () => {
    symlinkSync(p.home, join(dir, 'src', 'home-link'));
    for (const rel of [join(p.home, 'approvers/x.pem'), join(p.home, 'projects', p.ctx.projectId, 'audit.pem'), join(dir, 'src/home-link/projects'), p.home]) {
      for (const [tool, input] of [['Read', { file_path: rel }], ['Write', { file_path: rel }], ['Edit', { file_path: rel }], ['Grep', { path: rel }], ['Glob', { path: rel }]]) {
        assert.equal(always(tool, input)?.decision, 'deny', `${tool} ${rel}`);
      }
    }
  });

  test('docs, the proposed config and ordinary files remain writable', () => {
    for (const rel of ['.unknot/docs/a.md', '.unknot/config.proposed.yaml', 'src/a.js', 'README.md']) assert.equal(always('Write', { file_path: join(dir, rel) }), null, rel);
  });

  test('the case-insensitive spelling of an existing state file is still denied', () => {
    assert.equal(always('Write', { file_path: join(dir, '.UNKNOT/CONFIG.YAML') })?.decision, 'deny');
    assert.equal(always('Write', { file_path: join(dir, '.Unknot/State/unknot.db') })?.decision, 'deny');
  });

  test('case variants of not-yet-existing state paths are denied on case-insensitive filesystems',
    { skip: !caseInsensitive && 'filesystem is case-sensitive' },
    () => {
      for (const rel of ['.unknot/DECISIONS.jsonl', '.unknot/SLICES/UK-9999.yaml', '.unknot/CAMPAIGNS/C-1.yaml']) {
        assert.equal(always('Write', { file_path: join(dir, rel) })?.decision, 'deny', rel);
      }
    });
});

describe('human-only commands cannot be reached through shell tricks', () => {
  const U = `${K.REPO_ROOT}/bin/unknot`;
  const denied = [
    `${U} approve UK-1`, `node ${U} approve UK-1`, `unknot approve UK-1`, `bin/unknot approve UK-1`, `${U} keys generate me`, `${U} config accept`, `${U} run end run-1`,
    `${U} policy sign x`, `${U} shred`, `${U} unlock`, `${U} lane approve CMP-1 --as alice`, `unknot lane revoke LN-1`, `${U} approve --lane LN-1 --as alice`, `cd /tmp && ${U} approve UK-1`, `ls; ${U} approve UK-1`, `echo ok | ${U} approve UK-1`, `env X=1 ${U} approve UK-1`,
    `bash -c '${U} approve UK-1'`, `UNKNOT_HOME=/tmp/h ${U} status`, `sqlite3 .unknot/state/unknot.db "delete from events"`, `python3 -c "import sqlite3; sqlite3.connect('.unknot/state/unknot.db')"`,
    'cat ~/.config/unknot/approvers/alice.pem', 'cp ~/.config/unknot/approvers/alice.pem /tmp/k',
    'echo x > .unknot/config.yaml', 'echo x >> .unknot/state/unknot.db', 'rm -rf .unknot/state', 'mv .unknot/config.yaml /tmp/', 'cp /tmp/evil .unknot/config.yaml', 'tee .unknot/config.yaml < /tmp/evil', 'touch .unknot/decisions.jsonl', 'truncate -s 0 .unknot/state/unknot.db', 'chmod 777 .unknot/config.yaml', 'ln -sf /tmp/evil .unknot/config.yaml', 'install /tmp/evil .unknot/config.yaml', 'rsync /tmp/evil .unknot/config.yaml',
  ];
  for (const cmd of denied) {
    test(`denies ${cmd}`, () => assert.equal(bash(cmd)?.decision, 'deny'));
  }

  test('legitimate inspection of the project is not blocked', () => {
    for (const cmd of ['ls .unknot', 'cat .unknot/config.yaml', 'git status', `${U} status`, 'grep -r TODO src', 'sqlite3 --version', `${U} lane status`, `${U} lane review LN-1`]) assert.equal(bash(cmd), null, cmd);
  });

  test('text that only mentions .unknot while writing elsewhere is not state access', () => {
    for (const cmd of [
      "cat >> notes.md <<'EOF'\nThe state lives in .unknot/config.yaml\nEOF",
      'echo "see .unknot/decisions.jsonl" >> notes.md',
      "printf '%s\\n' '.unknot is local state' > docs/x.md",
    ]) assert.equal(bash(cmd), null, cmd);
  });

  const viaProgram = [
    "cat <<'EOF' | python3\nopen('.unknot/config.yaml','w').write('mode: campaign')\nEOF",
    "python3 <<'EOF'\nopen('.unknot/config.yaml','w').write('mode: campaign')\nEOF",
    "cat > \"$(echo .unknot)/config.yaml\" <<'EOF'\nmode: campaign\nEOF",
    "D=.unknot; cat > $D/config.yaml <<'EOF'\nmode: campaign\nEOF",
    'echo .unknot/config.yaml | xargs rm',
    "cat <<EOF > notes.md\n$(rm .unknot/config.yaml)\nEOF",
    // Found by the adversarial review of the narrower rule: programs that write through their
    // arguments, variables filled by printf -v, loop words, globs and split quoting.
    'uniq /tmp/x .unknot/config.yaml',
    'sort -o .unknot/decisions.jsonl a b',
    'tee .unknot/conf*.yaml </tmp/x',
    'tee .unknot/{config,x}.yaml </tmp/x',
    'printf -v p %s .unknot/config.yaml; cp /tmp/x "$p"',
    'for p in .unknot/config.yaml; do cp /tmp/x "$p"; done',
    'for x in .unknot/config.yaml; do echo hi > $x; done',
    "sed -i s/plan/campaign/ .unk''not/config.yaml",
    'echo hi | tee -a .unknot/decisions.jsonl',
  ];
  for (const cmd of viaProgram) test(`denies ${JSON.stringify(cmd)}`, () => assert.equal(bash(cmd)?.decision, 'deny'));
});

describe('BUGS: shell writes to protected state that alwaysOn misses', () => {
  const bug = (cmd, why) => test(`denies ${cmd}`, {}, () => assert.equal(bash(cmd)?.decision, 'deny', `allowed: ${cmd}`));
  const reason = 'pdp.mjs alwaysOn only inspects redirects and a short list of write programs (rm mv cp tee ... rsync); it does not see in-place editors, interpreters, cd+relative redirects or dd of=';

  bug("sed -i.bak s/plan/campaign/ .unknot/config.yaml", `${reason} (sed -i)`);
  bug("perl -pi -e 's/plan/campaign/' .unknot/config.yaml", `${reason} (perl -pi)`);
  bug("python3 -c \"open('.unknot/config.yaml','w').write('mode: campaign')\"", `${reason} (python writes the config)`);
  bug("node -e \"require('fs').writeFileSync('.unknot/config.yaml','mode: campaign')\"", `${reason} (node writes the config)`);
  bug("cd .unknot && echo 'mode: campaign' > config.yaml", `${reason} (cd + relative redirect)`);
  bug('echo x > $PWD/.unknot/config.yaml', `${reason} (computed redirect target)`);
  bug('echo x | dd of=.unknot/config.yaml', `${reason} (dd of=)`);
  bug("awk -i inplace '{print}' .unknot/config.yaml", `${reason} (awk inplace)`);
  bug('ed .unknot/config.yaml', `${reason} (ed)`);
});

describe('policy source of truth', () => {
  test('without an active run a mode bump in config.yaml is only possible outside the tools (guarded above)', () => {
    assert.equal(always('Write', { file_path: join(dir, '.unknot/config.yaml'), content: 'mode: campaign' })?.policy_ids[0], 'state.protected');
  });

  test('the proposal file is the sanctioned channel and is not in the protected set', () => {
    assert.equal(always('Write', { file_path: join(dir, '.unknot/config.proposed.yaml'), content: 'mode: assist' }), null);
  });

  test('the decision records its policy id so that it can be audited', () => {
    const d = always('Write', { file_path: join(dir, '.unknot/config.yaml') });
    assert.deepEqual(d.policy_ids, ['state.protected']);
    assert.match(d.reasons[0], /unknot config accept/);
    mkdirSync(join(dir, 'x'), { recursive: true });
  });
});
