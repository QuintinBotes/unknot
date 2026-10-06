#!/usr/bin/env node
// Upgrade test: a project mapped by an earlier release must keep working, in place, on this
// checkout. For each of the last N release tags: `git archive` the tag, run init, map, diagnose
// and decompose with it on a fixture project (C#, TypeScript, Python), then run map, diagnose,
// decompose, status and doctor with the current checkout on the same project, and check that
// the state migrated, stable things stayed stable and nothing is left broken.
//
// Usage: node scripts/upgrade-test.mjs [--count N] [--tags v0.1.14,v0.1.15] [--keep] [--verbose]
// Needs the release tags in the clone (CI: fetch-depth 0). Exit 1 when any upgrade fails.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compatLevel, LATEST_SCHEMA_VERSION, MIGRATIONS } from '../runtime/state/migrations.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const has = (name) => args.includes(`--${name}`);
const count = Number(flag('count') ?? 5);
const wanted = flag('tags')?.split(',').filter(Boolean);
const keep = has('keep');
const verbose = has('verbose');

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const semver = (t) => t.replace(/^v/, '').split('.').map(Number);
const cmp = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const tags = wanted ?? git('tag', '--list', 'v[0-9]*').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(cmp).slice(-count);
if (!tags.length) {
  process.stderr.write('no release tags found (a shallow clone needs `git fetch --tags --unshallow`)\n');
  process.exit(2);
}

// ---- the fixture project --------------------------------------------------------------------

const cs = (ns, name, uses, injected) => `namespace Shop.${ns}
{
    public class ${name}
    {
${injected.map((i) => `        private readonly ${i} _${i.toLowerCase()};`).join('\n')}
        public ${name}(${injected.map((i) => `${i} ${i.toLowerCase()}`).join(', ')})
        {
${injected.map((i) => `            _${i.toLowerCase()} = ${i.toLowerCase()};`).join('\n')}
        }
        public int Run() { ${uses.map((u) => `var x${u} = new ${u}(); `).join('')}return 1; }
    }
}
`;
const ts = (name, imports) => `${imports.map((i) => `import { ${i} } from './${i}';`).join('\n')}\nexport function ${name}(): number { return ${imports.length ? imports.map((i) => `${i}()`).join(' + ') : 1}; }\n`;
const py = (name, imports) => `${imports.map((i) => `from .${i} import ${i}`).join('\n')}\n\n\ndef ${name}():\n    return ${imports.length ? imports.map((i) => `${i}()`).join(' + ') : 1}\n`;

function fixtureFiles() {
  const f = {};
  const group = (names) => names.map((n) => [n, names.filter((m) => m !== n)]);
  for (const [ns, names] of [['Orders', ['OrderService', 'OrderRepo', 'OrderPolicy', 'OrderMailer', 'OrderAudit']], ['Stock', ['StockService', 'StockRepo', 'StockPolicy', 'StockMailer', 'StockAudit']]]) {
    for (const [n, others] of group(names)) f[`src/${ns}/${n}.cs`] = cs(ns, n, others.slice(0, 2), others.slice(2, 3).concat(n === names[0] ? ['Unused'] : []));
  }
  f['src/Shared/Unused.cs'] = 'namespace Shop.Orders\n{\n    public class Unused { }\n}\n';
  f['src/Shop.csproj'] = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';
  f['qa/Shop.Checks/Shop.Checks.csproj'] = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup></Project>\n';
  const helpers = ['Helpers', 'Builders', 'Fakes', 'Clock', 'Seeds'];
  for (const [n, others] of group(helpers)) f[`qa/Shop.Checks/${n}.cs`] = cs('Checks', n, others.slice(0, 2), others.slice(2, 3));
  for (const [dir, names] of [['web/orders', ['cart', 'checkout', 'pricing', 'summary', 'receipt']], ['web/stock', ['levels', 'reorder', 'forecast', 'alerts', 'report']]]) {
    for (const [n, others] of group(names)) f[`${dir}/${n}.ts`] = ts(n, others.slice(0, 2));
  }
  f['web/orders/cart.test.ts'] = "import { cart } from './cart';\nexport const t = cart();\n";
  for (const [dir, names] of [['py/billing', ['invoice', 'ledger', 'tax', 'refund', 'export']], ['py/catalog', ['items', 'prices', 'search', 'tags', 'media']]]) {
    f[`${dir}/__init__.py`] = '';
    for (const [n, others] of group(names)) f[`${dir}/${n}.py`] = py(n, others.slice(0, 2));
  }
  return f;
}

function makeProject(dir) {
  for (const [p, text] of Object.entries(fixtureFiles())) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.email=upgrade-test@example.invalid', '-c', 'user.name=upgrade-test', 'commit', '-q', '-m', 'fixture');
}

// ---- running one version --------------------------------------------------------------------

function cli(bin, project, home, argv) {
  const r = spawnSync(process.execPath, [join(bin, 'bin/unknot'), ...argv], {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 300_000,
    env: { ...process.env, UNKNOT_HOME: home, CLAUDE_PLUGIN_ROOT: bin, NO_COLOR: '1' },
  });
  let json = null;
  if (argv.includes('--json')) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      // reported by the caller as a failure to produce JSON
    }
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const storeMeta = (project) => {
  const db = new DatabaseSync(join(project, '.unknot/state/unknot.db'), { readOnly: true });
  try {
    return Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  } catch {
    return {};
  } finally {
    db.close();
  }
};

const records = (project) => {
  const dir = join(project, '.unknot/decompositions');
  try {
    return readdirSync(dir).filter((n) => /^DEC-\d+\.json$/.test(n)).sort().map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
  } catch {
    return [];
  }
};

function upgradeFrom(tag, work) {
  const problems = [];
  const fail = (msg) => problems.push(msg);
  const note = [];
  const old = join(work, `old-${tag}`);
  mkdirSync(old, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', tag], { cwd: root, maxBuffer: 1 << 28 });
  const x = spawnSync('tar', ['-x', '-C', old], { input: tar });
  if (x.status !== 0) return { tag, problems: [`could not extract ${tag}`], note };
  const project = join(work, `project-${tag}`);
  mkdirSync(project, { recursive: true });
  makeProject(project);
  const home = join(work, `home-${tag}`);
  const step = (bin, label, argv, { allowFail = false } = {}) => {
    const r = cli(bin, project, home, argv);
    if (verbose) process.stderr.write(`  ${label}: exit ${r.code}\n`);
    if (!allowFail && r.code !== 0) fail(`${label}: exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
    else if (argv.includes('--json') && !r.json && !allowFail) fail(`${label}: no JSON on stdout`);
    return r;
  };

  // The earlier release builds the state.
  step(old, `${tag} init`, ['init'], { allowFail: true });
  step(old, `${tag} map`, ['map', '--json']);
  const dOld = step(old, `${tag} diagnose`, ['diagnose', '--json']);
  step(old, `${tag} decompose`, ['decompose', '--json']);
  if (problems.length) return { tag, problems, note };
  const oldFindings = new Map((dOld.json?.findings ?? []).map((f) => [f.fingerprint, f]));
  const oldRecords = records(project);
  if (!oldFindings.size) fail('the fixture produced no findings with the earlier release: the stability check would prove nothing');
  if (!oldRecords.length) fail('the fixture produced no decomposition records with the earlier release');

  // This checkout upgrades the same project in place.
  const before = storeMeta(project);
  const m = step(root, 'map', ['map', '--json']);
  const d = step(root, 'diagnose', ['diagnose', '--json']);
  const dec = step(root, 'decompose', ['decompose', '--json']);
  const list = step(root, 'decompose list', ['decompose', 'list', '--json']);
  const st = step(root, 'status', ['status', '--json']);
  const doc = step(root, 'doctor', ['doctor', '--json']);
  note.push(`schema ${before.schema_version ?? 'none'} -> ${storeMeta(project).schema_version}`);

  // The store migrated: opened by this checkout, recorded as current, and still at a
  // schema_version the earlier release accepts unless a migration it cannot live with ran.
  const meta = storeMeta(project);
  const latest = LATEST_SCHEMA_VERSION;
  const compat = compatLevel(new Set(MIGRATIONS.map((x) => x.name)));
  if (Number(meta.schema_applied) !== latest) fail(`store migrations applied up to ${meta.schema_applied} after the upgrade, expected ${latest}`);
  if (Number(meta.schema_version) !== compat) fail(`store schema_version ${meta.schema_version} after the upgrade, expected ${compat}`);

  // A session still running the earlier release's hooks keeps its shell once this checkout
  // has opened the store (an upgrade in place, before the session reloads its plugins).
  const oldHook = join(old, 'bin', 'unknot-hook');
  if (existsSync(oldHook)) {
    for (const command of ['echo hi', 'git status']) {
      const h = spawnSync(process.execPath, [oldHook, 'PreToolUse'], {
        cwd: project,
        input: JSON.stringify({ cwd: project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, UNKNOT_HOME: home, CLAUDE_PLUGIN_ROOT: old },
      });
      let answer = null;
      try {
        answer = h.stdout.trim() ? JSON.parse(h.stdout).hookSpecificOutput ?? null : null;
      } catch {
        answer = { permissionDecision: 'unreadable', permissionDecisionReason: h.stdout.slice(0, 160) };
      }
      if (answer?.permissionDecision === 'deny' || answer?.permissionDecision === 'unreadable') fail(`the ${tag} hook refuses \`${command}\` once this checkout has opened the store: ${String(answer.permissionDecisionReason ?? '').slice(0, 200)}`);
    }
  } else note.push('no hook in this tag');
  if (!meta.migrations || !JSON.parse(meta.migrations).includes('initial-schema')) fail(`migrations not recorded in meta (${meta.migrations})`);

  // Stable fingerprints: every earlier finding is still found, under the same fingerprint.
  const now = new Map((d.json?.findings ?? []).map((f) => [f.fingerprint, f]));
  // (A finding about nothing but code the census now classifies as test code is rightly gone.)
  const onlyTests = (f) => f.scope?.length && f.scope.every((p) => /^qa\/Shop\.Checks\//.test(p));
  for (const [fp, f] of oldFindings) if (!now.has(fp) && !onlyTests(f)) fail(`finding ${f.kind} (${f.title}) changed fingerprint or disappeared`);
  if (d.json?.errors?.length) fail(`diagnose reported errors: ${JSON.stringify(d.json.errors).slice(0, 200)}`);

  // Decomposition ids: reused, or the new record names the old one, or the old one is marked superseded.
  const newRecords = records(project);
  const supersedes = new Set(newRecords.map((r) => r.supersedes).filter(Boolean));
  const listed = new Map((list.json?.records ?? list.json ?? []).map?.((r) => [r.id, r]) ?? []);
  for (const o of oldRecords) {
    const rewritten = newRecords.find((r) => r.id === o.id);
    if (rewritten && rewritten.fingerprint && rewritten.run_id !== o.run_id) continue; // reused: overwritten by this run
    if (supersedes.has(o.id)) continue;
    if (listed.get(o.id)?.superseded) continue;
    fail(`decomposition ${o.id} (${o.candidate?.name}) is neither reused, superseded by a new record, nor marked as replaced`);
  }
  for (const r of newRecords) if (r.graph_generation === Number(meta.generation) && !r.fingerprint) fail(`record ${r.id} written without a fingerprint`);

  // Changed classification: files the census calls tests now are not candidate members, and a second map finds nothing to extract.
  for (const r of newRecords.filter((x) => x.graph_generation === Number(meta.generation))) {
    const tests = (r.candidate?.modules ?? []).filter((mod) => /qa\/Shop\.Checks\//.test(mod));
    if (tests.length) fail(`record ${r.id} still has test code as members: ${tests.join(', ')} (stale extraction cache)`);
  }
  const again = step(root, 'map (again)', ['map', '--json']);
  if (again.json?.cache && again.json.cache.extracted !== 0) fail(`a second map re-extracted ${again.json.cache.extracted} facts: the cache key is unstable`);
  const reused = newRecords.filter((r) => oldRecords.some((o) => o.id === r.id && o.fingerprint && o.fingerprint === r.fingerprint && o.run_id !== r.run_id)).length;
  const staleTests = oldRecords.filter((o) => (o.candidate?.modules ?? []).some((mod) => /qa\/Shop\.Checks\//.test(mod))).length;
  note.push(`${oldFindings.size} findings, ${oldRecords.length} records (${reused} reused by fingerprint, ${supersedes.size} superseded, ${staleTests} had test members)`);
  note.push(`first map extracted ${m.json?.cache?.extracted ?? '?'}`);

  // Nothing broken.
  if (st.json) {
    if (st.json.blockers?.length) fail(`status reports blockers: ${JSON.stringify(st.json.blockers).slice(0, 200)}`);
    if (st.json.graph?.stale) fail('status reports the graph as stale right after mapping');
  }
  if (doc.json && doc.json.ok === false) fail(`doctor not ok: ${(doc.json.checks ?? []).filter((c) => c.level === 'error' || c.level === 'fail').map((c) => `${c.name}: ${c.detail}`).join('; ')}`);
  return { tag, problems, note };
}

// ---- main -----------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'unknot-upgrade-'));
const results = [];
for (const tag of tags) {
  process.stdout.write(`upgrade from ${tag} ... `);
  let r;
  try {
    r = upgradeFrom(tag, work);
  } catch (err) {
    r = { tag, problems: [`crashed: ${err.stack ?? err}`], note: [] };
  }
  results.push(r);
  process.stdout.write(r.problems.length ? 'FAILED\n' : `ok (${r.note.join(', ')})\n`);
  for (const p of r.problems) process.stdout.write(`  - ${p}\n`);
}
if (keep) process.stdout.write(`kept ${work}\n`);
else rmSync(work, { recursive: true, force: true });
const bad = results.filter((r) => r.problems.length);
process.stdout.write(`${results.length - bad.length}/${results.length} upgrades passed\n`);
process.exit(bad.length ? 1 : 0);
