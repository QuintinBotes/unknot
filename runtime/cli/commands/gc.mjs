// `unknot gc`: apply retention; `--shred` crypto-shreds the project (human only).

import { UnknotError } from '../../core/errors.mjs';
import { collectGarbage, shredProject } from '../../enterprise/retention.mjs';
import { output, prompt, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ flags }) {
  const { ctx, config, actor } = open(flags);
  if (flags.shred) {
    requireHumanTTY('crypto-shredding a project');
    if (flags.dry_run) throw new UnknotError('UK_CONFIG_INVALID', '--shred cannot be combined with --dry-run');
    const typed = prompt(`This permanently destroys the keys for ${ctx.projectId}; its cached artifacts become unrecoverable.\nType the project id to continue: `);
    const r = shredProject(ctx, { confirm: typed, actor });
    return output(flags.json ? r : `Project ${r.project_id} shredded. Encrypted artifacts can no longer be read.`, { json: flags.json });
  }
  const r = collectGarbage(ctx, config, { dryRun: Boolean(flags.dry_run), actor });
  if (flags.json) return output(r, { json: true });
  return output(`${r.dry_run ? 'Would delete' : 'Deleted'} ${r.runs.deleted.length} run directories and ${r.blobs.deleted} artifacts (${r.blobs.bytes} bytes); kept ${r.runs.kept_for_open_slices.length + r.blobs.kept_for_open_slices} items for unfinished slices.`);
}
