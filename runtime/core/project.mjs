// Where a project's Unknot state lives, and where the per-user secrets live.
//
// Project state: <root>/.unknot/ (config and plans are committed; state/, cas/, runs/,
// worktrees/ and telemetry/ are not). User secrets: $UNKNOT_HOME, else
// $XDG_CONFIG_HOME/unknot, else ~/.config/unknot. Secrets never live in the repository.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { realpathLenient } from './paths.mjs';

export const UNKNOT_DIR = '.unknot';
const WORKTREE_MARK = `${sep}${UNKNOT_DIR}${sep}worktrees${sep}`;

/**
 * The project root for a working directory. A path inside one of Unknot's own worktrees
 * belongs to the project that created it, not to the checkout the worktree contains.
 */
export function findProjectRoot(cwd = process.cwd()) {
  const start = realpathLenient(resolve(cwd));
  const mark = start.indexOf(WORKTREE_MARK);
  if (mark !== -1) return start.slice(0, mark);
  let gitRoot = null;
  for (let dir = start; ; dir = dirname(dir)) {
    if (isDir(join(dir, UNKNOT_DIR))) return dir;
    if (!gitRoot && existsSync(join(dir, '.git'))) gitRoot = dir;
    if (dirname(dir) === dir) break;
  }
  return gitRoot ?? start;
}

/** The worktree id when `cwd` is inside `<root>/.unknot/worktrees/<id>`, else null. */
export function worktreeIdFor(path) {
  const real = realpathLenient(resolve(path));
  const mark = real.indexOf(WORKTREE_MARK);
  if (mark === -1) return null;
  return real.slice(mark + WORKTREE_MARK.length).split(sep)[0] || null;
}

export function projectPaths(root) {
  const base = join(root, UNKNOT_DIR);
  return {
    root,
    base,
    config: join(base, 'config.yaml'),
    proposedConfig: join(base, 'config.proposed.yaml'),
    // Where each proposed line came from; local state, ignored and protected like the rest of state/.
    proposedSources: join(base, 'state', 'config.proposed.sources.json'),
    decisions: join(base, 'decisions.jsonl'),
    campaigns: join(base, 'campaigns'),
    slices: join(base, 'slices'),
    docs: join(base, 'docs'),
    state: join(base, 'state'),
    db: join(base, 'state', 'unknot.db'),
    cas: join(base, 'cas'),
    runs: join(base, 'runs'),
    worktrees: join(base, 'worktrees'),
    telemetry: join(base, 'telemetry'),
  };
}

export function isInitialized(root) {
  return isDir(join(root, UNKNOT_DIR));
}

export function unknotHome() {
  if (process.env.UNKNOT_HOME) return resolve(process.env.UNKNOT_HOME);
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg ? resolve(xdg) : join(homedir(), '.config'), 'unknot');
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
