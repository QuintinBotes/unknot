import { existsSync, readFileSync, renameSync } from 'node:fs';
import { UnknotError } from '../../core/errors.mjs';
import { validateArtifact } from '../../core/schema.mjs';
import { parseYAML } from '../../core/yaml.mjs';
import { appendEvent } from '../../state/ledger.mjs';
import { output, prompt, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const sub = positional[0] ?? 'show';
  const { ctx, cfg, actor } = open(flags);
  if (sub === 'show') return output({ effective: cfg.config, digest: cfg.digest, sources: cfg.sources, org: cfg.org, adjustments: cfg.adjustments }, { json: true });
  if (sub === 'diff' || sub === 'accept') {
    if (!existsSync(ctx.paths.proposedConfig)) throw new UnknotError('UK_NOT_FOUND', 'no .unknot/config.proposed.yaml; run unknot init');
    const proposedText = readFileSync(ctx.paths.proposedConfig, 'utf8');
    const proposed = parseYAML(proposedText);
    const v = validateArtifact('config', proposed);
    if (!v.valid) throw new UnknotError('UK_CONFIG_INVALID', `proposed config is invalid: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
    const current = existsSync(ctx.paths.config) ? readFileSync(ctx.paths.config, 'utf8') : '(no config: built-in defaults)';
    if (sub === 'diff') return output(`--- current\n${current}\n+++ proposed\n${proposedText}`);
    // Accepting config can raise the mode; the spec forbids inferring that from language,
    // so it takes a person at a terminal who types the mode back.
    requireHumanTTY('accepting configuration');
    output(`Proposed mode: ${proposed.mode ?? 'plan'}\n${proposedText}`);
    const typed = prompt(`Type the mode (${proposed.mode ?? 'plan'}) to accept: `);
    if (typed.trim() !== (proposed.mode ?? 'plan')) throw new UnknotError('UK_POLICY_DENIED', 'confirmation did not match; nothing changed');
    renameSync(ctx.paths.proposedConfig, ctx.paths.config);
    appendEvent(ctx, { type: 'config.accepted', actor, payload: { mode: proposed.mode ?? 'plan' } });
    return output('accepted .unknot/config.yaml');
  }
  throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot config show|diff|accept');
}
