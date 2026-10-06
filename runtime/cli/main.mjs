// `unknot` CLI. Commands are modules under ./commands, loaded on demand so `unknot status`
// does not pay for the planner. Errors leave as the structured error model (spec §25).

import { toErrorJSON } from '../core/errors.mjs';
import { parseArgs } from './util.mjs';

export const COMMANDS = {
  init: 'Detect tools and propose .unknot/config.proposed.yaml',
  map: 'Build or refresh the system graph [scope]',
  import: 'Import a runtime call table (counts, p95, errors) as decompose evidence runtime <file> [--source label]',
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
  cli: 'Reach this CLI from a terminal (status|install|uninstall [--dir])',
  lane: 'One signed approval for the low-risk slices of a campaign (approve|status|review|revoke)',
  search: 'Where a string occurs: definitions, uses, uses through its constant, with module and owners <text> [--regex] [scope...]',
  doctor: 'Validate adapters, policy, sandbox, ledger and dependencies',
  exec: 'Run a configured project command as evidence <name> [args]',
  pattern: 'List or show pattern cards (list|show <id>)',
  graph: 'Query the graph (nodes|edges|node <id>|cycles|stats)',
  slice: 'Show a slice <id>',
  approve: 'Approve a slice (human, interactive) <slice> --role <role> --as <approver>',
  attest: 'Attest a human-review obligation (human, interactive) <PO-id> --result pass|fail --note',
  keys: 'Manage approver keys (human, interactive): generate <name>',
  config: 'Show or accept configuration (show|diff|accept [--detected-only])',
  run: 'Run lifecycle (start <command>|end [id]|show)',
  audit: 'Ledger integrity and export (verify|export)',
  policy: 'Organization policy bundles (keygen|sign|trust|verify|effective) and recent refusals (denials)',
  backup: 'Encrypted backup of Unknot state (create|verify|restore --to)',
  daemon: 'Start the local API daemon',
  workspace: 'Multi-repository workspace (list|map|graph|add|remove)',
  gc: 'Apply retention to runs and cache',
  learn: 'Feedback loop: metrics and detector calibration (report), threshold proposals (propose)',
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
  // --help or -h prints usage without running the command or opening the store. Words after
  // `--` belong to the command being run (`unknot exec -- grep -h x`), not to Unknot.
  const own = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  if (own.includes('--help') || own.includes('-h')) {
    try {
      const mod = await import(`./commands/${name}.mjs`);
      if (mod.USAGE) {
        process.stdout.write(`${mod.USAGE}\n`);
      } else {
        process.stdout.write(`usage: unknot ${name} — ${COMMANDS[name]}\n`);
      }
    } catch {
      // If the command module fails to load, print the basic usage.
      process.stdout.write(`usage: unknot ${name} — ${COMMANDS[name]}\n`);
    }
    return 0;
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
