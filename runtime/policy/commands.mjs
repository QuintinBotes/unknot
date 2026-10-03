// Command rules for model-issued shell commands during an active run (spec §16.3:
// executable and argument allowlists, no implicit shell interpolation).
//
// The model's Bash tool gets read-only inspection commands and the Unknot CLI. Anything
// that builds, tests, installs or mutates goes through the broker (`unknot verify`,
// `unknot exec`), which runs it without a shell, in the sandbox, as evidence.

import { accessSync, constants } from 'node:fs';
import { delimiter, join, normalize } from 'node:path';
import { basenameOf, effectiveCommands, parseShell } from '../core/shell.mjs';

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'tree', 'file', 'stat', 'du',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'printf', 'echo', 'true', 'false', 'pwd',
  'basename', 'dirname', 'realpath', 'readlink', 'date', 'which', 'type', 'test', '[', 'seq', 'od',
  'xxd', 'hexdump', 'strings', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'tac', 'rev', 'fold',
  'comm', 'join', 'paste', 'jq', 'expand', 'unexpand', 'cloc', 'tokei', 'sleep',
]);

const GIT_READ = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog',
  'cat-file', 'grep', 'merge-base', 'name-rev', 'rev-list', 'for-each-ref', 'show-ref', 'count-objects',
  'check-ignore', 'check-attr', 'whatchanged', 'reflog',
]);

// Unknot subcommands a model may run. Approval, key, config-acceptance and run-ending
// commands are for humans (they also need a TTY); the hook denies them outright.
export const HUMAN_ONLY_SUBCOMMANDS = new Set(['approve', 'keys', 'config', 'run', 'policy', 'audit', 'gc', 'shred', 'daemon', 'unlock']);

const FIND_DANGEROUS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);

function lit(word) {
  return word.dynamic ? null : word.value;
}

/** Decide one effective command. Returns null when allowed, else a reason string. */
function judge(cmd, { pluginRoot }) {
  if (!cmd.argv.length) return cmd.assignments.length ? 'bare variable assignments are not allowed' : null;
  const head = cmd.argv[0];
  if (head.dynamic) return 'the command name is computed at run time';
  const name = basenameOf(head);
  const args = cmd.argv.slice(1);
  if (cmd.assignments.some((a) => /^UNKNOT_|^PATH$|^LD_|^DYLD_|^NODE_OPTIONS$|^IFS$/.test(a.name))) {
    return `setting ${cmd.assignments.map((a) => a.name).join(', ')} is not allowed`;
  }
  const viaNode = name === 'node' && args[0] && !args[0].dynamic && isUnknotBin(args[0].value, pluginRoot);
  if (name === 'unknot' && !resolvesToPlugin(head.value, pluginRoot)) return '`unknot` does not resolve to this plugin\'s CLI';
  if (name === 'unknot' || viaNode) {
    const rest = name === 'unknot' ? args : args.slice(1);
    const sub = rest[0] ? lit(rest[0]) : null;
    if (sub && HUMAN_ONLY_SUBCOMMANDS.has(sub)) return `\`unknot ${sub}\` is for a human in their own terminal`;
    if (rest.some((w) => w.dynamic && w.value.includes('$('))) return 'computed arguments to unknot are not allowed';
    return null;
  }
  if (name === 'git') {
    const sub = args.find((w) => !lit(w)?.startsWith('-'));
    if (args.some((w) => /^-c$|^--exec-path|^--config-env/.test(w.value))) return 'git configuration overrides are not allowed';
    if (!sub || !GIT_READ.has(lit(sub))) return `git ${sub ? lit(sub) : ''} is not a read-only git command`;
    if (args.some((w) => /^--output(=|$)|^--ext-diff$|^--textconv$/.test(w.value))) return 'git output/diff-driver flags are not allowed';
    return null;
  }
  if (name === 'find') {
    const bad = args.find((w) => FIND_DANGEROUS.has(w.value));
    return bad ? `find ${bad.value} is not allowed` : null;
  }
  if (name === 'sed') {
    if (args.some((w) => /^-i|^--in-place|^-[a-zA-Z]*i/.test(w.value))) return 'sed -i edits files';
    if (!args.some((w) => w.value === '-n')) return 'only `sed -n` is allowed';
    if (args.some((w) => /(^|[;}\s])\d*[wWe]\b|\/[wWe]\s/.test(w.value))) return 'sed write/execute commands are not allowed';
    return null;
  }
  if (name === 'sort' && args.some((w) => /^-o|^--output/.test(w.value))) return 'sort -o writes files';
  if (READ_ONLY.has(name)) return null;
  return `\`${name}\` is not in the read-only set; run checks through \`unknot verify\` or \`unknot exec\``;
}

// Only the plugin's own CLI, by absolute path. A relative `bin/unknot`, or an `unknot`
// earlier on PATH, could be a file the repository under analysis put there.
function isUnknotBin(path, pluginRoot) {
  return Boolean(pluginRoot) && normalize(path) === join(pluginRoot, 'bin', 'unknot');
}

function resolvesToPlugin(word, pluginRoot) {
  if (!pluginRoot) return false;
  if (word.includes('/')) return isUnknotBin(word, pluginRoot);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, word);
    try {
      accessSync(candidate, constants.X_OK);
      return isUnknotBin(candidate, pluginRoot);
    } catch {
      // not in this PATH entry
    }
  }
  return false;
}

/**
 * @returns {{allow: boolean, reasons: string[], commands: object[], writes: string[], reads: string[]}}
 */
export function judgeShell(command, { pluginRoot } = {}) {
  const parsed = parseShell(command);
  if (!parsed.ok) return { allow: false, reasons: [`cannot verify this command statically (${parsed.reason})`], commands: [], writes: [], reads: [] };
  const commands = effectiveCommands(parsed);
  const reasons = [];
  const writes = [];
  const reads = [];
  for (const cmd of commands) {
    const why = judge(cmd, { pluginRoot });
    if (why) reasons.push(why);
    for (const r of cmd.redirects ?? []) {
      const target = r.target;
      if (['>', '>>', '>|', '&>', '&>>'].includes(r.op)) {
        if (target.dynamic) reasons.push('redirect target is computed at run time');
        else if (target.value !== '/dev/null' && !/^&?\d$/.test(target.value)) writes.push(target.value);
      } else if (r.op === '<' && !target.dynamic) reads.push(target.value);
    }
  }
  if (writes.length) reasons.push(`writing files from the shell is not allowed (${writes.join(', ')})`);
  return { allow: reasons.length === 0, reasons, commands, writes, reads };
}
