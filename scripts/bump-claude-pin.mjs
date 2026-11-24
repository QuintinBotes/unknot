#!/usr/bin/env node
// Rewrites the Claude Code pin in ci.yml and live.yml when <latest> is newer: node scripts/bump-claude-pin.mjs <latest>
// Prints the new version when it changed anything, nothing otherwise. Older or unparsable input changes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FILES = ['.github/workflows/ci.yml', '.github/workflows/live.yml'];
const PIN = /(@anthropic-ai\/claude-code@)(\d+\.\d+\.\d+)(?=\s+plugin validate|\s*$)/gm;
const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

export function bumpPin(text, latest) {
  const next = parse(latest);
  if (!next) return text;
  return text.replace(PIN, (m, head, cur) => (newer(next, parse(cur)) ? head + latest : m));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let changed = false;
  for (const f of FILES) {
    const old = readFileSync(f, 'utf8');
    const next = bumpPin(old, process.argv[2] ?? '');
    if (next !== old) { writeFileSync(f, next); changed = true; }
  }
  if (changed) console.log(process.argv[2]);
}
