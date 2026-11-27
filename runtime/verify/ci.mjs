// Verifying a slice in CI (#153; docs/forge-approvals.md control 5). `unknot pr` writes the slice's
// CI plan into the commit it pushes (an `Unknot-CI:` line); the reusable workflow
// (.github/workflows/unknot-verify.yml) runs the plan's commands on that commit with no key and no
// Unknot state, writes the results as evidence, and attests them. `unknot verify --from-ci <pr>`
// counts that evidence only after forge.mjs has verified the attestation, and only for command
// obligations whose command is the one this clone would run: human obligations never.

import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { git } from '../apply/git.mjs';
import { currentBinding, loadSlice } from '../apply/apply.mjs';
import { canonicalJSON, digest, randomId, sha256 } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { scopedHookArgv } from '../plan/hooks.mjs';
import { ciEvidence, ciWorkflowPin } from '../policy/forge.mjs';
import { casPut } from '../state/cas.mjs';
import { emitProofBundle } from './bundle.mjs';
import { changedPaths } from './checks.mjs';
import { obligationsOf, recordEvidence } from './verify.mjs';

const TRAILER = 'Unknot-CI: ';
const SCHEMA = 'unknot-ci-evidence-v1';
const MAX_MINUTES = 30;

/** What CI does for each obligation: run its command (scoped as `unknot verify` scopes it), or not, and why. */
export function ciPlan(ctx, slice) {
  const hookPaths = changedPaths(slice.worktree, slice.baseline_commit).filter((c) => c.status !== 'D').map((c) => c.path);
  return obligationsOf(ctx, slice.id).map((o) => {
    const base = { id: o.id, kind: o.kind };
    if (o.requires_human) return { ...base, not_run: 'needs a person' };
    const scoped = o.body.command && o.body.hook ? scopedHookArgv(o.body.hook, hookPaths) : null;
    if (o.body.builtin || (scoped && !hookPaths.length)) return { ...base, not_run: 'built-in check; unknot verify runs it locally' };
    const run = scoped ?? o.body.command;
    return run ? { ...base, run } : { ...base, not_run: 'no command configured' };
  });
}

/** The commit-message line that carries the plan to CI. It decides only what CI runs; nothing local trusts it. */
export const ciTrailer = (ctx, slice) => `${TRAILER}${canonicalJSON({ v: 1, slice: slice.id, diff_hash: slice.diff_hash, obligations: ciPlan(ctx, slice) })}`;

function readTrailer(message) {
  const line = message.split('\n').reverse().find((l) => l.startsWith(TRAILER));
  if (!line) throw new UnknotError('UK_NOT_FOUND', `the head commit has no ${TRAILER.trim()} line; push the slice with unknot pr (approvals.forge.ci_workflow set)`);
  const plan = JSON.parse(line.slice(TRAILER.length));
  const argv = (a) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === 'string' && s.length > 0);
  if (plan?.v !== 1 || typeof plan.slice !== 'string' || typeof plan.diff_hash !== 'string' || !Array.isArray(plan.obligations)
    || !plan.obligations.every((o) => typeof o?.id === 'string' && typeof o.kind === 'string' && (o.run === undefined ? typeof o.not_run === 'string' : argv(o.run)))) {
    throw new UnknotError('UK_SCHEMA_INVALID', `malformed ${TRAILER.trim()} line`);
  }
  return plan;
}

const digestOf = (buf) => `sha256:${sha256(buf ?? Buffer.alloc(0))}`;

/**
 * CI side (`unknot verify --in-ci <out>`): run the head commit's plan in `root` and write the
 * evidence file the workflow attests. No project state, no key. Exit codes come from the commands;
 * the caller exits 1 when one failed, so the run's conclusion carries what the file alone cannot.
 */
export function runInCi({ root, out, env = process.env }) {
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const plan = readTrailer(git(root, ['log', '-1', '--format=%B', head]).stdout);
  const results = [];
  for (const o of plan.obligations) {
    if (!o.run) {
      results.push({ id: o.id, kind: o.kind, not_run: o.not_run });
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync(o.run[0], o.run.slice(1), { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: MAX_MINUTES * 60_000 });
    process.stdout.write(`::group::${o.id} ${o.kind}: ${o.run.join(' ')} -> exit ${r.status}\n`);
    process.stdout.write(r.stdout ?? '');
    process.stdout.write(r.stderr ?? '');
    process.stdout.write('::endgroup::\n');
    results.push({ id: o.id, kind: o.kind, command: o.run, exit_code: r.status, started_at: new Date(t0).toISOString(), duration_ms: Date.now() - t0, stdout_digest: digestOf(r.stdout), stderr_digest: digestOf(r.stderr) });
  }
  const evidence = { schema: SCHEMA, repository: env.GITHUB_REPOSITORY ?? null, head, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT), slice_id: plan.slice, diff_hash: plan.diff_hash, results };
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  const verdict = (r) => (r.not_run ? `not run (${r.not_run})` : r.exit_code === 0 ? 'pass' : `fail (exit ${r.exit_code})`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Unknot ${plan.slice} on ${head.slice(0, 12)}\n\n| obligation | kind | result |\n|---|---|---|\n${results.map((r) => `| ${r.id} | ${r.kind} | ${verdict(r)} |`).join('\n')}\n`);
  return evidence;
}

const sameArgv = (a, b) => Array.isArray(a) && a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * Local side (`unknot verify --from-ci <pr>`): record the attested CI evidence of a REVIEW_READY
 * slice. A passing command obligation is recorded with actor `ci:<workflow>`; a failed one is
 * reported and changes nothing.
 */
export async function importCiEvidence(ctx, { cfg, run, sliceId }) {
  const slice = loadSlice(ctx, sliceId);
  if (slice.state !== 'REVIEW_READY') throw new UnknotError('UK_STATE_CONFLICT', `${slice.id} is ${slice.state}; CI evidence is recorded for a REVIEW_READY slice with a pull request (unknot pr ${slice.id})`, { slice_id: slice.id });
  const current = currentBinding(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash });
  const ci = ciEvidence(ctx, { config: cfg.config, slice, current });
  if (ci.error) throw new UnknotError('UK_INSUFFICIENT_EVIDENCE', `CI evidence not accepted: ${ci.error}`, { slice_id: slice.id });
  const got = new Map(ci.evidence.results.filter((r) => typeof r?.id === 'string').map((r) => [r.id, r]));
  const ref = casPut(ctx, ci.bytes, { mediaType: 'application/json', runId: run.id, label: 'ci-evidence' });
  const actor = `ci:${ciWorkflowPin(cfg.config).signer}`.slice(0, 131);
  const byId = new Map(obligationsOf(ctx, slice.id).map((o) => [o.id, o]));
  const results = [];
  for (const p of ciPlan(ctx, slice)) {
    const r = got.get(p.id);
    if (!p.run) {
      results.push({ id: p.id, kind: p.kind, verdict: 'not_counted', detail: `${p.not_run}; CI evidence cannot pass it` });
      continue;
    }
    if (!r || !sameArgv(r.command, p.run)) {
      results.push({ id: p.id, kind: p.kind, verdict: 'not_counted', detail: `CI ran ${Array.isArray(r?.command) ? r.command.join(' ') : 'nothing'}, not ${p.run.join(' ')}` });
      continue;
    }
    // The slice's code runs in the job that writes the file and can rewrite it, so an exit 0 there
    // counts only when GitHub says the run succeeded: `--in-ci` exits 1 on any failed command.
    const passed = r.exit_code === 0 && ci.conclusion === 'success';
    const verdict = passed ? 'pass' : Number.isInteger(r.exit_code) && r.exit_code !== 0 ? 'fail' : 'inconclusive';
    const why = r.exit_code === 0 && !passed ? `, but the run concluded ${ci.conclusion}, so it does not count` : '';
    results.push({ id: p.id, kind: p.kind, verdict, detail: `${p.run.join(' ')} -> exit ${r.exit_code} in ${ci.run}${why}` });
    if (verdict !== 'pass') continue;
    const record = {
      id: `ci-${randomId(6)}`,
      obligation: p.id,
      command: p.run,
      working_directory: ci.run,
      environment_digest: digest({ ci: ci.workflow, run: ci.run }),
      started_at: typeof r.started_at === 'string' ? r.started_at : null,
      duration_ms: Number.isSafeInteger(r.duration_ms) && r.duration_ms >= 0 ? r.duration_ms : 0,
      exit_code: 0,
      stdout_digest: typeof r.stdout_digest === 'string' ? r.stdout_digest : null,
      stderr_digest: typeof r.stderr_digest === 'string' ? r.stderr_digest : null,
      artifact_refs: [ref],
      verdict: 'pass',
      kind: 'ci',
      diff_hash: slice.diff_hash,
      ci: { pull_request: ci.url, head: ci.head, run: ci.run, workflow: ci.workflow, evidence_digest: ci.digest },
    };
    recordEvidence(ctx, { run, slice, obligation: byId.get(p.id), record, verdict: 'pass', actor });
  }
  const recorded = results.filter((r) => r.verdict === 'pass').length;
  const bundle = recorded ? await emitProofBundle(ctx, { cfg, run, slice: loadSlice(ctx, slice.id), all: obligationsOf(ctx, slice.id) }) : null;
  return { slice: slice.id, head: ci.head, run: ci.run, workflow: ci.workflow, results, recorded, bundle };
}
