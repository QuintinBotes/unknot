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
