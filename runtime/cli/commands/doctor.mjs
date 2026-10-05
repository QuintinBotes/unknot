// /unknot:doctor — validate the installation and the project: runtime, sandbox, keys,
// ledger integrity, config and org policy, adapters and their tools.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAdapters } from '../../../adapters/registry.mjs';
import { detectSandbox } from '../../broker/sandbox.mjs';
import { findProjectRoot, isInitialized, unknotHome } from '../../core/project.mjs';
import { verifyLedger } from '../../state/ledger.mjs';
import { output } from '../util.mjs';

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
  const root = findProjectRoot(flags.cwd ?? process.cwd());
  if (!isInitialized(root)) {
    add('project', false, `${root} is not initialised; run /unknot:init`, 'warn');
  } else {
    try {
      const { openProject } = await import('../../context.mjs');
      const { loadConfig } = await import('../../policy/config.mjs');
      const ctx = openProject(root);
      const cfg = loadConfig(ctx);
      add('config acceptance', cfg.acceptance === 'accepted' || cfg.acceptance === 'none', cfg.notice ?? `accepted (${cfg.acceptance})`, cfg.acceptance === 'accepted' || cfg.acceptance === 'none' ? 'ok' : 'warn');
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
      add('approvers', approvers.length > 0, approvers.length ? approvers.join(', ') : 'none registered: no slice can be approved (unknot keys generate <name>)', approvers.length ? 'ok' : 'warn');
      const { loaded, unavailable } = await loadAdapters(cfg.config);
      add('adapters', true, `${loaded.map((a) => `${a.id}@${a.version}`).join(', ')}`, 'info');
      for (const u of unavailable) add(`adapter ${u.id}`, false, u.reason, 'warn');
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
