// A fake `gh` for forge tests, never the real API. `installFakeGh(dir)` writes a `gh` (tests point the
// accepted `approvals.forge.gh` at `.bin`; it is also put on PATH for `gh pr create`) that
// answers `gh api` from a routes file (`"<METHOD> <path>": response`; `{ seq: [a, b] }` answers a,
// then b) and logs every argv. A call without `--hostname github.com` is refused, so a request that
// could carry credentials anywhere else fails the test. `run download` and `attestation verify`
// answer from `DOWNLOAD <run> <name>` and `ATTEST sha256:<file digest>` routes, and refuse any host
// but github.com.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STUB = `
const fs = require('node:fs');
const dir = process.env.FAKE_GH_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(dir + '/gh.log', JSON.stringify(argv) + '\\n');
if (argv[0] === 'pr') { if (argv[1] === 'create') process.stdout.write(process.env.FAKE_GH_PR_URL + '\\n'); process.exit(0); }
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const route = (key) => JSON.parse(fs.readFileSync(dir + '/routes.json', 'utf8'))[key];
if (argv[0] === 'run' && argv[1] === 'download') {
  if (!String(flag('--repo')).startsWith('github.com/')) { process.stderr.write('fake gh: refused repo ' + flag('--repo')); process.exit(3); }
  const body = route('DOWNLOAD ' + argv[2] + ' ' + flag('--name'));
  if (body === undefined) { process.stderr.write('no artifact matches any of the names or patterns provided'); process.exit(1); }
  fs.writeFileSync(flag('--dir') + '/unknot-evidence.json', body);
  process.exit(0);
}
if (argv[0] === 'attestation' && argv[1] === 'verify') {
  if (flag('--hostname') !== 'github.com') { process.stderr.write('fake gh: refused host ' + flag('--hostname')); process.exit(3); }
  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(argv[2])).digest('hex');
  const r = route('ATTEST sha256:' + digest);
  // As the real gh does for a forged, unsigned or missing bundle: nothing verifies.
  if (r === undefined) { process.stderr.write('Error: no attestations found with predicate type: https://slsa.dev/provenance/v1'); process.exit(1); }
  process.stdout.write(JSON.stringify(r));
  process.exit(0);
}
if (argv[0] !== 'api') { process.stderr.write('fake gh: unsupported'); process.exit(2); }
let host = null, method = 'GET', path = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--hostname') host = argv[++i];
  else if (a === '--method' || a === '-X') method = argv[++i];
  else if (a === '-H' || a === '-f' || a === '-F') i++;
  else if (!path) path = a;
}
if (host !== 'github.com') { process.stderr.write('fake gh: refused host ' + host); process.exit(3); }
const routes = JSON.parse(fs.readFileSync(dir + '/routes.json', 'utf8'));
const key = method + ' ' + path;
let r = routes[key];
if (r && Array.isArray(r.seq)) {
  const seqFile = dir + '/seq.json';
  const seq = fs.existsSync(seqFile) ? JSON.parse(fs.readFileSync(seqFile, 'utf8')) : {};
  const n = seq[key] ?? 0;
  seq[key] = n + 1;
  fs.writeFileSync(seqFile, JSON.stringify(seq));
  r = r.seq[Math.min(n, r.seq.length - 1)];
}
if (r === undefined) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
process.stdout.write(JSON.stringify(r));
`;

export function installFakeGh(dir, { prUrl = 'https://github.com/acme/demo/pull/7' } = {}) {
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\n${STUB}`);
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'routes.json'), '{}');
  process.env.FAKE_GH_DIR = dir;
  process.env.FAKE_GH_PR_URL = prUrl;
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return {
    bin: join(dir, 'gh'),
    routes(map) {
      writeFileSync(join(dir, 'routes.json'), JSON.stringify(map));
      writeFileSync(join(dir, 'seq.json'), '{}');
    },
    calls: () => (existsSync(join(dir, 'gh.log')) ? readFileSync(join(dir, 'gh.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

const API = JSON.parse(readFileSync(new URL('../fixtures/github/api.json', import.meta.url), 'utf8'));
const ATTESTED = JSON.parse(readFileSync(new URL('../fixtures/github/attestation-verify.json', import.meta.url), 'utf8')).verify[0];

/** A GitHub API response from tests/fixtures/github/api.json, with top-level fields overridden. */
export const fixture = (name, over = {}) => ({ ...structuredClone(API[name]), ...over });

/** A recorded `gh attestation verify --format json` entry with certificate fields and subjects replaced. */
export function attested(cert, subjects) {
  const e = structuredClone(ATTESTED);
  Object.assign(e.verificationResult.signature.certificate, cert);
  e.verificationResult.statement.subject = subjects;
  return e;
}
