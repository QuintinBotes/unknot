// Shared by accept and reject: record a human decision about a finding.

import { UnknotError } from '../../core/errors.mjs';
import { getFinding, recordDecision } from '../../diagnose/engine.mjs';
import { activeRun } from '../../state/runs.mjs';
import { isHuman, output } from '../util.mjs';
import { open } from './_shared.mjs';

export async function decide(decision, { positional, flags }) {
  const { ctx, config, actor } = open(flags);
  const id = positional[0];
  const f = getFinding(ctx, id);
  // A person decides. From a terminal that is the user; from Claude Code it is allowed
  // only inside a run the person started by typing /unknot:<decision> with this id.
  let who = actor;
  if (!isHuman(actor)) {
    const r = activeRun(ctx.store);
    if (!r || r.command !== decision || r.actor !== 'human:prompt' || !(r.scope ?? []).includes(f.id)) {
      throw new UnknotError('UK_POLICY_DENIED', `recording a ${decision} decision needs the person to ask for it: type /unknot:${decision} ${f.id} --rationale "..."`, { details: { policy: 'decision.human_only' } });
    }
    who = 'human:prompt';
  }
  const days = Number(flags.days ?? config.suppression.default_reject_days);
  const rec = recordDecision(ctx, { finding: f, decision, rationale: flags.rationale ?? '', actor: who, days });
  output(flags.json ? rec : `${decision === 'accept' ? 'Accepted' : 'Rejected'} ${f.id} (${rec.id})${rec.suppress_until ? `; suppressed until ${rec.suppress_until.slice(0, 10)}` : ''}. Recorded in .unknot/decisions.jsonl.`, { json: flags.json });
}
