#!/usr/bin/env node
// Deterministic release build (spec §29): tarball, SHA256SUMS and a CycloneDX 1.5 SBOM.
//
//   node scripts/build-release.mjs [--repo <dir>] [--ref HEAD] [--out dist]
//
// Reproducibility: the archive is made by `git archive` (entry mtimes are the commit time,
// owners are zeroed, order is the tree order) and compressed in-process with zlib, whose
// gzip header carries no timestamp, so the bytes do not depend on the host's gzip binary.
// The SBOM timestamp comes from SOURCE_DATE_EPOCH, defaulting to the commit time, and its
// serial number is derived from the tarball digest.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readTar, sha256 } from './lib/tar.mjs';

const REPO_URL = 'https://github.com/QuintinBotes/unknot';

/** Optional external tools the runtime can drive when present (spec §6). Never bundled. */
export const EXTERNAL_TOOLS = [
  { name: 'python3', url: 'https://www.python.org/' },
  { name: 'git', url: 'https://git-scm.com/' },
  { name: 'helm', url: 'https://helm.sh/' },
  { name: 'kustomize', url: 'https://kustomize.io/' },
  { name: 'terraform', url: 'https://www.terraform.io/' },
  { name: 'gitleaks', url: 'https://github.com/gitleaks/gitleaks' },
  { name: 'semgrep', url: 'https://semgrep.dev/' },
];

const git = (repo, args, opts = {}) => execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 30, ...opts });

/** UUID-shaped identifier derived from a digest so the SBOM serial is reproducible. */
function uuidFrom(hex) {
  const h = hex.slice(0, 32).split('');
  h[12] = '5';
  h[16] = '89ab'[parseInt(h[16], 16) & 3];
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * @param {object} p
 * @param {string} p.name package name
 * @param {string} p.version
 * @param {string} p.nodeRange engines.node
 * @param {string} p.tarballName
 * @param {string} p.tarballSha256
 * @param {{path: string, sha256: string}[]} p.files
 * @param {string} p.timestamp ISO-8601 UTC
 */
export function buildSbom({ name, version, nodeRange, tarballName, tarballSha256, files, timestamp }) {
  const ref = `pkg:github/quintinbotes/${name}@${version}`;
  const nodeRef = 'runtime:nodejs';
  const tools = EXTERNAL_TOOLS.map((t) => ({
    type: 'application',
    'bom-ref': `tool:${t.name}`,
    name: t.name,
    description: 'Optional external tool, detected on PATH at run time; not bundled.',
    properties: [{ name: 'unknot:optional', value: 'true' }, { name: 'unknot:bundled', value: 'false' }],
    externalReferences: [{ type: 'website', url: t.url }],
  }));
  const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuidFrom(tarballSha256)}`,
    version: 1,
    metadata: {
      timestamp,
      tools: { components: [{ type: 'application', name: 'unknot build-release', version }] },
      component: {
        type: 'application',
        'bom-ref': ref,
        name,
        version,
        purl: ref,
        licenses: [{ license: { id: 'Apache-2.0' } }],
        hashes: [{ alg: 'SHA-256', content: tarballSha256 }],
        externalReferences: [
          { type: 'vcs', url: REPO_URL },
          { type: 'distribution', url: `${REPO_URL}/releases/download/v${version}/${tarballName}` },
        ],
        properties: [
          { name: 'unknot:npm-dependencies', value: '0' },
          { name: 'unknot:tarball', value: tarballName },
        ],
      },
    },
    components: [
      {
        type: 'platform',
        'bom-ref': nodeRef,
        name: 'nodejs',
        version: nodeRange,
        description: 'Node.js runtime requirement (engines.node); not bundled.',
        externalReferences: [{ type: 'website', url: 'https://nodejs.org/' }],
      },
      ...tools,
      ...sortedFiles.map((f) => ({
        type: 'file',
        'bom-ref': `file:${f.path}`,
        name: f.path,
        hashes: [{ alg: 'SHA-256', content: f.sha256 }],
      })),
    ],
    dependencies: [
      { ref, dependsOn: [nodeRef, ...tools.map((t) => t['bom-ref'])] },
      { ref: nodeRef, dependsOn: [] },
      ...tools.map((t) => ({ ref: t['bom-ref'], dependsOn: [] })),
    ],
  };
}

/**
 * Build the release artifacts.
 * @param {{repo?: string, ref?: string, out?: string, env?: Record<string, string|undefined>}} [opts]
 * @returns {{tarball: string, sums: string, sbom: string, version: string, files: number}}
 */
export function buildRelease({ repo = process.cwd(), ref = 'HEAD', out = 'dist', env = process.env } = {}) {
  repo = resolve(repo);
  const pkg = JSON.parse(git(repo, ['show', `${ref}:package.json`], { encoding: 'utf8' }));
  const commitTime = Number(git(repo, ['log', '-1', '--format=%ct', ref], { encoding: 'utf8' }).trim());
  const epoch = env.SOURCE_DATE_EPOCH && /^\d+$/.test(env.SOURCE_DATE_EPOCH) ? Number(env.SOURCE_DATE_EPOCH) : commitTime;
  const prefix = `${pkg.name}-${pkg.version}`;

  const tar = git(repo, ['archive', '--format=tar', `--prefix=${prefix}/`, ref]);
  const gz = gzipSync(tar, { level: 9 });
  const tarballName = `${prefix}.tar.gz`;
  const tarballSha = sha256(gz);

  const files = readTar(tar).map((f) => ({ path: f.path, sha256: sha256(f.data) }));
  const sbom = buildSbom({
    name: pkg.name,
    version: pkg.version,
    nodeRange: pkg.engines?.node ?? '*',
    tarballName,
    tarballSha256: tarballSha,
    files,
    timestamp: new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  const sbomText = `${JSON.stringify(sbom, null, 2)}\n`;
  const sums = [[tarballSha, tarballName], [sha256(Buffer.from(sbomText)), 'sbom.cdx.json']]
    .map(([h, n]) => `${h}  ${n}`)
    .join('\n');

  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, tarballName), gz);
  writeFileSync(join(outDir, 'sbom.cdx.json'), sbomText);
  writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`);
  return { tarball: join(outDir, tarballName), sums: join(outDir, 'SHA256SUMS'), sbom: join(outDir, 'sbom.cdx.json'), version: pkg.version, files: files.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  try {
    const r = buildRelease({ repo: opt('--repo', process.cwd()), ref: opt('--ref', 'HEAD'), out: opt('--out', 'dist') });
    process.stdout.write(`built ${r.tarball} (${r.files} files)\nwrote ${r.sums}\nwrote ${r.sbom}\n`);
  } catch (err) {
    process.stderr.write(`build-release: ${err.message}\n`);
    process.exit(1);
  }
}
