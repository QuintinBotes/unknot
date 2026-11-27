// A fake `gh` for forge tests, never the real API. `installFakeGh(dir)` puts a `gh` on PATH that
// answers `gh api` from a routes file (`"<METHOD> <path>": response`; `{ seq: [a, b] }` answers a,
// then b) and logs every argv. A call without `--hostname github.com` is refused, so a request that
// could carry credentials anywhere else fails the test.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STUB = `
const fs = require('node:fs');
const dir = process.env.FAKE_GH_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(dir + '/gh.log', JSON.stringify(argv) + '\\n');
if (argv[0] === 'pr') { if (argv[1] === 'create') process.stdout.write(process.env.FAKE_GH_PR_URL + '\\n'); process.exit(0); }
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
    routes(map) {
      writeFileSync(join(dir, 'routes.json'), JSON.stringify(map));
      writeFileSync(join(dir, 'seq.json'), '{}');
    },
    calls: () => (existsSync(join(dir, 'gh.log')) ? readFileSync(join(dir, 'gh.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

const API = JSON.parse(readFileSync(new URL('../fixtures/github/api.json', import.meta.url), 'utf8'));

/** A GitHub API response from tests/fixtures/github/api.json, with top-level fields overridden. */
export const fixture = (name, over = {}) => ({ ...structuredClone(API[name]), ...over });
