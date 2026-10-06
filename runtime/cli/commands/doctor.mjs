// /unknot:doctor — validate the installation and the project: runtime, sandbox, keys,
// ledger integrity, config and org policy, adapters and their tools.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadAdapters } from '../../../adapters/registry.mjs';
import { scipChecks } from '../../../adapters/semantic/scip/locate.mjs';
import { detectSandbox } from '../../broker/sandbox.mjs';
import { findProjectRoot, isInitialized, unknotHome } from '../../core/project.mjs';
import { VERSION } from '../../core/version.mjs';
import { hooksSeen } from '../../state/hooks-seen.mjs';
import { verifyLedger } from '../../state/ledger.mjs';
import { cliPath, humanCommand, output, stableUnknot } from '../util.mjs';
import { SHIM_MARK } from './cli.mjs';

function tool(name, args = ['--version']) {
  const r = spawnSync(name, args, { encoding: 'utf8', timeout: 10_000, shell: false });
  return r.error ? null : (r.stdout || r.stderr).split('\n')[0].trim();
}

export async function run({ flags }) {
  const checks = [];
  const add = (name, ok, detail, level = ok ? 'ok' : 'fail') => checks.push({ name, level, detail });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node', major > 22 || (major === 22 && minor >= 13), `v${process.versions.node} (need >= 22.13 for node:sqlite)`);
  const sandbox = detectSandbox();
  add('os sandbox', sandbox !== 'none', sandbox === 'none' ? 'none: brokered commands run unsandboxed (set security.require_os_sandbox to refuse)' : sandbox, sandbox === 'none' ? 'warn' : 'ok');
  add('git', Boolean(tool('git')), tool('git') ?? 'missing');
  const py = tool('python3');
  add('python3', Boolean(py), py ? `${py} (Python AST extraction)` : 'missing: Python files use the lexical fallback', py ? 'ok' : 'warn');
  for (const t of ['helm', 'kustomize', 'terraform', 'tofu', 'semgrep', 'gitleaks']) {
    const v = tool(t, t === 'kustomize' || t === 'helm' ? ['version'] : ['--version']);
    add(t, Boolean(v), v ?? 'not installed (optional)', v ? 'ok' : 'info');
  }
  add('unknot home', true, unknotHome(), 'info');
  const onPath = stableUnknot();
  const shim = join(homedir(), '.local', 'bin', 'unknot');
  const shimOurs = existsSync(shim) && readFileSync(shim, 'utf8').includes(SHIM_MARK);
  const stable = Boolean(onPath);
  add('unknot cli', true, `${cliPath()}; shim ${shimOurs ? `installed at ${shim}` : 'not installed'}; \`unknot\` ${stable ? `on PATH (${onPath})` : 'not a stable command in a normal terminal'}${stable ? '' : `. Fix: node ${cliPath()} cli install (once, in a separate terminal window)`}`, stable ? 'ok' : 'warn');
  if (shimOurs && !readFileSync(shim, 'utf8').includes('function sessionBin')) {
    add('unknot shim', false, `${shim} runs the newest installed version even inside a session that loaded an older one; run \`unknot cli install\` to update it`, 'warn');
  }
  const root = findProjectRoot(flags.cwd ?? process.cwd());
  if (!isInitialized(root)) {
    add('project', false, `${root} is not initialised; run /unknot:init`, 'warn');
  } else {
    // Hooks of another release ran here lately: a session whose hooks and CLI differ.
    const others = hooksSeen(join(root, '.unknot', 'state')).filter((h) => h.version !== VERSION);
    if (others.length) {
      add('session hooks', false, `hooks of Unknot ${others.map((h) => h.version).join(', ')} ran here in the last 15 minutes while this CLI is ${VERSION}; reload plugins or start a new session so they match`, 'warn');
    }
    try {
      const { openProject } = await import('../../context.mjs');
      const { loadConfig, waitingProposal } = await import('../../policy/config.mjs');
      const ctx = openProject(root);
      const cfg = loadConfig(ctx);
      add('config acceptance', cfg.acceptance === 'accepted' || cfg.acceptance === 'none', cfg.notice ?? `accepted (${cfg.acceptance})`, cfg.acceptance === 'accepted' || cfg.acceptance === 'none' ? 'ok' : 'warn');
      const waiting = waitingProposal(ctx);
      if (waiting) add('config proposal', false, `a newer proposal is waiting (${waiting.path}, differs in ${waiting.differs.join(', ')}); it is not in force until a person reviews it (${humanCommand('config diff').split('\n')[0]}) and accepts it`, 'warn');
      add('config', true, `mode ${cfg.config.mode}, digest ${cfg.digest.slice(0, 19)}…, sources ${cfg.sources.join(', ') || 'defaults'}`);
      for (const b of cfg.org) add('org policy', true, `${b.file} (${b.signed ? 'signed' : 'unsigned'})`, b.signed ? 'ok' : 'warn');
      if (cfg.adjustments.length) add('org adjustments', true, `${cfg.adjustments.length} repo value(s) tightened by org policy`, 'info');
      const dbKey = ctx.store.meta('audit_public_key');
      let pub = dbKey;
      try {
        pub = (await import('../../core/keys.mjs')).auditPublicKeyPem(ctx.projectId);
        if (dbKey && dbKey !== pub) add('audit key', false, 'the audit public key in the database differs from the key in UNKNOT_HOME');
      } catch {
        add('audit key', false, 'no audit key in UNKNOT_HOME for this project; ledger verified against the database copy only', 'warn');
      }
      const ledger = verifyLedger(ctx.store, pub);
      add('ledger', ledger.ok, ledger.ok ? `${ledger.count} events, chain and signatures valid` : `broken at ${ledger.broken_at}: ${ledger.reason}`);
      const approvers = Object.keys(cfg.config.approvers ?? {});
      add('approvers', approvers.length > 0, approvers.length ? approvers.join(', ') : `none registered: only needed to change code (a person runs, in a separate terminal: ${humanCommand('keys generate <name>').split('\n')[0]})`, approvers.length ? 'ok' : 'warn');
      const { loaded, unavailable } = await loadAdapters(cfg.config);
      add('adapters', true, `${loaded.map((a) => `${a.id}@${a.version}`).join(', ')}`, 'info');
      for (const u of unavailable) add(`adapter ${u.id}`, false, u.reason, 'warn');
      if (cfg.config.adapters?.scip?.enabled !== false) checks.push(...scipChecks(root, cfg.config.adapters?.scip ?? {}));
      const errLog = join(ctx.paths.state, 'hook-errors.log');
      if (existsSync(errLog)) add('hook errors', false, `see ${errLog}`, 'warn');
    } catch (err) {
      add('project state', false, `${err.code ?? 'error'}: ${err.message}`);
    }
  }
  const failed = checks.some((c) => c.level === 'fail');
  if (flags.json) output({ ok: !failed, checks }, { json: true });
  else output(checks.map((c) => `${{ ok: '✓', warn: '!', fail: '✗', info: '·' }[c.level]} ${c.name.padEnd(16)} ${c.detail}`).join('\n'));
  return failed ? 1 : 0;
}
