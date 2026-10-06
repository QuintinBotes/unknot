// unknot cli — reach the CLI from a normal terminal. The plugin's bin/ is on PATH only
// inside Claude Code and its installed path carries the version, so a one-time shim in a
// PATH directory finds the newest installed version at run time and survives upgrades.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { UnknotError } from '../../core/errors.mjs';
import { cliPath, output, requireHumanTTY } from '../util.mjs';

export const SHIM_MARK = '// unknot-cli-shim';
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

/** The directory holding every installed version when this CLI is one of them, else null (a development checkout). */
export function versionsDir(cli = cliPath()) {
  const root = dirname(dirname(cli));
  return SEMVER.test(basename(root)) ? dirname(root) : null;
}

export function shimSource(cli = cliPath()) {
  return `#!/usr/bin/env node
${SHIM_MARK}: runs the Unknot CLI of the session's loaded plugin, else the newest installed; remove with \`unknot cli uninstall\`.
const { spawnSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { basename, delimiter, dirname, join, resolve } = require('node:path');

const VERSIONS_DIR = ${JSON.stringify(versionsDir(cli))};
const FALLBACK = ${JSON.stringify(cli)};
const num = (v) => v.split(/[-+]/)[0].split('.').map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (num(a)[i] !== num(b)[i]) return num(a)[i] - num(b)[i]; return 0; };

// Inside Claude Code the Bash tool's PATH carries the bin directory of the plugin version the
// session loaded: that CLI matches the session's hooks, so it wins over a newer install.
function sessionBin() {
  if (!VERSIONS_DIR) return null;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const bin = resolve(dir);
    const version = dirname(bin);
    if (basename(bin) === 'bin' && dirname(version) === resolve(VERSIONS_DIR) && /^\\d+\\.\\d+\\.\\d+/.test(basename(version)) && existsSync(join(bin, 'unknot'))) return join(bin, 'unknot');
  }
  return null;
}

function target() {
  const session = sessionBin();
  if (session) return session;
  if (VERSIONS_DIR && existsSync(VERSIONS_DIR)) {
    const found = readdirSync(VERSIONS_DIR)
      .filter((v) => /^\\d+\\.\\d+\\.\\d+/.test(v) && existsSync(join(VERSIONS_DIR, v, 'bin', 'unknot')))
      .sort(newer);
    if (found.length) return join(VERSIONS_DIR, found.at(-1), 'bin', 'unknot');
  }
  return existsSync(FALLBACK) ? FALLBACK : null;
}

const bin = target();
if (!bin) {
  process.stderr.write('unknot: no installed Unknot plugin found (reinstall it, then run: unknot cli install)\\n');
  process.exit(1);
}
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) {
  process.stderr.write(\`unknot: \${r.error.message}\\n\`);
  process.exit(1);
}
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
`;
}

const defaultDir = () => join(homedir(), '.local', 'bin');
const onPath = (dir, env = process.env) => (env.PATH ?? '').split(delimiter).some((d) => d && resolve(d) === resolve(dir));
const isOurs = (file) => {
  try {
    return readFileSync(file, 'utf8').includes(SHIM_MARK);
  } catch {
    return false;
  }
};

function windowsHelp() {
  return `Windows is not tested (use WSL2). Run the CLI by its path: node ${cliPath()} <command>`;
}

export async function run({ positional, flags }) {
  const [sub] = positional;
  const dir = resolve(typeof flags.dir === 'string' ? flags.dir : defaultDir());
  const shim = join(dir, 'unknot');
  if (sub === 'status') {
    const status = { cli_path: cliPath(), shim: { path: shim, installed: isOurs(shim), foreign: existsSync(shim) && !isOurs(shim) }, dir_on_path: onPath(dir), versions_dir: versionsDir() };
    if (flags.json) return output(status, { json: true });
    return output([
      `CLI path: ${status.cli_path}`,
      `Shim: ${status.shim.installed ? `installed at ${shim}` : status.shim.foreign ? `${shim} exists and is not ours` : `not installed (would be ${shim})`}`,
      `${dir} on PATH: ${status.dir_on_path ? 'yes' : `no (add it to PATH in your shell profile)`}`,
    ].join('\n'));
  }
  if (sub === 'install') {
    requireHumanTTY('installing the unknot command', { args: ['cli', 'install'] });
    if (process.platform === 'win32') return output(windowsHelp());
    if (existsSync(shim) && !isOurs(shim)) throw new UnknotError('UK_POLICY_DENIED', `${shim} exists and was not written by unknot; remove it or choose another directory with --dir`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(shim, shimSource());
    chmodSync(shim, 0o755);
    return output([`Installed ${shim}. It runs the version the Claude Code session loaded, else the newest installed, so it survives upgrades.`, onPath(dir) ? 'Open a new terminal window if `unknot` is not found yet.' : `${dir} is not on your PATH: add it in your shell profile (for example export PATH="${dir}:$PATH").`].join('\n'));
  }
  if (sub === 'uninstall') {
    requireHumanTTY('removing the unknot command', { args: ['cli', 'uninstall'] });
    if (process.platform === 'win32') return output(windowsHelp());
    if (!existsSync(shim)) return output(`No shim at ${shim}.`);
    if (!isOurs(shim)) throw new UnknotError('UK_POLICY_DENIED', `${shim} was not written by unknot; leaving it alone`);
    unlinkSync(shim);
    return output(`Removed ${shim}.`);
  }
  output('usage: unknot cli status|install|uninstall [--dir <dir>]');
  return 2;
}
