// Spellings that tried to get an approving pull request review past approval.human_only
// (docs/forge-approvals.md, control 1). Each refused command posted an approval before the fix.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alwaysOn, toOperation } from '../../runtime/policy/pdp.mjs';

const ctx = { root: process.cwd() };
const refused = (tool, input) => Boolean(alwaysOn(ctx, { ...toOperation(tool, input, process.cwd()), cwd: process.cwd() }, {})?.policy_ids?.includes('approval.human_only'));
const bash = (command) => refused('Bash', { command });

test('gh approvals hidden by quoting, combined flags, computed words or unread bodies are refused', () => {
  for (const command of [
    'gh pr "review" 12 -a',
    'g""h pr review 12 --approve',
    "gh pr rev'iew' 12 -a",
    'gh pr review 12 -ab lgtm',
    'gh pr review 12 -ca',
    'gh pr review 12 $FLAG',
    'gh pr review 12 "$(printf -- -a)"',
    'gh api graphql --input body.json',
    'gh api graphql -F query=@approve.graphql',
    'gh api repos/o/r/pulls/3/reviews -F event=@event.txt',
    'gh api repos/o/r/pulls/3/reviews -f event=$EVENT',
    'gh api "$ENDPOINT" -f event=APPROVE',
    'gh alias import aliases.yml',
    'gh alias set lgtm "pr re""view -a"',
    'gh pr review 12 -a=true',
    'gh -R o/r pr review 12 --approve',
    'gh --repo o/r pr review 12 --approve',
    'gh pr -R o/r review 12 --approve',
    'gh $(echo pr) review 12 --approve',
    'gh pr $(echo review) 12 --approve',
    'echo --approve | xargs gh pr review 12',
    "git -c alias.ok='!gh pr review 12 --approve' ok",
    "git rebase --exec 'gh pr review 12 --approve' HEAD",
    'gh api repos/o/r/pulls/3/$(echo reviews) -f event=APPROVE',
    'gh api graphql -f query="$(cat q.graphql)"',
  ]) assert.equal(bash(command), true, command);
});

test('gh reads, comments and other writes stay allowed', () => {
  for (const command of [
    'gh pr review 12 --comment -b "$MSG"',
    'gh pr review 12 -r -b "missing test"',
    'gh pr view 12 --json reviews',
    'gh api repos/o/r/pulls/3/reviews',
    'gh api repos/o/r/issues -X POST --input issue.json',
    'gh api repos/o/r/issues/16/sub_issues -X POST -F sub_issue_id=$ID',
    "gh api graphql -f query='{ viewer { login } }'",
    'gh alias list',
    'gh pr view $N --json reviews',
    'echo 12 | xargs gh pr view',
    "git rebase -x 'npm test' main",
  ]) assert.equal(bash(command), false, command);
});

test('a forge tool with the approving event deeper in its arguments is refused', () => {
  assert.equal(refused('mcp__forge__create_pull_request_review', { input: { event: 'APPROVE' } }), true);
  assert.equal(refused('mcp__forge__create_pull_request_review', { input: { event: 'COMMENT', body: 'I approve of the tests' } }), false);
  assert.equal(refused('mcp__forge__createPullRequestReview', { event: 'APPROVE' }), true, 'camelCase');
  assert.equal(refused('mcp__forge__create-pull-request-review', { event: 'APPROVE' }), true, 'kebab-case');
  assert.equal(refused('mcp__forge__create_pull_request_review', { state: 'APPROVED' }), true, 'a state, as Gitea spells it');
});
