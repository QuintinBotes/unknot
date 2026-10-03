// `unknot backup`: encrypted snapshots of a project's Unknot state for disaster recovery.
// The passphrase comes from the terminal, or from a 0600 file for scheduled jobs; never
// from the environment or argv, both of which other processes can read.

import { UnknotError } from '../../core/errors.mjs';
import { createBackup, readPassphraseFile, restoreBackup, verifyBackup } from '../../enterprise/backup.mjs';
import { output, prompt } from '../util.mjs';
import { open } from './_shared.mjs';

const USAGE = 'usage: unknot backup create <file> [--passphrase-file f] | verify <file> [--passphrase-file f] | restore <file> --to <empty-dir> [--passphrase-file f]';

function passphrase(flags, { confirm = false } = {}) {
  if (typeof flags.passphrase_file === 'string') return readPassphraseFile(flags.passphrase_file);
  if (flags.passphrase_file) throw new UnknotError('UK_CONFIG_INVALID', '--passphrase-file needs a path');
  const p1 = prompt('Backup passphrase: ', { secret: true });
  if (confirm && prompt('Repeat passphrase: ', { secret: true }) !== p1) throw new UnknotError('UK_CONFIG_INVALID', 'passphrases differ');
  return p1;
}

export async function run({ positional, flags }) {
  const [sub, file] = positional;
  if (!file || !['create', 'verify', 'restore'].includes(sub)) {
    output(USAGE);
    return 2;
  }
  if (sub === 'create') {
    const { ctx } = open(flags);
    const r = createBackup(ctx, file, passphrase(flags, { confirm: true }));
    return output(flags.json ? r : `Backup written to ${r.file}: ${r.files} files, ${r.bytes} bytes, ledger ${r.ledger.count} events.\nThe project key directory is NOT in the backup; escrow it separately (see docs/operations.md).`, { json: flags.json });
  }
  if (sub === 'verify') {
    const r = verifyBackup(file, passphrase(flags));
    output(flags.json ? r : r.ok ? `Backup verifies: ${r.files} files, ledger ${r.ledger.count} events (head ${r.ledger.head}).` : `BACKUP INVALID: ${r.reason}`, { json: flags.json });
    return r.ok ? 0 : 4;
  }
  if (typeof flags.to !== 'string') throw new UnknotError('UK_CONFIG_INVALID', USAGE);
  const r = restoreBackup(file, passphrase(flags), flags.to);
  const warn = r.keys_present ? '' : `\nWARNING: no keys for ${r.project_id} on this machine (${r.key_dir}). The restored artifact cache is unreadable until the project key directory is restored there.`;
  return output(flags.json ? r : `Restored ${r.files} files into ${r.root}/.unknot; ledger verifies (${r.ledger.count} events).${warn}`, { json: flags.json });
}
