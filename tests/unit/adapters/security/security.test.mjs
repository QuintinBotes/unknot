import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../../../adapters/security/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';

// Assembled at runtime so no scanner flags this test file itself.
const AWS = `AKIA${'IOSFODNN7EXAMPLE'}`;
const file = (path, extra = {}) => ({ path, size: 10, kind: 'config', blob: 'x', ...extra });

test('adapter shape', () => {
  assert.equal(adapter.id, 'security');
  assert.equal(adapter.version, '0.1.0');
  assert.equal(adapter.kind, 'security');
  assert.equal(adapter.capabilities.network, false);
  assert.deepEqual(adapter.capabilities.executes, ['gitleaks', 'semgrep', 'trivy', 'osv-scanner']);
});

test('extract records kind and line, never the value', () => {
  const text = `# config\nregion = eu\naws_access_key_id = ${AWS}\n`;
  const facts = adapter.extract(file('conf/app.env'), text);
  assert.equal(facts.length, 1);
  facts.forEach(assertFact);
  assert.equal(facts[0].id, 'file:conf/app.env');
  assert.deepEqual(facts[0].attrs.secrets, [{ kind: 'aws-access-key-id', line: 3 }]);
  assert.equal(facts[0].provenance.extractor, 'security@0.1.0');
  assert.equal(facts[0].provenance.confidence, 'medium');
  assert.equal(facts[0].provenance.source_type, 'ast');
  assert.ok(!JSON.stringify(facts).includes(AWS));
  assert.ok(!JSON.stringify(facts).includes('IOSFODNN7'));
});

test('extract skips clean text, lockfiles, binaries and large files', () => {
  assert.deepEqual(adapter.extract(file('a.txt'), 'nothing here'), []);
  assert.deepEqual(adapter.extract(file('package-lock.json'), AWS), []);
  assert.deepEqual(adapter.extract(file('yarn.lock'), AWS), []);
  assert.deepEqual(adapter.extract(file('x.bin', { kind: 'binary' }), AWS), []);
  assert.deepEqual(adapter.extract(file('big.txt', { size: 2 * 1024 * 1024 }), AWS), []);
});

test('discover parses gitleaks output into scanner findings and records what ran', async () => {
  const calls = [];
  const out = JSON.stringify([{ RuleID: 'aws-access-token', File: '/repo/src/a.js', StartLine: 7, Secret: 'REDACTED', Match: `key=${AWS}` }]);
  const ctx = {
    root: '/repo',
    options: {},
    exec: async (argv, opts) => { calls.push({ argv, opts }); return { exitCode: 1, stdout: out, stderr: '' }; },
  };
  const facts = await adapter.discover(ctx);
  facts.forEach(assertFact);
  assert.equal(calls.length, 1, 'semgrep and osv-scanner stay off without local config');
  assert.equal(calls[0].argv[0], 'gitleaks');
  assert.ok(calls[0].argv.includes('--redact'));
  assert.ok(Number.isFinite(calls[0].opts.timeoutMs));
  const f = facts.find((x) => x.id === 'file:src/a.js');
  assert.deepEqual(f.attrs.scanner_findings, [{ tool: 'gitleaks', rule: 'aws-access-token', severity: 'high', line: 7 }]);
  assert.ok(!JSON.stringify(facts).includes(AWS));
  const bt = facts.find((x) => x.id === 'build_target:security-scanners');
  assert.deepEqual(bt.attrs.ran, ['gitleaks']);
  assert.deepEqual(bt.attrs.unavailable, []);
  assert.ok(bt.attrs.skipped.some((s) => s.tool === 'semgrep'));
});

test('discover runs semgrep and osv-scanner only when locally configured', async () => {
  const seen = [];
  const ctx = {
    root: '/repo',
    options: { semgrep_config: 'rules/local.yml', osv_offline_db: '/db' },
    exec: async (argv) => {
      seen.push(argv[0]);
      if (argv[0] === 'semgrep') return { stdout: JSON.stringify({ results: [{ check_id: 'r.eval', path: 'src/b.py', start: { line: 3 }, extra: { severity: 'ERROR', message: `use of eval ${AWS}` } }] }) };
      if (argv[0] === 'osv-scanner') return { stdout: JSON.stringify({ results: [{ source: { path: '/repo/package.json' }, packages: [{ vulnerabilities: [{ id: 'GHSA-xxxx' }] }] }] }) };
      return { stdout: '[]' };
    },
  };
  const facts = await adapter.discover(ctx);
  assert.deepEqual(seen, ['gitleaks', 'semgrep', 'osv-scanner']);
  const sg = facts.find((x) => x.id === 'file:src/b.py').attrs.scanner_findings[0];
  assert.equal(sg.tool, 'semgrep');
  assert.ok(!sg.message.includes(AWS), 'messages are redacted');
  assert.equal(facts.find((x) => x.id === 'file:package.json').attrs.scanner_findings[0].rule, 'GHSA-xxxx');
});

test('discover tolerates missing or forbidden tools', async () => {
  const ctx = {
    root: '/repo',
    options: { semgrep_config: 'rules.yml' },
    exec: async (argv) => {
      throw Object.assign(new Error(`${argv[0]} is not installed`), { code: 'UK_ADAPTER_UNSUPPORTED' });
    },
  };
  const facts = await adapter.discover(ctx);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, 'build_target:security-scanners');
  assert.deepEqual(facts[0].attrs.unavailable, ['gitleaks', 'semgrep']);
  assert.deepEqual(facts[0].attrs.ran, []);
});

test('discover records an unexpected failure without throwing', async () => {
  const facts = await adapter.discover({ root: '/r', options: {}, exec: async () => { throw new Error('boom'); } });
  assert.deepEqual(facts[0].attrs.failed, ['gitleaks']);
});
