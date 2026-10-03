import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRelease } from '../../../scripts/build-release.mjs';
import { verifyRelease } from '../../../scripts/verify-release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

let clone = null;
let skip = false;

before(() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    clone = mkdtempSync(join(tmpdir(), 'uk-rel-'));
    execFileSync('git', ['clone', '-q', '--no-hardlinks', repoRoot, clone], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, 'archive', '--format=tar', 'HEAD', 'package.json'], { stdio: 'ignore' });
  } catch {
    skip = 'git clone/archive unavailable';
  }
});

const build = (out, epoch) => buildRelease({ repo: clone, out, env: { SOURCE_DATE_EPOCH: epoch } });

test('build then verify round-trips on a clone of this repository', (t) => {
  if (skip) return t.skip(skip);
  const out = mkdtempSync(join(tmpdir(), 'uk-out-'));
  const r = build(out, '1700000000');
  assert.match(r.tarball, /unknot-\d+\.\d+\.\d+\.tar\.gz$/);
  const v = verifyRelease(out);
  assert.deepEqual(v.errors, []);
  assert.ok(v.ok && v.checked > 10);
});

test('SBOM is CycloneDX 1.5 shaped and records tools, runtime and file hashes', (t) => {
  if (skip) return t.skip(skip);
  const out = mkdtempSync(join(tmpdir(), 'uk-out-'));
  build(out, '1700000000');
  const sbom = JSON.parse(readFileSync(join(out, 'sbom.cdx.json'), 'utf8'));
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(sbom.metadata.timestamp, '2023-11-14T22:13:20Z');
  assert.equal(sbom.metadata.component.name, 'unknot');
  assert.ok(sbom.metadata.component.properties.some((p) => p.name === 'unknot:npm-dependencies' && p.value === '0'));
  const names = sbom.components.map((c) => c.name);
  for (const n of ['nodejs', 'python3', 'git', 'helm', 'kustomize', 'terraform', 'gitleaks', 'semgrep']) assert.ok(names.includes(n), n);
  const files = sbom.components.filter((c) => c.type === 'file');
  assert.ok(files.length > 10);
  assert.ok(files.every((f) => /^[0-9a-f]{64}$/.test(f.hashes[0].content)));
  assert.ok(sbom.dependencies.some((d) => d.ref === sbom.metadata.component['bom-ref']));
});

test('two builds with the same SOURCE_DATE_EPOCH are byte-identical', (t) => {
  if (skip) return t.skip(skip);
  const a = mkdtempSync(join(tmpdir(), 'uk-a-'));
  const b = mkdtempSync(join(tmpdir(), 'uk-b-'));
  const ra = build(a, '1700000000');
  build(b, '1700000000');
  assert.equal(readFileSync(join(a, 'sbom.cdx.json'), 'utf8'), readFileSync(join(b, 'sbom.cdx.json'), 'utf8'));
  assert.equal(readFileSync(join(a, 'SHA256SUMS'), 'utf8'), readFileSync(join(b, 'SHA256SUMS'), 'utf8'));
  assert.ok(readFileSync(ra.tarball).equals(readFileSync(join(b, `unknot-${ra.version}.tar.gz`))));
  // A different epoch changes only the SBOM (and so its checksum).
  const c = mkdtempSync(join(tmpdir(), 'uk-c-'));
  build(c, '1700000001');
  assert.notEqual(readFileSync(join(a, 'sbom.cdx.json'), 'utf8'), readFileSync(join(c, 'sbom.cdx.json'), 'utf8'));
});

test('verify-release fails on a tampered checksum, SBOM or tarball', (t) => {
  if (skip) return t.skip(skip);
  const out = mkdtempSync(join(tmpdir(), 'uk-out-'));
  const r = build(out, '1700000000');

  const sums = readFileSync(r.sums, 'utf8');
  writeFileSync(r.sums, sums.replace(/^./, (c) => (c === '0' ? '1' : '0')));
  assert.match(verifyRelease(out).errors.join('\n'), /checksum mismatch/);
  writeFileSync(r.sums, sums);
  assert.equal(verifyRelease(out).ok, true);

  const sbom = JSON.parse(readFileSync(r.sbom, 'utf8'));
  const file = sbom.components.find((c) => c.type === 'file');
  file.hashes[0].content = '0'.repeat(64);
  writeFileSync(r.sbom, JSON.stringify(sbom));
  const bad = verifyRelease(out);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /SBOM hash mismatch/);

  const tar = readFileSync(r.tarball);
  tar[tar.length - 20] ^= 0xff;
  writeFileSync(r.tarball, tar);
  assert.equal(verifyRelease(out).ok, false);
});
