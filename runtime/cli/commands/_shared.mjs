// Opening a project and its effective config, the same way for every command.

import { openProject } from '../../context.mjs';
import { loadConfig } from '../../policy/config.mjs';
import { currentActor } from '../util.mjs';

export function open(flags = {}, { create = false } = {}) {
  const ctx = openProject(flags.cwd ?? process.cwd(), { create });
  const cfg = loadConfig(ctx);
  return { ctx, cfg, config: cfg.config, actor: currentActor() };
}

export function sliceRow(ctx, id) {
  const row = ctx.store.get('SELECT * FROM slices WHERE id = ?', id);
  return row ? { ...row, body: JSON.parse(row.body) } : null;
}
