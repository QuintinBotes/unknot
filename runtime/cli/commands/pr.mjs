// `unknot pr <slice>` (#151): push the slice's verified change and open a draft pull request
// whose body is rendered from the proof bundle. Human only, like approve. Unknot never merges,
// marks ready, approves or force-pushes: gh is only called with `pr create --draft` or `pr edit`,
// and with forge approvals (#152) to post the binding comment.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentBinding, loadSlice } from '../../apply/apply.mjs';
import { git } from '../../apply/git.mjs';
import { stagePatch } from '../../apply/worktree.mjs';
import { which } from '../../broker/broker.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { forgeVia, ghBinary, githubRepo, inPinnedRepo, postBinding, requirePinnedRepo } from '../../policy/forge.mjs';
import { appendEvent } from '../../state/ledger.mjs';
import { renderPullRequestBody } from '../../verify/bundle.mjs';
import { ciTrailer } from '../../verify/ci.mjs';
import { currentActor, output, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';

export const USAGE = 'usage: unknot pr <slice>  (human, in your own terminal) push a verified slice and open a draft pull request';

const VERIFIED = new Set(['REVIEW_READY', 'ACCEPTED']);

// Pushing is the person's `git push`: their remote, credentials and ssh. The repository's hooks
// and fsmonitor do not run, and only the https, ssh and file transports are allowed (no `ext::`).
const PUSH_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.file.allow=always'];

export async function run({ positional, flags }) {
  requireHumanTTY('opening a pull request');
  const sliceId = positional[0];
  if (!sliceId) throw new UnknotError('UK_CONFIG_INVALID', USAGE);
  const { ctx, cfg } = open(flags);
  const slice = loadSlice(ctx, sliceId);
  const ref = `refs/unknot/pr/${slice.id}`;
  const pushed = git(ctx.root, ['rev-parse', '--verify', '--quiet', ref], { check: false }).stdout.trim() || null;
  const opened = ctx.store.get("SELECT payload FROM events WHERE type = 'pr.opened' AND slice_id = ? ORDER BY seq DESC LIMIT 1", slice.id);
  if (!opened && !VERIFIED.has(slice.state)) throw new UnknotError('UK_STATE_CONFLICT', `${slice.id} is ${slice.state}; a pull request is opened for a verified slice (run unknot verify ${slice.id})`, { slice_id: slice.id });
  const stored = ctx.store.get("SELECT payload FROM events WHERE type = 'artifact.stored' AND slice_id = ? ORDER BY seq DESC LIMIT 1", slice.id);
  if (!stored) throw new UnknotError('UK_NOT_FOUND', `${slice.id} has no proof bundle; run unknot verify ${slice.id}`, { slice_id: slice.id });
  const bundle = JSON.parse(stored.payload).bundle;
  const dir = join(ctx.root, bundle);

  // What is pushed is the worktree's staged change, the same tree the diff hash binds.
  const { diff_hash: current } = stagePatch(slice.worktree, slice.baseline_commit);
  const verified = JSON.parse(readFileSync(join(dir, 'verification.json'), 'utf8')).diff_hash;
  const stale = current !== verified || !VERIFIED.has(slice.state) ? current : null;
  const body = renderPullRequestBody(dir, { stale });
  const file = join(dir, 'pr.md');
  writeFileSync(file, body);

  const tree = git(slice.worktree, ['write-tree']).stdout.trim();
  const parent = pushed ?? slice.baseline_commit;
  const title = `${slice.id}: ${slice.body.objective}`;
  // With an evidence workflow pinned, the commit carries the plan CI runs (#153).
  const ci = cfg.config.approvals?.forge?.ci_workflow !== undefined;
  const commit = git(ctx.root, ['rev-parse', `${parent}^{tree}`]).stdout.trim() === tree
    ? parent
    : git(ctx.root, ['-c', 'user.name=unknot', '-c', 'user.email=unknot@localhost', 'commit-tree', tree, '-p', parent, '-m', `${title}\n\nProof bundle: ${bundle}\nDiff: ${current}${ci ? `\n${ciTrailer(ctx, slice)}` : ''}`]).stdout.trim();

  const remotes = git(ctx.root, ['remote']).stdout.split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  // Forge approvals pin the repository and the gh binary: a shim on PATH or a remote pointed elsewhere
  // must not decide which pull request (and whose CODEOWNERS) the reviews are read from.
  const forge = forgeVia(cfg.config) !== 'local';
  const pin = forge ? requirePinnedRepo(cfg.config) : null;
  if (forge) {
    const at = remote ? githubRepo(git(ctx.root, ['remote', 'get-url', remote]).stdout) : null;
    if (remote && (!at || `${at.owner}/${at.repo}`.toLowerCase() !== pin.slug)) throw new UnknotError('UK_POLICY_DENIED', `remote ${remote} is not ${pin.slug} (approvals.forge.repository); nothing pushed`, { slice_id: slice.id });
    if (opened && !inPinnedRepo(cfg.config, JSON.parse(opened.payload).url)) throw new UnknotError('UK_POLICY_DENIED', `the recorded pull request ${JSON.parse(opened.payload).url} is not in ${pin.slug}; nothing pushed`, { slice_id: slice.id });
  }
  const gh = forge ? ghBinary(cfg.config) : which('gh');
  const refspec = `${commit}:refs/heads/${slice.branch}`;
  if (!remote || !gh) {
    output([
      `${remote ? 'gh is not on PATH' : 'This repository has no git remote'}; nothing was pushed. The pull request body is in ${bundle}/pr.md.`,
      'To open the draft pull request by hand:',
      `  git push ${remote ?? '<remote>'} ${refspec}`,
      opened ? `  gh pr edit ${slice.branch} --body-file ${bundle}/pr.md` : `  gh pr create --draft --head ${slice.branch} --title ${JSON.stringify(title)} --body-file ${bundle}/pr.md`,
    ].join('\n'));
    return 0;
  }

  if (commit !== pushed) {
    // No `+` and no --force: a remote branch that moved makes the push fail rather than lose work.
    const r = spawnSync('git', [...PUSH_GIT, 'push', remote, refspec], { cwd: ctx.root, encoding: 'utf8', shell: false });
    if (r.status !== 0) throw new UnknotError('UK_TOOL_FAILED', `git push ${remote} ${refspec} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}`, { slice_id: slice.id });
    git(ctx.root, ['update-ref', ref, commit]);
  }
  const args = opened
    ? ['pr', 'edit', slice.branch, '--body-file', file]
    : ['pr', 'create', '--draft', '--head', slice.branch, '--title', title, '--body-file', file];
  if (pin) args.push('--repo', `${pin.owner}/${pin.repo}`);
  const r = spawnSync(gh, args, { cwd: ctx.root, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new UnknotError('UK_TOOL_FAILED', `gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}. The body is in ${bundle}/pr.md`, { slice_id: slice.id });
  const url = opened ? JSON.parse(opened.payload).url : r.stdout.trim().split('\n').pop();
  if (forge && !inPinnedRepo(cfg.config, url)) throw new UnknotError('UK_POLICY_DENIED', `gh reported ${url}, which is not a pull request in ${pin.slug} (approvals.forge.repository); nothing recorded`, { slice_id: slice.id });
  appendEvent(ctx, { type: opened ? 'pr.updated' : 'pr.opened', slice_id: slice.id, actor: currentActor(), payload: { url, remote, branch: slice.branch, commit, bundle, stale: Boolean(stale) } });
  // Forge approvals: the change a review approves is the binding posted with it.
  const bound = forge && !stale && slice.state === 'REVIEW_READY';
  if (bound) postBinding(ctx, { config: cfg.config, slice, url, head: commit, binding: currentBinding(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash }), actor: currentActor() });
  output([
    `${opened ? 'Updated' : 'Opened draft'} pull request ${url} for ${slice.id} (${commit === pushed ? 'no new commit' : `pushed ${commit.slice(0, 12)} to ${remote}/${slice.branch}`}).`,
    ...(stale ? [`The body says the verification is stale: run unknot verify ${slice.id}, then unknot pr ${slice.id} again.`] : []),
    ...(bound ? [`Posted the approval binding; an approving review on this head by a reviewer with the role counts (unknot approvals ${slice.id}).`] : []),
    'Unknot does not merge or mark it ready; that is the reviewers\' call.',
  ].join('\n'));
  return 0;
}
