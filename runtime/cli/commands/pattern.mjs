// `unknot pattern list|show <id>|fit <id> --signals '{...}'` — progressive disclosure.

import { card, evaluate, index, loadCatalog } from '../../patterns/engine.mjs';
import { output, table } from '../util.mjs';

export async function run({ positional, flags }) {
  const [sub = 'list', id] = positional;
  if (sub === 'list') {
    const rows = index({ category: flags.category, treatment: flags.treatment });
    return output(flags.json ? rows : `${table(rows, ['id', 'category', 'problem'])}\n\n${rows.length} cards; ${loadCatalog().invalid.length} invalid.`, { json: flags.json });
  }
  if (sub === 'show') return output(card(id), { json: true });
  if (sub === 'fit') return output(evaluate(card(id), JSON.parse(flags.signals ?? '{}')), { json: true });
  output('usage: unknot pattern list [--category c]|show <id>|fit <id> --signals JSON');
  return 2;
}
