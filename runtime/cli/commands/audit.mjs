import { writeFileSync } from 'node:fs';
import { canonicalJSON } from '../../core/canonical.mjs';
import { readEvents, verifyLedger } from '../../state/ledger.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const sub = positional[0] ?? 'verify';
  const { ctx } = open(flags);
  const pub = ctx.store.meta('audit_public_key');
  if (sub === 'verify') {
    const r = verifyLedger(ctx.store, pub);
    output(flags.json ? r : r.ok ? `ledger intact: ${r.count} events, head ${r.head}` : `LEDGER BROKEN at event ${r.broken_at}: ${r.reason}`, { json: flags.json });
    return r.ok ? 0 : 4;
  }
  if (sub === 'export') {
    // NDJSON with the public key first, so an auditor can verify signatures offline.
    const events = readEvents(ctx.store, { afterSeq: Number(flags.after ?? 0), limit: Number(flags.limit ?? 1_000_000) });
    const lines = [canonicalJSON({ type: 'unknot.audit.header', public_key: pub, project_id: ctx.projectId, exported_at: new Date().toISOString(), count: events.length }), ...events.map(canonicalJSON)];
    if (flags.out) writeFileSync(flags.out, `${lines.join('\n')}\n`, { mode: 0o600 });
    else process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  output('usage: unknot audit verify|export [--out file] [--after seq]');
  return 2;
}
