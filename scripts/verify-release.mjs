#!/usr/bin/env node
// Verify a release (spec §29) offline: re-compute the checksums and the per-file SBOM
// hashes from the tarball itself and fail on any mismatch.
//
//   node scripts/verify-release.mjs [<dir containing the tarball, SHA256SUMS, sbom.cdx.json>]
//
// This proves integrity (bytes match what the SBOM and SHA256SUMS describe). Authenticity
// comes from the provenance attestation: `gh attestation verify <file> --repo QuintinBotes/unknot`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readTar, sha256 } from './lib/tar.mjs';

/**
 * @param {string} dir
 * @returns {{ok: boolean, errors: string[], checked: number}}
 */
export function verifyRelease(dir = 'dist') {
  dir = resolve(dir);
  const errors = [];
  const need = (name) => {
    const p = join(dir, name);
    if (!existsSync(p)) errors.push(`missing ${name}`);
    return p;
  };
  const tarballName = existsSync(dir) ? readdirSync(dir).find((n) => /\.tar\.gz$/.test(n)) : null;
  if (!tarballName) return { ok: false, errors: [`no .tar.gz in ${dir}`], checked: 0 };
  const tarPath = join(dir, tarballName);
  const sumsPath = need('SHA256SUMS');
  const sbomPath = need('sbom.cdx.json');
  if (errors.length) return { ok: false, errors, checked: 0 };

  const gz = readFileSync(tarPath);
  const sbomBytes = readFileSync(sbomPath);

  // 1. SHA256SUMS lines against the files next to it.
  let checked = 0;
  for (const line of readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!m) {
      errors.push(`malformed SHA256SUMS line: ${line.slice(0, 80)}`);
      continue;
    }
    const target = join(dir, m[2]);
    if (m[2].includes('/') || !existsSync(target)) {
      errors.push(`SHA256SUMS names ${m[2]}, which is not alongside it`);
      continue;
    }
    checked += 1;
    if (sha256(readFileSync(target)) !== m[1]) errors.push(`checksum mismatch: ${m[2]}`);
  }

  // 2. SBOM shape, tarball hash and per-file hashes against the archive contents.
  let sbom;
  try {
    sbom = JSON.parse(sbomBytes.toString('utf8'));
  } catch {
    return { ok: false, errors: [...errors, 'sbom.cdx.json is not valid JSON'], checked };
  }
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5') errors.push('SBOM is not CycloneDX 1.5');
  const declared = sbom.metadata?.component?.hashes?.find((h) => h.alg === 'SHA-256')?.content;
  if (declared !== sha256(gz)) errors.push('SBOM tarball hash does not match the tarball');

  let files;
  try {
    files = readTar(gunzipSync(gz));
  } catch (err) {
    return { ok: false, errors: [...errors, `cannot read tarball: ${err.message}`], checked };
  }
  const actual = new Map(files.map((f) => [f.path, sha256(f.data)]));
  const listed = new Map();
  for (const c of sbom.components ?? []) {
    if (c.type !== 'file') continue;
    listed.set(c.name, c.hashes?.find((h) => h.alg === 'SHA-256')?.content);
  }
  for (const [path, h] of actual) {
    if (!listed.has(path)) errors.push(`file not in SBOM: ${path}`);
    else if (listed.get(path) !== h) errors.push(`SBOM hash mismatch: ${path}`);
  }
  for (const path of listed.keys()) if (!actual.has(path)) errors.push(`SBOM lists a file not in the tarball: ${path}`);
  checked += actual.size;
  return { ok: errors.length === 0, errors, checked };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = verifyRelease(process.argv[2] ?? 'dist');
  if (r.ok) {
    process.stdout.write(`release verified: ${r.checked} checks passed\n`);
  } else {
    for (const e of r.errors.slice(0, 50)) process.stderr.write(`verify-release: ${e}\n`);
    process.exit(1);
  }
}
