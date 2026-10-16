// The human-only rule refuses commands that would run a human-only unknot subcommand, judged on
// what runs (issue #40): a heredoc body or a quoted argument that mentions one is data.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alwaysOn } from '../../../runtime/policy/pdp.mjs';

const ctx = { root: process.cwd() };
const humanOnly = (command) => Boolean(alwaysOn(ctx, { op: 'exec', command, cwd: process.cwd() }, {})?.policy_ids?.includes('approval.human_only'));

test('text that only mentions a human-only command is data', () => {
  for (const command of [
    "cat > x.md <<'EOF'\nRun `unknot approve UK-1` and `unknot config accept` in your terminal.\nEOF",
    'gh issue create --title t --body "run unknot config accept in your terminal"',
    'echo "unknot run end x"',
    'git commit -m "docs: say unknot approve is for people"',
    'unknot status',
  ]) assert.equal(humanOnly(command), false, command);
});

test('a human-only command that would run is refused, however it is wrapped', () => {
  for (const command of [
    'unknot approve UK-1 --role r --as n',
    'git status && unknot approve UK-1',
    'true; unknot config accept',
    'bash -c "unknot config accept"',
    'eval "unknot run end x"',
    "bash <<'EOF'\nunknot approve UK-1\nEOF",
    'echo "unknot approve UK-1" | bash',
    'npx unknot approve UK-1',
    'env X=1 unknot keys gen',
    'git -c alias.x="!unknot approve UK-1" x',
    'sh -c "$(echo unknot approve)"',
    'xargs -I{} unknot approve {} <<< UK-1',
  ]) assert.equal(humanOnly(command), true, command);
});

// Forge approvals (docs/forge-approvals.md, control 1): no agent approves a pull request.
const denied = (op) => Boolean(alwaysOn(ctx, op, {})?.policy_ids?.includes('approval.human_only'));
const shell = (command) => denied({ op: 'exec', command, cwd: process.cwd() });
const tool = (name, input) => denied({ op: 'mcp', tool: `mcp__forge__${name}`, server: 'forge', name, input });

test('approving a pull request through gh is refused, in any spelling', () => {
  for (const command of [
    'gh pr review 12 --approve',
    'gh pr review --approve -b "looks good"',
    'gh pr review 12 -a',
    'gh pr review 12 --approve=true',
    'bash -c "gh pr review 3 --approve"',
    'echo "gh pr review 1 --approve" | sh',
    'gh api repos/o/r/pulls/3/reviews -f event=APPROVE',
    'gh api -X POST repos/o/r/pulls/3/reviews --input body.json',
    "gh api graphql -f query='mutation { submitPullRequestReview(input: { pullRequestReviewId: \"x\", event: APPROVE }) { clientMutationId } }'",
    'gh alias set ok "pr review --approve"',
  ]) assert.equal(shell(command), true, command);
});

test('reading reviews, commenting, and text that only mentions an approval are not refused', () => {
  for (const command of [
    'gh pr view 12',
    'gh pr review 12 --comment -b "please add a test"',
    'gh pr review 12 --request-changes -b "the test is missing"',
    'gh api repos/o/r/pulls/3/reviews',
    'echo "run gh pr review --approve when you are happy"',
    'git commit -m "docs: a person approves with gh pr review --approve"',
  ]) assert.equal(shell(command), false, command);
});

test('forge tools that create or submit an approving review, or approve, are refused', () => {
  assert.equal(tool('create_pull_request_review', { event: 'APPROVE' }), true);
  assert.equal(tool('submit_pending_pull_request_review', { event: 'APPROVE' }), true);
  assert.equal(tool('submit_pending_pull_request_review', {}), true, 'an unknown event on submit counts as an approval');
  assert.equal(tool('approve_merge_request', { id: 4 }), true);
  assert.equal(tool('create_pull_request_review', { event: 'COMMENT' }), false);
  assert.equal(tool('get_pull_request_reviews', {}), false);
  // One tool that creates and submits by a method argument.
  assert.equal(tool('pull_request_review_write', { method: 'create', event: 'APPROVE' }), true);
  assert.equal(tool('pull_request_review_write', { method: 'submit_pending', event: 'APPROVE' }), true);
  assert.equal(tool('pull_request_review_write', { method: 'submit_pending' }), true, 'an unknown event on submit counts as an approval');
  assert.equal(tool('pull_request_review_write', { method: 'create', event: 'COMMENT' }), false);
  assert.equal(tool('pull_request_review_write', { method: 'delete_pending' }), false);
});
