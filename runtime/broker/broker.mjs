// The command broker (spec §6, §16.3, §19.3). The only way Unknot executes anything:
// argument vectors, never a shell; executables from an allowlist with per-tool argument
// rules; a minimal environment with no credentials; an OS sandbox; hard timeouts and
// output caps; and an evidence record whose digests cover the complete output.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve as resolvePath } from 'node:path';
import { canonicalJSON, digest, randomId } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { isInside, realpathLenient } from '../core/paths.mjs';
import { redact } from '../core/redact.mjs';
import { charge } from '../policy/budget.mjs';
import { casPut } from '../state/cas.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { detectSandbox, wrap } from './sandbox.mjs';

const OUTPUT_CAP = 16 * 1024 * 1024;
const TAIL = 64 * 1024;

// Per-executable argument rules for executables the runtime itself drives. Configured
// project commands (config.commands) are human-authored and run as declared.
const TOOL_RULES = {
  git: { allow: new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'worktree', 'hash-object', 'merge-base', 'rev-list', 'blame', 'apply', 'add', 'commit', 'checkout', 'branch', 'reset', 'stash', 'for-each-ref', 'show-ref', 'check-ignore', 'config', 'update-index', 'write-tree', 'read-tree']) },
  terraform: { allow: new Set(['version', 'validate', 'fmt', 'show', 'graph', 'providers']), deny: /^(apply|destroy|import|state|taint|untaint|force-unlock|login|console|refresh|push)$/ },
  tofu: { allow: new Set(['version', 'validate', 'fmt', 'show', 'graph', 'providers']), deny: /^(apply|destroy|import|state|taint|untaint|force-unlock|login|console|refresh)$/ },
  kubectl: { allow: new Set(['version', 'kustomize', 'apply', 'create', 'diff']), needs: /^--dry-run=(client|server)$/ },
  helm: { allow: new Set(['template', 'lint', 'show', 'version', 'dependency']) },
  kustomize: { allow: new Set(['build', 'version']) },
  python3: { allow: null },
  node: { allow: null },
  semgrep: { allow: null },
  gitleaks: { allow: new Set(['detect', 'protect', 'dir', 'git', 'version']) },
  trivy: { allow: new Set(['config', 'fs', 'image', 'version']) },
  'osv-scanner': { allow: null },
};

function subcommand(args) {
  for (const a of args) if (!a.startsWith('-')) return a;
  return null;
}

// System binary directories where an absolute tool path is acceptable.
const SYSTEM_BIN = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/run/current-system/sw/bin'];

// Flags that make a rendering tool execute programs from the repository under analysis.
const EXEC_FLAGS = /^--post-renderer|^--enable-exec|^--enable-alpha-plugins|^--enable-helm|^--load-restrictor|^--plugin|^--exec/;

/** Validate an argv for a runtime-internal tool. Returns null or a denial reason. */
export function checkInternalArgv(argv) {
  // A bare name only: `./git` or `/tmp/x/terraform` could be a binary the repository put
  // there, named like a tool the runtime trusts.
  if ((argv[0].includes('/') || argv[0].includes('\\')) && !SYSTEM_BIN.some((d) => argv[0].startsWith(`${d}/`) && !argv[0].slice(d.length + 1).includes('/'))) {
    return `${argv[0]} must be a bare executable name or live in a system bin directory`;
  }
  const name = basename(argv[0]);
  const rule = TOOL_RULES[name];
  if (!rule) return `${name} is not an executable the runtime drives`;
  const args = argv.slice(1);
  const sub = subcommand(args);
  if (rule.deny && sub && rule.deny.test(sub)) return `${name} ${sub} is forbidden`;
  if (rule.allow && (!sub || !rule.allow.has(sub))) return `${name} ${sub ?? ''} is not allowed`;
  const exec = args.find((a) => EXEC_FLAGS.test(a));
  if (exec) return `${name} ${exec} executes programs and is not allowed`;
  if (rule.needs && ['apply', 'create'].includes(sub)) {
    // Every --dry-run must be client or server: kubectl takes the last one, so a later
    // `--dry-run=none` would turn a preview into a real apply.
    const dry = args.filter((a) => a === '--dry-run' || a.startsWith('--dry-run='));
    if (!dry.length || dry.some((a) => !rule.needs.test(a))) return `${name} ${sub} requires --dry-run=client or --dry-run=server and nothing else`;
  }
  if (name === 'git' && sub === 'push') return 'git push is never run by Unknot';
  if (name === 'helm' && sub === 'dependency' && !['list'].includes(args[args.indexOf('dependency') + 1])) return 'helm dependency is limited to list';
  return null;
}

/** Absolute path of an executable, or null. Bare names are searched on PATH. */
export function which(file, pathEnv = process.env.PATH ?? '') {
  if (file.includes('/')) {
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      return null;
    }
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, file), constants.X_OK);
      return join(dir, file);
    } catch {
      // next PATH entry
    }
  }
  return null;
}

/** The environment a brokered process sees: enough to run toolchains, no credentials. */
export function minimalEnv({ tmp, extra = {} } = {}) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'USER', 'LOGNAME', 'JAVA_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'PYENV_ROOT', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', 'VIRTUAL_ENV'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, { HOME: homedir(), TERM: 'dumb', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', UNKNOT_SANDBOXED: '1' });
  if (tmp) Object.assign(env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  for (const [k, v] of Object.entries(extra)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^GH_|^GITHUB_|^NPM_|^DATABASE_URL$/i.test(k)) {
      throw new UnknotError('UK_POLICY_DENIED', `environment variable ${k} looks like a credential and is never passed to brokered commands`);
    }
    env[k] = String(v);
  }
  return env;
}

/**
 * Execute one argv.
 * @param {object} ctx project context
 * @param {object} req
 * @param {string[]} req.argv
 * @param {string} req.cwd
 * @param {'internal'|'configured'} req.origin internal tools are checked by TOOL_RULES;
 *   configured commands come from config.commands (and obligation commands derived from them)
 * @param {object} [req.run] active run (for budgets and evidence attribution)
 * @param {string[]} [req.writable] extra writable roots (worktree, artifact dir)
 * @param {boolean} [req.network]
 * @param {number} [req.timeoutMs]
 * @param {string|Buffer} [req.input] stdin
 * @param {object} [req.config] effective config (sandbox requirement, redaction)
 * @param {string} [req.obligation] obligation id, for the evidence record
 * @param {string} [req.sliceId]
 * @param {string} [req.diffHash]
 * @returns {Promise<{record: object, stdout: Buffer, stderr: Buffer, stdoutTail: string, stderrTail: string}>}
 */
export async function brokerExec(ctx, req) {
  const { argv, cwd, origin = 'internal', run = null, writable = [], network = false, timeoutMs = 120_000, input, config, obligation = null, sliceId = null, diffHash = null } = req;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new UnknotError('UK_POLICY_DENIED', 'argv must be a non-empty array of strings without NUL bytes');
  }
  if (origin === 'internal') {
    const why = checkInternalArgv(argv);
    if (why) throw new UnknotError('UK_POLICY_DENIED', why, { details: { argv } });
  } else if (origin !== 'configured') {
    throw new UnknotError('UK_POLICY_DENIED', `unknown command origin ${origin}`);
  }
  if ((config?.forbid_executables ?? []).includes(basename(argv[0]))) {
    throw new UnknotError('UK_POLICY_DENIED', `${basename(argv[0])} is forbidden by organization policy`);
  }
  const realCwd = realpathLenient(cwd);
  if (!isInside(realpathLenient(ctx.root), realCwd)) throw new UnknotError('UK_SCOPE_VIOLATION', `cwd ${cwd} is outside the project`);
  if (network && (config?.limits?.max_network_requests ?? 0) === 0) {
    throw new UnknotError('UK_POLICY_DENIED', 'network is disabled for this project', { details: { policy: 'limits.max_network_requests' } });
  }
  if (run) charge(ctx, run, 'commands', 1);

  const resolved = which(argv[0].includes('/') ? resolvePath(cwd, argv[0]) : argv[0], process.env.PATH);
  if (origin === 'internal' && resolved && isInside(realpathLenient(ctx.root), realpathLenient(resolved))) {
    throw new UnknotError('UK_POLICY_DENIED', `${argv[0]} resolves inside the repository (${resolved}); the runtime does not execute repository-supplied tools`);
  }
  const runDir = join(ctx.paths.runs, run?.id ?? 'adhoc');
  const tmp = join(runDir, 'tmp');
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const sandboxKind = detectSandbox();
  const wrapped = wrap(argv, { kind: sandboxKind, writable: [...writable, runDir], network, requireSandbox: config?.security?.require_os_sandbox ?? false });
  const env = minimalEnv({ tmp });
  const execId = `ex-${randomId(6)}`;
  const startedAt = nowISO();
  const envDigest = digest({ keys: Object.keys(env).sort(), path: env.PATH, sandbox: wrapped.sandbox, network });
  appendEvent(ctx, { type: 'exec.started', run_id: run?.id, slice_id: sliceId, actor: 'runtime:broker', payload: { exec_id: execId, argv, cwd: realCwd, sandbox: wrapped.sandbox, origin } });

  const result = !resolved
    ? { error: Object.assign(new Error(`${argv[0]}: not found`), { code: 'ENOENT' }), streams: { stdout: { chunks: [], size: 0, hash: createHash('sha256'), truncated: false }, stderr: { chunks: [], size: 0, hash: createHash('sha256'), truncated: false } }, timedOut: false, durationMs: 0 }
    : await new Promise((resolvePromise) => {
    const started = process.hrtime.bigint();
    const child = spawn(wrapped.file, wrapped.args, { cwd: realCwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const streams = { stdout: { chunks: [], size: 0, hash: createHash('sha256'), truncated: false }, stderr: { chunks: [], size: 0, hash: createHash('sha256'), truncated: false } };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => {
        const s = streams[name];
        s.hash.update(chunk);
        if (s.size < OUTPUT_CAP) s.chunks.push(chunk.subarray(0, OUTPUT_CAP - s.size));
        else s.truncated = true;
        s.size += chunk.length;
      });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ error: err, streams, timedOut, durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, streams, timedOut, durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n) });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });

  const stdout = Buffer.concat(result.streams.stdout.chunks);
  const stderr = Buffer.concat(result.streams.stderr.chunks);
  const stdoutRef = casPut(ctx, stdout, { mediaType: 'text/plain', runId: run?.id, label: `${execId}.stdout` });
  const stderrRef = casPut(ctx, stderr, { mediaType: 'text/plain', runId: run?.id, label: `${execId}.stderr` });
  const exitCode = result.error ? null : result.code ?? null;
  const verdict = result.error || result.timedOut || exitCode === null ? 'inconclusive' : exitCode === 0 ? 'pass' : 'fail';
  const record = {
    id: execId,
    obligation,
    slice_id: sliceId,
    run_id: run?.id ?? null,
    command: argv,
    working_directory: realCwd,
    environment_digest: envDigest,
    started_at: startedAt,
    duration_ms: result.durationMs,
    exit_code: exitCode,
    stdout_digest: `sha256:${result.streams.stdout.hash.digest('hex')}`,
    stderr_digest: `sha256:${result.streams.stderr.hash.digest('hex')}`,
    artifact_refs: [stdoutRef, stderrRef],
    sandbox: wrapped.sandbox,
    timed_out: result.timedOut,
    truncated: result.streams.stdout.truncated || result.streams.stderr.truncated,
    diff_hash: diffHash,
    verdict,
    error: result.error ? String(result.error.code ?? result.error.message) : null,
  };
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, 'command-log.jsonl'), `${canonicalJSON(record)}\n`);
  appendEvent(ctx, { type: 'exec.finished', run_id: run?.id, slice_id: sliceId, actor: 'runtime:broker', payload: { exec_id: execId, exit_code: exitCode, verdict, duration_ms: result.durationMs, stdout_digest: record.stdout_digest } });
  const tail = (buf) => redact(buf.subarray(Math.max(0, buf.length - TAIL)).toString('utf8'), { extraPatterns: config?.security?.redact_patterns ?? [] }).text;
  return { record, stdout, stderr, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
}

/** Adapter-facing exec: internal origin, no network, bounded, returns plain output. */
export function adapterExec(ctx, { run, config, cwd }) {
  return async (argv, { input, timeoutMs = 120_000 } = {}) => {
    try {
      const r = await brokerExec(ctx, { argv, cwd: cwd ?? ctx.root, origin: 'internal', run, config, input, timeoutMs });
      if (r.record.error === 'ENOENT') throw new UnknotError('UK_ADAPTER_UNSUPPORTED', `${argv[0]} is not installed`);
      return { exitCode: r.record.exit_code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), record: r.record };
    } catch (err) {
      if (err instanceof UnknotError && err.code === 'UK_POLICY_DENIED') {
        throw new UnknotError('UK_ADAPTER_UNSUPPORTED', err.message, { cause: err });
      }
      throw err;
    }
  };
}
