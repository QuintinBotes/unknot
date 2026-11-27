// /unknot:verify <slice> — execute proof obligations and decide the next state.
// --from-ci <pr> records a slice's attested CI evidence; --in-ci <file> is the CI side (#153).

import { UnknotError } from '../../core/errors.mjs';
import { githubRepo } from '../../policy/forge.mjs';
import { importCiEvidence, runInCi } from '../../verify/ci.mjs';
import { verifySlice } from '../../verify/verify.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export const USAGE = 'usage: unknot verify <slice> | --from-ci <pull request url or number> | --in-ci <evidence file> (CI only)';

/** The slice whose latest recorded pull request is `pr` (a URL, or a number in that pull request's repository). */
function sliceOfPull(ctx, pr) {
  const number = /^\d{1,9}$/.test(pr) ? Number(pr) : null;
  const row = ctx.store.all("SELECT slice_id, payload FROM events WHERE type = 'pr.opened' ORDER BY seq DESC")
    .find((r) => { const url = JSON.parse(r.payload).url; return url === pr || (number && githubRepo(url)?.number === number); });
  if (!row) throw new UnknotError('UK_NOT_FOUND', `no slice has pull request ${pr} (unknot pr <slice> records it)`);
  return row.slice_id;
}

export async function run({ positional, flags }) {
  if (typeof flags.in_ci === 'string') {
    // It runs the head commit's commands without the broker's sandbox: only in GitHub Actions, never in an agent session.
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
      throw new UnknotError('UK_POLICY_DENIED', '--in-ci runs the head commit\'s commands without the sandbox; it runs only in the GitHub Actions evidence workflow');
    }
    const ev = runInCi({ root: process.cwd(), out: flags.in_ci });
    output(`Wrote CI evidence for ${ev.slice_id} on ${ev.head} to ${flags.in_ci}.`);
    return ev.results.some((r) => !r.not_run && r.exit_code !== 0) ? 1 : 0;
  }
  if (flags.from_ci !== undefined) {
    if (typeof flags.from_ci !== 'string') throw new UnknotError('UK_CONFIG_INVALID', USAGE);
    const { ctx, cfg, actor } = open(flags);
    const sliceId = sliceOfPull(ctx, flags.from_ci);
    const res = await withRun(ctx, cfg, 'verify', { actor, slice_id: sliceId }, (r) => importCiEvidence(ctx, { cfg, run: r, sliceId }));
    if (flags.json) return output(res, { json: true });
    output([
      `${sliceId}: CI evidence from ${res.run} (${res.workflow}) on head ${res.head}, attestation verified.`,
      '',
      table(res.results.map((x) => ({ id: x.id, kind: x.kind, verdict: x.verdict, detail: x.detail })), ['id', 'kind', 'verdict', 'detail']),
      '',
      res.recorded ? `Recorded ${res.recorded} obligation(s) as passed by CI evidence. Proof bundle: ${res.bundle}.` : 'Nothing recorded.',
    ].join('\n'));
    return res.results.some((x) => x.verdict === 'fail' || x.verdict === 'inconclusive') ? 1 : 0;
  }
  const sliceId = positional[0];
  if (!sliceId) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot verify <slice>');
  const { ctx, cfg, actor } = open(flags);
  const res = await withRun(ctx, cfg, 'verify', { actor, slice_id: sliceId }, (r) => verifySlice(ctx, { cfg, run: r, sliceId, actor }));
  if (flags.json) return output(res, { json: true });
  const lines = [`${sliceId} → ${res.state}`, '', table(res.results.map((x) => ({ id: x.id, kind: x.kind, verdict: x.verdict, detail: x.detail })), ['id', 'kind', 'verdict', 'detail'])];
  for (const r of res.results.filter((x) => x.stderr)) lines.push('', `--- ${r.id} stderr (tail) ---`, r.stderr);
  if (res.waiting_for_human.length) lines.push('', `Waiting for human attestation: ${res.waiting_for_human.map((o) => `${o.id} (${o.kind})`).join(', ')} — a person runs: unknot attest <PO-id> --result pass|fail --note "..." --as <approver>`);
  if (res.notes.length) lines.push('', `Notes: ${res.notes.join('; ')}`);
  if (res.bundle) lines.push('', `Proof bundle: ${res.bundle}. Review it, then a human approves the change: unknot approve ${sliceId} --role <role> --as <approver>`);
  output(lines.join('\n'));
  return res.state === 'REVIEW_READY' ? 0 : 1;
}
