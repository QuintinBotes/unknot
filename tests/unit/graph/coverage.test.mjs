import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';

after(() => K.cleanup());

const cs = (n) => `namespace Shop.Billing.N${n}\n{\n    public class C${n} { }\n}\n`;
const map = (p, scope = []) => mapRepository(p.ctx, { config: K.cfg({ mode: 'plan' }), configDigest: 'd', scope, history: false });

test('a repository read only lexically is partial, with coverage per language', async () => {
  const files = { 'README.md': '# x\n' };
  for (let i = 0; i < 4; i++) files[`src/Shop.Billing/C${i}.cs`] = cs(i);
  files['web/app.js'] = 'export const a = 1;\n';
  const p = K.makeProject({ files });
  const r = await map(p);
  assert.equal(r.status, 'partial');
  const u = r.unavailable.find((x) => x.adapter === 'language:csharp');
  const total = r.coverage.reduce((n, x) => n + x.files, 0);
  assert.ok(u && u.reason.includes(`(4 of ${total} source files)`), JSON.stringify(r.unavailable));
  const c = Object.fromEntries(r.coverage.map((x) => [x.language, x]));
  assert.deepEqual(c.csharp, { language: 'csharp', files: 4, adapter: 'generic', quality: 'lexical' });
  assert.equal(c.javascript.quality, 'syntax_tree');
});

test('a minority lexical language is a notice, not partial', async () => {
  const files = { 'src/Shop.Billing/C0.cs': cs(0) };
  for (let i = 0; i < 3; i++) files[`web/a${i}.js`] = `export const a${i} = 1;\n`;
  const p = K.makeProject({ files });
  const r = await map(p);
  assert.ok(!r.unavailable.some((x) => x.adapter?.startsWith('language:')));
  assert.ok(r.notices.some((n) => /csharp/.test(n)));
});

test('ownership files outside a narrow scope are still read and link owners to scoped files', async () => {
  const p = K.makeProject({ files: {
    '.github/CODEOWNERS': 'src/Shop.Billing/ @example/billing\n',
    'src/Shop.Billing/C0.cs': cs(0),
    'src/Other/C1.cs': cs(1),
  } });
  const r = await map(p, ['src/**/*Billing*/**']);
  assert.equal(r.adapters.ownership.files, 1);
  assert.equal(r.files, 1, 'the context file is not counted as an in-scope file');
  const rows = p.ctx.store.db.prepare("SELECT * FROM edges WHERE type = 'OWNED_BY'").all();
  assert.ok(rows.length >= 1, JSON.stringify(rows));
  assert.ok(!JSON.stringify(rows).includes('Other'));
});

test('ns: and seed: scope entries get a notice that map only narrows by path', async () => {
  const p = K.makeProject({ files: { 'src/a.js': 'export const a = 1;\n' } });
  const r = await map(p, ['src', 'ns:Shop.Billing']);
  assert.ok(r.notices.some((n) => /ns: and seed:/.test(n)));
});
