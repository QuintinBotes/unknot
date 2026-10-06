// The steps only a person can do, as one ready-to-paste block. `unknot status` and the MCP
// `status` tool print it, and the human-only refusal points to it. This only builds text: every
// step it lists still needs a TTY and a passphrase in the person's own terminal.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseYAML } from '../core/yaml.mjs';
import { cliPath } from '../cli/util.mjs';
import { activeRun } from '../state/runs.mjs';

export const HUMAN_BLOCK_HEADING = 'For you, in your own terminal:';

/**
 * Whether `unknot` resolves on a login shell's PATH: true, false, or null when that could not be
 * found out (no shell, a timeout, a shell that refused). Unknown is never reported as missing.
 */
export function loginShellHasUnknot({ shell = process.env.SHELL, timeoutMs = 3000, spawn = spawnSync } = {}) {
  if (!shell) return null;
  try {
    const r = spawn(shell, ['-lc', 'command -v unknot'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.signal || r.status === null || r.status === undefined) return null;
    const found = Boolean(String(r.stdout ?? '').trim());
    if (r.status === 0) return found;
    // `command -v` exits 1 with no output for a missing command; any other status is unknown.
    return r.status === 1 && !found ? false : null;
  } catch {
    return null;
  }
}

function defaultName() {
  try {
    return userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_') || '<your-name>';
  } catch {
    return '<your-name>';
  }
}

/**
 * @param {object} ctx project context
 * @param {{config: object, acceptance?: string}} cfg loaded configuration
 * @param {{unknotOnPath?: boolean|null}} [opts] `unknotOnPath` injects the PATH check (true, false, null = unknown)
 * @returns {{heading: string, steps: {step: string, commands: string[], note?: string}[], text: string|null}}
 */
let pathCheck = null; // { at, value }: the login-shell check, kept for ten minutes in long-lived processes

function proposalListsRepositories(ctx) {
  try {
    return (parseYAML(readFileSync(ctx.paths.proposedConfig, 'utf8'))?.workspace?.repositories ?? []).length > 0;
  } catch {
    return false;
  }
}

export function humanSteps(ctx, cfg, { unknotOnPath } = {}) {
  const steps = [];
  const proposal = existsSync(ctx.paths.proposedConfig);
  if (proposal || ['unaccepted', 'changed'].includes(cfg.acceptance)) {
    const workspace = proposal && !(cfg.config.workspace?.repositories ?? []).length && proposalListsRepositories(ctx);
    steps.push({ step: 'accept_config', commands: ['unknot config diff', 'unknot config accept'], note: workspace ? 'review the proposal, then accept it: it lists workspace repositories, and `unknot workspace list` and `map` need it accepted' : proposal ? 'review the proposal, then accept it' : 'review the configuration file, then accept it' });
  }
  const approvers = cfg.config.approvers ?? {};
  const name = defaultName();
  if (!Object.keys(approvers).length) {
    steps.push({ step: 'register_approver', commands: [`unknot keys generate ${name}`], note: 'paste the printed block under approvers: in .unknot/config.yaml, then accept the configuration again' });
  }
  for (const s of ctx.store.all("SELECT id, body FROM slices WHERE state IN ('AWAITING_APPROVAL', 'REVIEW_READY') ORDER BY id")) {
    let roles = [];
    try {
      roles = JSON.parse(s.body).approvals ?? [];
    } catch {
      // unreadable body: fall back to a placeholder role
    }
    if (!roles.length) roles = ['<role>'];
    steps.push({
      step: 'approve_slice',
      slice: s.id,
      commands: roles.map((role) => `unknot approve ${s.id} --role ${role} --as ${Object.keys(approvers).find((a) => approvers[a].roles?.includes(role)) ?? name}`),
    });
  }
  const run = activeRun(ctx.store);
  if (run) steps.push({ step: 'end_run', run: run.id, commands: [`unknot run end ${run.id}`], note: 'only if it is stuck: a /unknot command\'s run ends with its turn' });
  // Whether `unknot` resolves in a login shell matters only when there is something to run; the
  // check starts a login shell, so it runs then, at most every ten minutes.
  if (steps.length) {
    if (unknotOnPath === undefined) {
      if (!pathCheck || Date.now() - pathCheck.at > 600_000) pathCheck = { at: Date.now(), value: loginShellHasUnknot() };
      unknotOnPath = pathCheck.value;
    }
    if (unknotOnPath === false) steps.unshift({ step: 'install_cli', commands: [`node ${cliPath()} cli install`], note: 'puts `unknot` on your PATH; open a new terminal afterwards' });
  }
  const text = steps.length
    ? [HUMAN_BLOCK_HEADING, ...steps.flatMap((s) => [...s.commands.map((c) => `  ${c}`), ...(s.note ? [`    # ${s.note}`] : [])])].join('\n')
    : null;
  return { heading: HUMAN_BLOCK_HEADING, steps, text };
}
