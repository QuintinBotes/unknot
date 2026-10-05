import assert from 'node:assert/strict';
import { test } from 'node:test';
import wiring, { mentions } from '../../../../adapters/delivery/wiring.mjs';

test('config files name modules by path; Meteor package manifests and the meteor field are recorded', () => {
  assert.deepEqual(mentions('{"command":"node ${CLAUDE_PLUGIN_ROOT}/hooks/post.mjs"}'), ['hooks/post.mjs']);
  const pkgJs = wiring.extract({ path: 'packages/x/package.js' }, "Package.describe({}); Package.onUse((api) => { api.mainModule('main.client.js', 'client'); });")[0];
  assert.equal(pkgJs.attrs.manifest, 'meteor-package');
  assert.deepEqual(wiring.extract({ path: 'src/package.js' }, 'export const a = 1;'), []);
  assert.equal(wiring.extract({ path: 'package.json' }, '{"meteor":{"mainModule":{"client":"client/main.js"}}}')[0].attrs.meteor_main_module, true);
  assert.equal(wiring.extract({ path: '.meteor/release' }, 'METEOR@2.13')[0].attrs.meteor_app, '');
  const files = new Map([['hooks/hooks.json', {}], ['hooks/post.mjs', {}]]);
  const edges = wiring.link({ files, factsByFile: new Map([['hooks/hooks.json', wiring.extract({ path: 'hooks/hooks.json' }, '{"c":"node ${CLAUDE_PLUGIN_ROOT}/hooks/post.mjs"}')]]) });
  assert.deepEqual(edges.map((e) => [e.type, e.from, e.to]), [['REFERENCES', 'file:hooks/hooks.json', 'module:hooks/post.mjs']]);
});
