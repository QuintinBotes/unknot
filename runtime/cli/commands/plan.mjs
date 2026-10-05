// /unknot:plan "<objective>" --from DEC-xxxx | --findings F-1,F-2 | --proposal file.json
// `unknot plan show <CMP-id>` prints a campaign with its slices.

import { readFileSync } from 'node:fs';
import { UnknotError } from '../../core/errors.mjs';
import { modeRank } from '../../policy/defaults.mjs';
import { createCampaign } from '../../plan/campaign.mjs';
import { humanCommand, output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  if (positional[0] === 'show') {
    const row = ctx.store.get('SELECT body FROM campaigns WHERE id = ?', positional[1]);
    if (!row) throw new UnknotError('UK_NOT_FOUND', `no campaign ${positional[1]}`);
    const c = JSON.parse(row.body);
    const slices = ctx.store.all('SELECT id, state, risk, body FROM slices WHERE campaign_id = ? ORDER BY id', c.id).map((s) => ({ id: s.id, state: s.state, risk: s.risk, objective: JSON.parse(s.body).objective }));
    return output(flags.json ? { campaign: c, slices } : `${c.id}: ${c.objective}\nselected ${c.selected} (alternatives: ${c.alternatives.join(', ')})\n\n${table(slices, ['id', 'state', 'risk', 'objective'])}`, { json: flags.json });
  }
  if (modeRank(config.mode) < modeRank('plan')) throw new UnknotError('UK_POLICY_DENIED', `mode ${config.mode} does not permit writing plans; a human sets mode: plan in .unknot/config.yaml`);
  const objective = positional.join(' ');
  const proposal = flags.proposal ? JSON.parse(readFileSync(flags.proposal, 'utf8')) : null;
  const res = await withRun(ctx, cfg, 'plan', { actor }, () =>
    createCampaign(ctx, { config, actor, objective, decomposition: flags.from ?? null, findings: flags.findings ? String(flags.findings).split(',') : null, proposal, scope: flags.scope ? String(flags.scope).split(',') : [] }),
  );
  if (flags.json) return output(res, { json: true });
  output([
    `Created ${res.campaign.id}: ${res.campaign.objective}`,
    `Selected: ${res.campaign.selected}; alternatives considered: ${res.campaign.alternatives.join(', ')}`,
    '',
    table(res.slices.map((s) => ({ id: s.id, risk: s.risk, approvals: s.approvals.join('+'), obligations: s.proof_obligations.length, objective: s.objective })), ['id', 'risk', 'approvals', 'obligations', 'objective']),
    '',
    'Every slice is AWAITING_APPROVAL. A human approves the exact plan in a separate terminal window:',
    `  ${humanCommand(`approve ${res.slices[0].id} --role <role> --as <approver>`)}`,
    'Then: /unknot:next, /unknot:apply <slice>, /unknot:verify <slice>.',
  ].join('\n'));
}
