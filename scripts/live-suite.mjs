#!/usr/bin/env node
// Live-session suite: Unknot installed the way a user installs it, driven by real headless
// Claude Code sessions on public repositories pinned in scripts/live-suite.json. It catches
// what unit tests cannot: skills that steer the model wrong, hooks that deny a legitimate step,
// sandbox breakage in the installed layout, silent fallbacks, crashes in the CLI. Runs nightly
// in CI (.github/workflows/live.yml) and before a release.
//
// Usage: node scripts/live-suite.mjs [--install fresh|local|installed] [--repos a,b]
//   [--steps init,map,...] [--change rotate|all|none|<name>] [--model sonnet] [--out <dir>]
//   [--local <path,...>]   also run the read-only steps on local checkouts (cloned to a
//                          temporary directory first; never opened for writing)
//   fresh      a new CLAUDE_CONFIG_DIR; `claude plugin marketplace add <this checkout>` and
//              `claude plugin install unknot@unknot`. Needs ANTHROPIC_API_KEY. The CI mode.
//   local      the current Claude config, with this checkout as --plugin-dir and the catalog
//              install (unknot@quintinbotes) switched off for the sessions.
//   installed  the current Claude config and whatever Unknot it has installed.
// A session fails on a non-zero exit, no successful result, a crash in a tool result, or a
// map notice (a degraded, fallback analysis). Hook denials and Unknot errors are reported as
// warnings: the model may try something the policy rightly refuses.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const install = opt('--install', process.env.ANTHROPIC_API_KEY ? 'fresh' : 'local');
const model = opt('--model', 'sonnet');
const T = realpathSync(tmpdir());
const out = opt('--out') ?? mkdtempSync(join(T, 'uk-live-'));
mkdirSync(out, { recursive: true });
const suite = JSON.parse(readFileSync(join(ROOT, 'scripts/live-suite.json'), 'utf8'));
const only = opt('--repos')?.split(',');
const local = (opt('--local')?.split(',') ?? []).filter(Boolean).map((p) => ({ name: p.replace(/\/+$/, '').split('/').pop(), path: p }));
const repos = [...suite.repos.filter((r) => !only || only.includes(r.name)), ...local];
const steps = (opt('--steps') ?? 'init,map,diagnose,explain,decompose').split(',');
const log = (s) => process.stderr.write(`${s}\n`);

const sh = (file, argv, o = {}) => spawnSync(file, argv, { encoding: 'utf8', maxBuffer: 256 << 20, ...o });
const must = (r, what) => {
  if (r.status !== 0) {
    log(`${what} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(-600)}`);
    process.exit(2);
  }
  return r;
};

// --- Install --------------------------------------------------------------------------------
const env = { ...process.env };
let pluginArgs = [];
if (install === 'fresh') {
  if (!env.ANTHROPIC_API_KEY) {
    log('--install fresh needs ANTHROPIC_API_KEY (a new Claude config has no login)');
    process.exit(2);
  }
  env.CLAUDE_CONFIG_DIR = mkdtempSync(join(T, 'uk-live-claude-'));
  must(sh('claude', ['plugin', 'marketplace', 'add', ROOT], { env }), 'marketplace add');
  must(sh('claude', ['plugin', 'install', 'unknot@unknot'], { env }), 'plugin install');
} else if (install === 'local') {
  pluginArgs = ['--plugin-dir', ROOT, '--settings', JSON.stringify({ enabledPlugins: { 'unknot@quintinbotes': false } })];
} else if (install !== 'installed') {
  log(`unknown --install ${install}`);
  process.exit(2);
}

/** The CLI the sessions use: the installed copy, or this checkout for --install local. */
function unknotBin() {
  if (install === 'local') return join(ROOT, 'bin/unknot');
  const cache = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'plugins/cache');
  const found = [];
  for (const market of existsSync(cache) ? readdirSync(cache) : []) {
    const dir = join(cache, market, 'unknot');
    if (existsSync(dir)) for (const v of readdirSync(dir)) found.push({ v, bin: join(dir, v, 'bin/unknot') });
  }
  found.sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
  if (!found.length) {
    log(`no installed unknot under ${cache}`);
    process.exit(2);
  }
  return found.at(-1).bin;
}
const BIN = unknotBin();
log(`install: ${install}; unknot: ${BIN}; report: ${out}`);

// --- Transcript checks ----------------------------------------------------------------------
const CRASH = /node:internal|Unhandled 'error' event|\b(TypeError|RangeError|ReferenceError|SyntaxError): |Traceback \(most recent call last\)|UK_INTERNAL/;
// A map notice, or the fallback notice itself. Not "read lexically" alone: languages without
// a full parser (Rust, Go) are always read lexically, and their findings say so.
const DEGRADED = /"notices"\s*:|were read lexically, with lower confidence/;

function analyze(stdout) {
  const a = { result: null, cost: 0, turns: 0, failures: [], warnings: [] };
  for (const line of String(stdout ?? '').split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'result') Object.assign(a, { result: e.subtype, cost: e.total_cost_usd ?? 0, turns: e.num_turns ?? 0 });
    if (e.type !== 'user') continue;
    for (const c of e.message?.content ?? []) {
      if (c?.type !== 'tool_result') continue;
      const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x?.text ?? '').join(' ');
      const short = text.replace(/\s+/g, ' ').slice(0, 200);
      if (CRASH.test(text)) a.failures.push(`crash: ${short}`);
      else if (DEGRADED.test(text)) a.failures.push(`degraded analysis: ${short}`);
      else if (c.is_error) a.warnings.push(/hook error/.test(text) ? `hook denial: ${short}` : `tool error: ${short}`);
    }
  }
  return a;
}

function session(work, home, prompt) {
  const r = sh('claude', ['-p', prompt, ...pluginArgs, '--model', model, '--allowedTools', 'Bash(unknot *)', 'Bash(unknot:*)', 'Read', 'Grep', 'Glob', 'mcp__plugin_unknot_unknot', '--output-format', 'stream-json', '--verbose'], {
    cwd: work, env: { ...env, UNKNOT_HOME: home }, input: '', timeout: 20 * 60_000,
  });
  const a = analyze(r.stdout);
  if (r.status !== 0) a.failures.unshift(`exit ${r.status ?? r.signal}: ${(r.stderr ?? '').slice(-200)}`);
  else if (a.result !== 'success') a.failures.unshift(`no successful result (${a.result ?? 'none'})`);
  return { a, stdout: r.stdout ?? '' };
}

// --- Repositories ---------------------------------------------------------------------------
function fetchRepo(r) {
  const dir = mkdtempSync(join(T, `uk-live-src-${r.name}-`));
  must(sh('git', ['init', '-q', dir]), 'git init');
  must(sh('git', ['-C', dir, 'fetch', '-q', '--depth', '1', r.url, r.commit]), `fetch ${r.name}`);
  must(sh('git', ['-C', dir, 'checkout', '-q', '-B', 'main', 'FETCH_HEAD']), 'checkout');
  return dir;
}

const day = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86_400_000);
const changeOpt = opt('--change', 'rotate');
const changeFor = (r, i) => Boolean(r.change) && (changeOpt === 'all' || changeOpt === r.name || (changeOpt === 'rotate' && i === day % repos.length));

const report = { install, model, started: new Date().toISOString(), repos: [] };
for (const [i, r] of repos.entries()) {
  const src = r.path ?? fetchRepo(r);
  const work = mkdtempSync(join(T, `uk-live-${r.name}-`));
  must(sh('git', ['clone', '-q', '--no-hardlinks', src, work]), 'clone');
  const home = mkdtempSync(join(T, 'uk-live-home-'));
  const entry = { name: r.name, commit: r.commit ?? sh('git', ['-C', src, 'rev-parse', 'HEAD']).stdout.trim(), sessions: {}, failures: [], warnings: [], cost: 0 };
  for (const step of steps) {
    let prompt = `/unknot:${step}`;
    if (step === 'explain') {
      const d = sh(process.execPath, [BIN, 'diagnose', '--limit', '1', '--json'], { cwd: work, env: { ...env, UNKNOT_HOME: home } });
      let id = null;
      try {
        id = JSON.parse(d.stdout).findings?.[0]?.id ?? null;
      } catch {
        entry.failures.push(`explain: diagnose --json did not return JSON (${d.status})`);
      }
      if (!id) continue;
      prompt = `/unknot:explain ${id}`;
    }
    const t0 = Date.now();
    const { a, stdout } = session(work, home, prompt);
    writeFileSync(join(out, `${r.name}.${step}.jsonl`), stdout);
    entry.sessions[step] = { result: a.result, cost: +a.cost.toFixed(3), turns: a.turns, secs: Math.round((Date.now() - t0) / 1000), failures: a.failures.length, warnings: a.warnings.length };
    entry.cost += a.cost;
    entry.failures.push(...a.failures.map((f) => `${step}: ${f}`));
    entry.warnings.push(...a.warnings.map((w) => `${step}: ${w}`));
    log(`${r.name} ${step}: ${a.result ?? 'no result'}, ${a.failures.length} failures, ${a.warnings.length} warnings, $${a.cost.toFixed(2)}`);
  }
  // The map the sessions left behind, as the installed CLI reports it now.
  if (steps.includes('map')) {
    const m = sh(process.execPath, [BIN, 'map', '--json'], { cwd: work, env: { ...env, UNKNOT_HOME: home } });
    let j = null;
    try {
      j = JSON.parse(m.stdout);
    } catch {
      entry.failures.push(`map --json did not return JSON (${m.status}): ${(m.stderr ?? '').slice(-200)}`);
    }
    if (j?.error) entry.failures.push(`map --json: ${j.error.code}: ${j.error.message}`);
    else if (j) {
      entry.map = { status: j.status, files: j.files, failure_count: j.failure_count, notices: j.notices ?? [] };
      if (j.status !== 'complete' || j.failure_count) entry.failures.push(`map: ${j.status}, ${j.failure_count} failures`);
      if (j.notices?.length) entry.failures.push(`map notices: ${j.notices.join(' | ').slice(0, 300)}`);
    }
  }
  if (changeFor(r, i)) {
    const c = r.change;
    const file = join(out, `${r.name}.change.json`);
    const w = sh(process.execPath, [join(ROOT, 'scripts/writepath-e2e.mjs'), '--repo', src, '--lang', c.lang, '--within', c.within, '--setup', c.setup, '--test', JSON.stringify(c.test), '--model', model, ...(install === 'local' ? ['--plugin-dir', ROOT] : []), '--out', file], { env, timeout: 60 * 60_000 });
    let rep = null;
    try {
      rep = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // reported below
    }
    const st = rep?.steps ?? {};
    entry.change = { ok: rep?.ok ?? false, state: st.result?.state ?? st.verified?.state ?? null, finding: st.finding?.title ?? st.finding?.error ?? null, staged: st.result?.staged ?? [] };
    const changeCost = (st.apply?.cost ?? 0) + (st.verify?.cost ?? 0);
    entry.cost += changeCost;
    if (!entry.change.ok) entry.failures.push(`change workflow: ended ${entry.change.state ?? 'before the sessions'} (${(w.stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)})`);
    for (const s of ['apply', 'verify']) for (const e of st[s]?.errors ?? []) (CRASH.test(e) ? entry.failures : entry.warnings).push(`change ${s}: ${e.replace(/\s+/g, ' ')}`);
    log(`${r.name} change: ${entry.change.ok ? 'ACCEPTED' : `failed (${entry.change.state})`}, $${changeCost.toFixed(2)}`);
  }
  entry.cost = +entry.cost.toFixed(3);
  report.repos.push(entry);
}

// --- Report ---------------------------------------------------------------------------------
report.ok = report.repos.every((r) => r.failures.length === 0);
report.cost = +report.repos.reduce((n, r) => n + r.cost, 0).toFixed(2);
writeFileSync(join(out, 'summary.json'), JSON.stringify(report, null, 2));
const md = [
  `## Unknot live-session suite: ${report.ok ? 'pass' : 'FAIL'}`,
  '',
  `Install: ${install}, model: ${model}, cost: $${report.cost}`,
  '',
  '| repo | sessions | map | change | failures | warnings |',
  '| --- | --- | --- | --- | --- | --- |',
  ...report.repos.map((r) => `| ${r.name} | ${Object.entries(r.sessions).map(([k, v]) => `${k}:${v.result === 'success' && !v.failures ? 'ok' : 'FAIL'}`).join(' ')} | ${r.map ? `${r.map.status}, ${r.map.files} files` : 'n/a'} | ${r.change ? (r.change.ok ? 'ACCEPTED' : `FAIL (${r.change.state})`) : '-'} | ${r.failures.length} | ${r.warnings.length} |`),
  '',
  ...report.repos.flatMap((r) => [...r.failures.map((f) => `- FAIL ${r.name} ${f}`), ...r.warnings.map((w) => `- warn ${r.name} ${w}`)]),
  '',
].join('\n');
writeFileSync(join(out, 'summary.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
process.stdout.write(md);
process.exit(report.ok ? 0 : 1);
