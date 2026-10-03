// Canonical path and symlink checks (spec §16.3).
//
// Every path that reaches a policy decision goes through `resolveInside`, which answers
// one question: after following every symlink that exists on disk, is this path still
// inside the root it claims to be in? Lexical checks alone are not enough: `src/link`
// can be a symlink to `/etc`, and `src/link/passwd` normalises to something innocent.

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { UnknotError } from './errors.mjs';
import { matchAny } from './glob.mjs';

export function toPosix(p) {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** True when `child` is `parent` or below it. Both must already be absolute and canonical. */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
export function realpathLenient(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve `input` against `root` and prove it stays inside `root` after symlinks.
 * @returns {{abs: string, real: string, rel: string, isSymlink: boolean}}
 */
export function resolveInside(root, input, { allowRoot = true } = {}) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new UnknotError('UK_SCOPE_VIOLATION', 'empty path');
  }
  if (input.includes('\0')) throw new UnknotError('UK_SCOPE_VIOLATION', 'path contains a NUL byte');
  const realRoot = realpathLenient(resolve(root));
  const abs = resolve(realRoot, input);
  if (!isInside(realRoot, abs)) {
    throw new UnknotError('UK_SCOPE_VIOLATION', `path escapes the root: ${input}`, {
      details: { path: input, root: realRoot },
    });
  }
  const real = realpathLenient(abs);
  if (!isInside(realRoot, real)) {
    throw new UnknotError('UK_SCOPE_VIOLATION', `path resolves through a symlink outside the root: ${input}`, {
      details: { path: input, resolved: real },
    });
  }
  const rel = toPosix(relative(realRoot, real));
  if (!allowRoot && rel === '') throw new UnknotError('UK_SCOPE_VIOLATION', 'the root itself is not a valid target');
  let isSymlink = false;
  try {
    isSymlink = lstatSync(abs).isSymbolicLink();
  } catch {
    // Does not exist yet; a write would create a regular file.
  }
  return { abs, real, rel, isSymlink };
}

// Files whose content is a credential or routinely contains one. Model reads of these are
// denied and census never hands their text to an adapter. Matched case-insensitively.
export const SECRET_PATH_PATTERNS = Object.freeze([
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/*.kdbx',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/.aws/credentials',
  '**/.docker/config.json',
  '**/kubeconfig',
  '**/.kube/config',
  '**/*.tfstate',
  '**/*.tfstate.backup',
  '**/*.tfvars',
  '**/secrets.{yml,yaml,json}',
  '**/credentials.json',
  '**/service-account*.json',
]);

// Templates people commit on purpose; they are documentation, not secrets.
const SECRET_PATH_EXCEPTIONS = Object.freeze([
  '**/.env.example',
  '**/.env.sample',
  '**/.env.template',
  '**/.env.dist',
  '**/*.example.tfvars',
]);

export function isSecretPath(rel) {
  const p = toPosix(rel);
  return matchAny(p, SECRET_PATH_PATTERNS, { nocase: true }) && !matchAny(p, SECRET_PATH_EXCEPTIONS, { nocase: true });
}
