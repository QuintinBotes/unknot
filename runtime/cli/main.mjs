// `unknot` CLI. Commands are modules under ./commands, loaded on demand so `unknot status`
// does not pay for the planner. Errors leave as the structured error model (spec §25).

import { toErrorJSON } from '../core/errors.mjs';
import { parseArgs } from './util.mjs';

export const COMMANDS = {
  init: 'Detect tools and propose .unknot/config.proposed.yaml',
  map: 'Build or refresh the system graph [scope]',
  diagnose: 'Find and rank simplification opportunities [scope]',
  explain: 'Evidence, uncertainty, alternatives and pattern fit for a finding <F-id>',
  decompose: 'Find decomposition boundaries and pick the least invasive treatment [scope]',
  plan: 'Create or show a modernization campaign <objective>',
  next: 'Select the smallest unblocked slice [campaign]',
  apply: 'Patch one approved slice in a worktree <slice> (start|finish|replan|abandon)',
  verify: 'Execute proof obligations <slice>',
  architecture: 'Emit C4 and topology views [scope]',
  database: 'Database ownership, schema, query and recovery analysis [scope]',
  infrastructure: 'IaC, plans, drift, IAM, network and reliability analysis [scope]',
  security: 'Threat model and security delta [scope|slice]',
  status: 'Campaigns, approvals, blockers and stale evidence',
  rollback: 'Execute the recorded recovery for a slice <slice>',
  accept: 'Record acceptance of a finding <F-id> --rationale',
  reject: 'Record rejection and suppression of a finding <F-id> --rationale [--days]',
  doctor: 'Validate adapters, policy, sandbox, ledger and dependencies',
  exec: 'Run a configured project command as evidence <name> [args]',
  pattern: 'List or show pattern cards (list|show <id>)',
  graph: 'Query the graph (nodes|edges|node <id>|cycles|stats)',
  slice: 'Show a slice <id>',
  approve: 'Approve a slice (human, interactive) <slice> --role <role> --as <approver>',
  keys: 'Manage approver keys (human, interactive): generate <name>',
  config: 'Show or accept configuration (show|diff|accept)',
  run: 'Run lifecycle (start <command>|end [id]|show)',
  audit: 'Ledger integrity and export (verify|export)',
  policy: 'Organization policy bundles (sign|verify)',
  daemon: 'Start the local API daemon',
  workspace: 'Multi-repository workspace (list|map)',
  gc: 'Apply retention to runs and cache',
};

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
    process.stdout.write(`unknot — untangle complexity, preserve behavior\n\n${Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n')}\n\nAdd --json for machine-readable output.\n`);
    return 0;
  }
  if (name === '--version' || name === 'version') {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (!COMMANDS[name]) {
    process.stderr.write(`unknot: unknown command ${name}\n`);
    return 2;
  }
  const args = parseArgs(rest);
  try {
    const mod = await import(`./commands/${name}.mjs`);
    const code = await mod.run(args);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    const e = toErrorJSON(err);
    if (args.flags.json) process.stdout.write(`${JSON.stringify({ error: e }, null, 2)}\n`);
    else process.stderr.write(`unknot ${name}: ${e.code}: ${e.message}\n`);
    if (process.env.UNKNOT_DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
    return e.code === 'UK_POLICY_DENIED' || e.code === 'UK_APPROVAL_REQUIRED' ? 3 : 1;
  }
}
