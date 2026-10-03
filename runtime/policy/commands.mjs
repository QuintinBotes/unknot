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
  'comm', 'join', 'paste', 'jq', 'expand', 'unexpand', 'sleep',
]);

// Flags that make an otherwise read-only tool run another program or write a file.
// Matched against every argument, including bundled short options (`-uo FILE`).
const EXEC_FLAGS = {
  rg: /^--pre(=|$)|^--pre-glob|^--hostname-bin|^--search-zip$|^-[a-zA-Z]*z/,
  sort: /^--compress-program|^--output|^-[a-zA-Z]*o/,
  tree: /^-o|^--output/,
  grep: /^--exclude-from=\/dev/,
  jq: /^--rawfile$|^--slurpfile$/,
  date: /^-s|^--set/,
  xxd: /^-r/,
};

// Tools whose second positional argument is an output file.
const OUTPUT_POSITIONAL = new Set(['uniq', 'xxd']);

// Wrappers that change who runs the command. Never allowed, whatever they wrap.
const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas']);

// The only variables a model may set in front of a command. Everything else (GIT_*,
// PAGER, EDITOR, LESSOPEN, LD_*, NODE_OPTIONS, ...) can turn a read into an execution.
const SAFE_ASSIGNMENTS = new Set(['LC_ALL', 'LANG', 'LC_CTYPE', 'TZ', 'NO_COLOR', 'TERM', 'COLUMNS']);

// Read-only git subcommands. `reflog` is excluded: `reflog expire|delete` rewrite history.
const GIT_READ = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog',
  'cat-file', 'grep', 'merge-base', 'name-rev', 'rev-list', 'for-each-ref', 'show-ref', 'count-objects',
  'check-ignore', 'check-attr', 'whatchanged',
]);
// Global git options allowed before the subcommand; anything else (-c, -C, -p, --paginate,
// --git-dir, --work-tree, --exec-path, --config-env) is refused.
const GIT_GLOBAL_OK = new Set(['--no-pager', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects']);

// Unknot subcommands a model may run. Approval, key, config-acceptance and run-ending
// commands are for humans (they also need a TTY); the hook denies them outright.
export const HUMAN_ONLY_SUBCOMMANDS = new Set(['approve', 'attest', 'keys', 'config', 'run', 'policy', 'gc', 'shred', 'daemon', 'unlock', 'backup', 'audit']);

const FIND_DANGEROUS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);

function lit(word) {
  return word.dynamic ? null : word.value;
}

/**
 * A sed script is safe when it only prints, quits, deletes from the output stream or
 * substitutes with print-only flags. `w`, `W`, `e`, `r`, `R` and `s///w|e` reach the
 * filesystem or a shell; braces, labels and branches are refused rather than parsed.
 */
export function sedScriptSafe(script) {
  let i = 0;
  const s = String(script);
  const addr = () => {
    const one = () => {
      if (s[i] === '$') return void i++;
      if (/\d/.test(s[i] ?? '')) {
        while (/\d/.test(s[i] ?? '')) i++;
        if (s[i] === '~') {
          i++;
          while (/\d/.test(s[i] ?? '')) i++;
        }
        return;
      }
      if (s[i] === '/') {
        i++;
        while (i < s.length && s[i] !== '/') i += s[i] === '\\' ? 2 : 1;
        if (s[i] !== '/') throw new Error('unterminated address');
        i++;
        if (s[i] === 'I') i++;
      }
    };
    one();
    if (s[i] === ',') {
      i++;
      one();
    }
    if (s[i] === '!') i++;
  };
  try {
    while (i < s.length) {
      while (/[\s;]/.test(s[i] ?? '')) i++;
      if (i >= s.length) break;
      addr();
      while (s[i] === ' ') i++;
      const cmd = s[i++];
      if (cmd === 'p' || cmd === 'q' || cmd === 'd' || cmd === '=' || cmd === 'n' || cmd === 'N' || cmd === 'P' || cmd === 'D') {
        if (cmd === 'q') while (/\d/.test(s[i] ?? '')) i++;
        continue;
      }
      if (cmd === 's' || cmd === 'y') {
        const delim = s[i++];
        if (!delim || /[\s\\\n]/.test(delim)) return false;
        for (let part = 0; part < 2; part++) {
          while (i < s.length && s[i] !== delim) i += s[i] === '\\' ? 2 : 1;
          if (s[i] !== delim) return false;
          i++;
        }
        if (cmd === 's') {
          const flags = /^[gpiIm0-9]*/.exec(s.slice(i))[0];
          i += flags.length;
        }
        if (i < s.length && !/[\s;]/.test(s[i])) return false;
        continue;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function judgeUnknot(rest) {
  if (rest.some((w) => w.dynamic)) return 'computed arguments to unknot are not allowed';
  const words = rest.map((w) => w.value);
  const sub = words.find((w, i) => !w.startsWith('-') || (w === '--' && false)) ?? null;
  // Any human-only verb anywhere among the leading non-flag words is refused, so
  // `unknot --json approve`, `unknot -- approve` and similar cannot hide one.
  for (const w of words) {
    if (w === '--' || w.startsWith('-')) continue;
    if (HUMAN_ONLY_SUBCOMMANDS.has(w)) return `\`unknot ${w}\` is for a human in their own terminal`;
    break;
  }
  if (sub && HUMAN_ONLY_SUBCOMMANDS.has(sub)) return `\`unknot ${sub}\` is for a human in their own terminal`;
  return null;
}

/** Decide one effective command. Returns null when allowed, else a reason string. */
function judge(cmd, { pluginRoot }) {
  if (cmd.context?.viaWrapper && PRIVILEGE.has(cmd.context.viaWrapper)) return `\`${cmd.context.viaWrapper}\` changes who runs the command and is not allowed`;
  if (!cmd.argv.length) return cmd.assignments.length ? 'bare variable assignments are not allowed' : null;
  const head = cmd.argv[0];
  if (head.dynamic) return 'the command name is computed at run time';
  const name = basenameOf(head);
  if (PRIVILEGE.has(name)) return `\`${name}\` is not allowed`;
  const args = cmd.argv.slice(1);
  const unsafe = cmd.assignments.filter((a) => !SAFE_ASSIGNMENTS.has(a.name));
  if (unsafe.length) return `setting ${unsafe.map((a) => a.name).join(', ')} is not allowed`;
  const flag = EXEC_FLAGS[name] && args.find((w) => EXEC_FLAGS[name].test(w.value));
  if (flag) return `${name} ${flag.value} can run programs or write files`;
  const viaNode = name === 'node' && args[0] && !args[0].dynamic && isUnknotBin(args[0].value, pluginRoot);
  if (name === 'unknot' && !resolvesToPlugin(head.value, pluginRoot)) return '`unknot` does not resolve to this plugin\'s CLI';
  if (name === 'unknot' || viaNode) return judgeUnknot(name === 'unknot' ? args : args.slice(1));
  if (name === 'git') {
    let i = 0;
    while (i < args.length && lit(args[i])?.startsWith('-')) {
      if (!GIT_GLOBAL_OK.has(args[i].value)) return `git ${args[i].value} is not allowed before the subcommand`;
      i++;
    }
    const sub = args[i] ? lit(args[i]) : null;
    if (!sub || !GIT_READ.has(sub)) return `git ${sub ?? ''} is not a read-only git command`;
    if (args.some((w) => /^--output(=|$)|^--ext-diff$|^--textconv$|^-O|^--open-files-in-pager|^--exec(=|$)|^--upload-pack|^--receive-pack|^--paginate$/.test(w.value))) {
      return 'git output, pager and diff-driver flags are not allowed';
    }
    return null;
  }
  if (name === 'find') {
    const bad = args.find((w) => FIND_DANGEROUS.has(w.value));
    return bad ? `find ${bad.value} is not allowed` : null;
  }
  if (name === 'sed') {
    if (args.some((w) => /^-i|^--in-place|^-[a-zA-Z]*i|^-f|^--file|^-[a-zA-Z]*f/.test(w.value))) return 'sed -i edits files and sed -f runs a script file';
    if (!args.some((w) => w.value === '-n' || w.value === '--quiet' || w.value === '--silent')) return 'only `sed -n` is allowed';
    const scripts = [];
    for (let k = 0; k < args.length; k++) {
      if (args[k].value === '-e' || args[k].value === '--expression') scripts.push(args[++k]);
      else if (args[k].value.startsWith('--expression=')) scripts.push({ ...args[k], value: args[k].value.slice(13) });
    }
    if (!scripts.length) {
      const first = args.find((w) => !w.value.startsWith('-'));
      if (first) scripts.push(first);
    }
    if (scripts.some((w) => !w || w.dynamic || !sedScriptSafe(w.value))) return 'sed script can write files or run commands (only print, delete, quit and print-only substitutions are allowed)';
    return null;
  }
  if (OUTPUT_POSITIONAL.has(name) && args.filter((w) => !w.value.startsWith('-')).length > 1) return `${name} with an output file writes it`;
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
  const args = [];
  for (const cmd of commands) {
    const why = judge(cmd, { pluginRoot });
    if (why) reasons.push(why);
    for (const r of cmd.redirects ?? []) {
      const target = r.target;
      if (['>', '>>', '>|', '&>', '&>>', '>&', '<>'].includes(r.op)) {
        if (target.dynamic) reasons.push('redirect target is computed at run time');
        else if (target.value !== '/dev/null' && !/^&?\d+-?$/.test(target.value) && target.value !== '-') writes.push(target.value);
      } else if (['<', '<&'].includes(r.op) && !target.dynamic && !/^\d+$/.test(target.value)) reads.push(target.value);
    }
    // Arguments of read-only tools are reads too: the PDP checks them like redirects.
    const name = cmd.argv[0] && !cmd.argv[0].dynamic ? basenameOf(cmd.argv[0]) : null;
    if (name && (READ_ONLY.has(name) || name === 'git' || name === 'sed' || name === 'find')) {
      for (const w of cmd.argv.slice(1)) {
        if (w.value.startsWith('-') && !w.value.includes('=')) continue;
        if (w.dynamic) {
          if (name !== 'echo' && name !== 'printf') reasons.push(`computed argument ${JSON.stringify(w.value)} to ${name} cannot be checked`);
          continue;
        }
        const v = w.value.includes('=') && w.value.startsWith('-') ? w.value.slice(w.value.indexOf('=') + 1) : w.value;
        if (w.glob && /env|key|pem|secret|credential|id_|\.ssh|token|passw/i.test(v)) reasons.push(`glob ${v} could match credential files`);
        else if (!w.glob) args.push(v);
      }
    }
  }
  if (writes.length) reasons.push(`writing files from the shell is not allowed (${writes.join(', ')})`);
  return { allow: reasons.length === 0, reasons, commands, writes, reads, args };
}
