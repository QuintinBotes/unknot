// /unknot:architecture [scope] [--out dir] [--json] [--max-nodes N] — C4 and topology views
// (spec §10). Writing documentation needs mode plan or above; in observe mode the pages are
// printed instead, so a sensitive repository gets the analysis without a single file write.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UnknotError } from '../../core/errors.mjs';
import { isSecretPath, resolveInside } from '../../core/paths.mjs';
import { redact } from '../../core/redact.mjs';
import { Graph } from '../../graph/graph.mjs';
import { modeRank } from '../../policy/defaults.mjs';
import { architectureViews, renderStylesPage, renderViewPage } from '../../artifacts/architecture.mjs';
import { output, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

const DEFAULT_OUT = '.unknot/docs/architecture';

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  const res = await withRun(ctx, cfg, 'architecture', { actor, scope: positional }, async () => {
    const graph = Graph.fromStore(ctx.store);
    if (graph.size.nodes === 0) throw new UnknotError('UK_BASELINE_INVALID', 'the graph is empty; run unknot map first');
    const result = architectureViews(graph, { scope: positional, maxNodes: flags.max_nodes ? Number(flags.max_nodes) : 60, container: flags.container ?? null });
    const pages = new Map();
    for (const [name, v] of Object.entries(result.views)) pages.set(`unknot-${name.replace(/_/g, '-')}.md`, renderViewPage(name, v));
    pages.set('styles.md', renderStylesPage(result.styles, result.labels));
    if (result.views.containers.structurizr) pages.set('workspace.dsl', `${result.views.containers.structurizr}\n`);

    const canWrite = modeRank(config.mode) >= modeRank('plan');
    const written = [];
    if (canWrite) {
      const out = resolveInside(ctx.root, typeof flags.out === 'string' ? flags.out : DEFAULT_OUT, { allowRoot: false });
      if (isSecretPath(out.rel)) throw new UnknotError('UK_POLICY_DENIED', `${out.rel} is a credential path; choose another --out`);
      for (const [file, text] of pages) {
        const target = resolveInside(ctx.root, join(out.rel, file));
        mkdirSync(dirname(target.abs), { recursive: true });
        writeFileSync(target.abs, redact(text).text);
        written.push(target.rel);
      }
    }
    return { mode: config.mode, written, wrote: canWrite, ...result, pages };
  });
  if (flags.json) {
    const { pages, ...rest } = res;
    return output({ ...rest, note: res.wrote ? null : `mode ${res.mode} does not permit writing documentation; nothing was written` }, { json: true });
  }
  const lines = [`Styles: ${res.styles.map((s) => `${s.style} (${s.label})`).join(', ')}`];
  if (res.wrote) {
    lines.push('', `Wrote ${res.written.length} file(s):`, ...res.written.map((w) => `  ${w}`));
    return output(lines.join('\n'));
  }
  lines.push('', `Mode ${res.mode} does not permit writing documentation (needs plan or above); printing instead.`, '');
  for (const [file, text] of res.pages) lines.push(`<!-- ${file} -->`, text);
  return output(lines.join('\n'));
}
