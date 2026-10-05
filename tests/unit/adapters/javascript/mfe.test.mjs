import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectMicroFrontends } from '../../../../adapters/language/javascript/mfe.mjs';

test('Module Federation: name, remotes, exposes and shared at the top level only', () => {
  const r = detectMicroFrontends("new ModuleFederationPlugin({ name: 'shell', remotes: { checkout: 'checkout@http://x/remoteEntry.js', cart: 'cart@y' }, exposes: { './Header': './src/Header' }, shared: { react: { singleton: true } } })");
  assert.equal(r.kind, 'module-federation');
  assert.equal(r.name, 'shell');
  assert.deepEqual(r.remotes, ['checkout', 'cart']);
  assert.deepEqual(r.exposes, ['./Header']);
  assert.deepEqual(r.shared, ['react']);
});

test('single-spa registrations and Next.js multi-zone rewrites', () => {
  assert.deepEqual(detectMicroFrontends("registerApplication({ name: '@acme/navbar', app: () => import('x') }); registerApplication('@acme/orders', load, active)").apps, ['@acme/navbar', '@acme/orders']);
  const z = detectMicroFrontends("module.exports = { async rewrites() { return [{ source: '/blog/:p*', destination: 'https://blog.example.com/blog/:p*' }]; } }");
  assert.equal(z.kind, 'multi-zone');
  assert.deepEqual(z.zones, ['blog.example.com']);
  assert.equal(detectMicroFrontends('export const x = 1;'), null);
});
