import { writeFileSync } from 'node:fs';
import { canonicalJSON } from '../../core/canonical.mjs';
import { ledgerCheckpoint, readCheckpoint, readEvents, verifyAgainstAnchor, verifyLedger } from '../../state/ledger.mjs';
import { auditPublicKeyPem } from '../../core/keys.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const sub = positional[0] ?? 'verify';
  const { ctx } = open(flags);
  if (sub === 'verify' && flags.anchor !== undefined) {
    if (typeof flags.anchor !== 'string') throw new UnknotError('UK_CONFIG_INVALID', '--anchor needs a path');
    // An exported checkpoint is the trust root: neither the database nor UNKNOT_HOME is consulted for the key.
    const r = verifyAgainstAnchor(ctx.store, readCheckpoint(flags.anchor));
    output(flags.json ? r : r.ok ? `ledger intact and extends the anchor: ${r.count} events, head ${r.head} (anchor at event ${r.anchored.count})` : `LEDGER FAILS THE ANCHOR (${r.reason}): ${r.detail}`, { json: flags.json });
    return r.ok ? 0 : 4;
  }
  // The trust anchor is the key in the user's Unknot home, not the copy in the database
  // being verified: a forger with write access to the database could replace both.
  const dbKey = ctx.store.meta('audit_public_key');
  let pub = dbKey;
  let anchor = 'database copy (no key in UNKNOT_HOME)';
  try {
    pub = auditPublicKeyPem(ctx.projectId);
    anchor = 'UNKNOT_HOME key';
  } catch {
    // Key directory missing (e.g. a restored backup on another machine): say so below.
  }
  if (sub === 'verify') {
    if (dbKey && pub !== dbKey) {
      output(flags.json ? { ok: false, reason: 'audit public key in the database differs from the key in UNKNOT_HOME' } : 'LEDGER UNTRUSTED: the audit public key stored in the database differs from the key in UNKNOT_HOME', { json: flags.json });
      return 4;
    }
    if (!pub) anchor = 'none: no audit public key anywhere, so only the hash chain was checked (signatures unverified)';
    const r = { ...verifyLedger(ctx.store, pub), anchor };
    output(flags.json ? r : r.ok ? `ledger intact: ${r.count} events, head ${r.head} (verified against the ${anchor})` : `LEDGER BROKEN at event ${r.broken_at}: ${r.reason}`, { json: flags.json });
    return r.ok ? 0 : 4;
  }
  if (sub === 'checkpoint') {
    // Head, count and key of the verified ledger; useful only if stored where the agent cannot write.
    const text = `${JSON.stringify(ledgerCheckpoint(ctx.store, pub), null, 2)}\n`;
    if (typeof flags.out === 'string') writeFileSync(flags.out, text, { flag: 'wx', mode: 0o600 });
    else process.stdout.write(text);
    return 0;
  }
  if (sub === 'export') {
    // NDJSON with the public key first, so an auditor can verify signatures offline.
    const events = readEvents(ctx.store, { afterSeq: Number(flags.after ?? 0), limit: Number(flags.limit ?? 1_000_000) });
    const lines = [canonicalJSON({ type: 'unknot.audit.header', public_key: pub, project_id: ctx.projectId, exported_at: new Date().toISOString(), count: events.length }), ...events.map(canonicalJSON)];
    if (flags.out) writeFileSync(flags.out, `${lines.join('\n')}\n`, { mode: 0o600 });
    else process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  output('usage: unknot audit verify [--anchor checkpoint.json] | checkpoint [--out file] | export [--out file] [--after seq]');
  return 2;
}
