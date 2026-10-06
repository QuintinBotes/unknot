import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { UnknotError } from '../../core/errors.mjs';
import { validateArtifact } from '../../core/schema.mjs';
import { parseYAML, stringifyYAML } from '../../core/yaml.mjs';
import { appendEvent } from '../../state/ledger.mjs';
import { recordAcceptedConfig } from '../../policy/config.mjs';
import { clearSources, diffConfig, readSources, renderDiff, withoutGuidance } from '../../policy/config-diff.mjs';
import { output, prompt, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const sub = positional[0] ?? 'show';
  const { ctx, cfg, actor } = open(flags);
  if (sub === 'show') return output({ effective: cfg.config, digest: cfg.digest, acceptance: cfg.acceptance, notice: cfg.notice, sources: cfg.sources, org: cfg.org, adjustments: cfg.adjustments }, { json: true });
  if (sub === 'diff' || sub === 'accept') {
    // Accept the proposal from `unknot init` if there is one, else the current file (for
    // hand edits and merged changes, which stay inert until someone accepts them here).
    const fromProposal = existsSync(ctx.paths.proposedConfig);
    if (!fromProposal && !existsSync(ctx.paths.config)) throw new UnknotError('UK_NOT_FOUND', 'no .unknot/config.proposed.yaml or config.yaml; run unknot init');
    const proposedText = readFileSync(fromProposal ? ctx.paths.proposedConfig : ctx.paths.config, 'utf8');
    const proposed = parseYAML(proposedText);
    const v = validateArtifact('config', proposed);
    if (!v.valid) throw new UnknotError('UK_CONFIG_INVALID', `proposed config is invalid: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
    const currentExists = existsSync(ctx.paths.config);
    const currentConfig = currentExists ? parseYAML(readFileSync(ctx.paths.config, 'utf8')) ?? {} : {};
    const sources = fromProposal ? readSources(ctx.paths, proposedText) : null;
    if (sub === 'diff') return output(renderDiff(diffConfig(currentConfig, proposed, sources ?? (fromProposal ? null : { entries: {}, omitted: [] })), { currentExists }), { json: false });
    // `--detected-only` leaves out the lines inferred from repository guidance; the rest of the
    // accept path (human terminal, typed mode) is unchanged.
    let text = proposedText;
    let accepting = proposed;
    let dropped = [];
    if (flags.detected_only) {
      if (!sources) throw new UnknotError('UK_CONFIG_INVALID', '--detected-only needs the source record `unknot init` wrote with this proposal; run unknot config diff to see what is known, or accept without the flag');
      ({ proposed: accepting, dropped } = withoutGuidance(currentConfig, proposed, sources));
      if (dropped.length) text = stringifyYAML(accepting);
      const v2 = validateArtifact('config', accepting);
      if (!v2.valid) throw new UnknotError('UK_CONFIG_INVALID', `config without guidance lines is invalid: ${v2.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
    }
    // Accepting config can raise the mode; the spec forbids inferring that from language,
    // so it takes a person at a terminal who types the mode back.
    requireHumanTTY('accepting configuration');
    output(`Proposed mode: ${accepting.mode ?? 'plan'}\n${dropped.length ? `(without ${dropped.length} line(s) inferred from guidance: ${dropped.map((d) => `${d.key} [${d.label}]`).join('; ')})\n` : ''}${text}`);
    const typed = prompt(`Type the mode (${accepting.mode ?? 'plan'}) to accept: `);
    if (typed.trim() !== (accepting.mode ?? 'plan')) throw new UnknotError('UK_POLICY_DENIED', 'confirmation did not match; nothing changed');
    if (fromProposal) {
      if (text === proposedText) renameSync(ctx.paths.proposedConfig, ctx.paths.config);
      else {
        writeFileSync(ctx.paths.config, text);
        rmSync(ctx.paths.proposedConfig);
      }
      clearSources(ctx.paths);
    }
    const accepted = recordAcceptedConfig(ctx, text, actor);
    appendEvent(ctx, { type: 'config.accepted', actor, payload: { mode: accepting.mode ?? 'plan', digest: accepted, ...(flags.detected_only && { detected_only: true, dropped: dropped.map((d) => d.key) }) } });
    return output('accepted .unknot/config.yaml');
  }
  throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot config show|diff|accept [--detected-only]');
}
