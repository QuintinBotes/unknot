// Cross-file linking and manifest parsing, run over facts from both parsers.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import adapter from '../../../../adapters/language/python/index.mjs';
import { manifestFacts, parseRequirement, parseToml } from '../../../../adapters/language/python/manifests.mjs';
import {
  all, edges, extractFixture, find, hasPython, linkFacts, nodes, realExec, unsupportedExec,
} from './helpers.mjs';

const MODES = [
  { name: 'python3', exec: realExec },
  { name: 'lexical', exec: unsupportedExec },
];

const pairs = (facts, type) => edges(facts, type).map((e) => `${e.from} -> ${e.to}`).sort();

/** Build a synthetic repo from { path: text } and link it. */
async function repo(files, exec = unsupportedExec, options = {}) {
  const items = Object.entries(files).map(([path, text]) => ({ file: { path }, text }));
  const m = await adapter.extractBatch(items, { exec });
  return { m, linked: linkFacts(m, options) };
}

for (const mode of MODES) {
  const skip = mode.name === 'python3' && !hasPython ? 'python3 not available' : false;

  test(`[${mode.name}] src layout: absolute and relative imports resolve to modules`, { skip }, async () => {
    const m = await extractFixture('pkg_src', mode.exec);
    const linked = linkFacts(m);
    assert.deepEqual(pairs(linked, 'IMPORTS').filter((p) => p.includes('-> module:')), [
      'module:src/acme/__init__.py -> module:src/acme/core.py', // from .core import run
      'module:src/acme/core.py -> module:src/acme/config.py', // from . import config
      'module:src/acme/core.py -> module:src/acme/util/helpers.py', // absolute + relative, merged
      'module:src/acme/util/helpers.py -> module:src/acme/config.py', // from .. import config
      'module:tests/test_core.py -> module:src/acme/core.py', // from acme.core (src/ root)
    ]);
    const helpersEdge = edges(linked, 'IMPORTS').find((e) => e.to === 'module:src/acme/util/helpers.py');
    assert.deepEqual(helpersEdge.attrs.names, ['Normalizer', 'helpers', 'normalize']);
  });

  test(`[${mode.name}] external imports become dependencies; stdlib is namespaced`, { skip }, async () => {
    const linked = linkFacts(await extractFixture('pkg_src', mode.exec));
    const core = edges(linked, 'IMPORTS').filter((e) => e.from === 'module:src/acme/core.py' && e.to.startsWith('dependency:'));
    assert.deepEqual(core.map((e) => e.to).sort(), ['dependency:python:json', 'dependency:python:os', 'dependency:requests']);
    assert.equal(core.find((e) => e.to === 'dependency:python:os').attrs.stdlib, true);
    assert.equal(find(linked, 'dependency:requests').attrs.ecosystem, 'pypi');
    // import-name -> distribution aliases line up with manifest dependency names
    const flask = linkFacts(await extractFixture('flask_app', mode.exec));
    assert.ok(find(flask, 'dependency:pyyaml'));
    assert.ok(!find(flask, 'dependency:yaml'));
  });

  test(`[${mode.name}] calls resolve through imports, self, and base classes`, { skip }, async () => {
    const linked = linkFacts(await extractFixture('pkg_src', mode.exec));
    assert.deepEqual(pairs(linked, 'CALLS'), [
      'function:src/acme/core.py#run -> function:src/acme/util/helpers.py#normalize', // helpers.normalize (module binding)
      'function:tests/test_core.py#test_run -> function:src/acme/core.py#run',
      'method:src/acme/core.py#Runner.go -> function:src/acme/util/helpers.py#normalize', // symbol binding
      'method:src/acme/core.py#Runner.go -> method:src/acme/util/helpers.py#Normalizer.clean', // self.clean via base
    ]);
    assert.equal(edges(linked, 'CALLS')[0].provenance.confidence, mode.name === 'python3' ? 'medium' : 'low');
  });

  test(`[${mode.name}] EXTENDS, TESTS and package CONTAINS`, { skip }, async () => {
    const linked = linkFacts(await extractFixture('pkg_src', mode.exec));
    assert.deepEqual(pairs(linked, 'EXTENDS'), ['class:src/acme/core.py#Runner -> class:src/acme/util/helpers.py#Normalizer']);
    assert.deepEqual(pairs(linked, 'TESTS'), ['module:tests/test_core.py -> module:src/acme/core.py']);
    const contained = pairs(linked, 'CONTAINS');
    assert.ok(contained.includes('package:acme-widgets -> module:src/acme/core.py'));
    assert.ok(contained.includes('package:acme-widgets -> module:tests/test_core.py'));
    assert.equal(contained.length, 6); // every python module under the pyproject dir
    assert.equal(edges(linked, 'IMPORTS')[0].provenance.source_type, mode.name === 'python3' ? 'ast' : 'inference');
  });

  test(`[${mode.name}] Flask: imports and cross-module calls`, { skip }, async () => {
    const linked = linkFacts(await extractFixture('flask_app', mode.exec));
    assert.ok(pairs(linked, 'IMPORTS').includes('module:app.py -> module:auth/routes.py'));
    assert.ok(pairs(linked, 'CALLS').includes('function:auth/routes.py#me -> method:models.py#User.find'));
    assert.deepEqual(pairs(linked, 'EXTENDS'), ['class:models.py#Order -> class:models.py#Base', 'class:models.py#User -> class:models.py#Base']);
  });

  test(`[${mode.name}] Django: urlconf views are linked to endpoints`, { skip }, async () => {
    const linked = linkFacts(await extractFixture('django_project', mode.exec));
    assert.deepEqual(pairs(linked, 'EXPOSES'), [
      'class:shop/views.py#ProductDetail -> endpoint:ANY /products/:pk/',
      'function:shop/views.py#customer -> endpoint:ANY /customers/:cid/',
      'function:shop/views.py#product_list -> endpoint:ANY /products/',
    ]);
    assert.ok(pairs(linked, 'IMPORTS').includes('module:shop/urls.py -> module:shop/views.py'));
    assert.ok(pairs(linked, 'IMPORTS').includes('module:shop/views.py -> module:shop/models.py'));
  });
}

test('source roots: pyproject dirs, src/ and ctx.options.roots', async () => {
  const files = {
    'svc/pyproject.toml': '[project]\nname = "svc"\n',
    'svc/lib/util.py': 'def u(): pass\n',
    'svc/app.py': 'import lib.util\nfrom lib import util as u2\nu2.u()\nlib.util.u()\n',
    'vendor_root/zed/mod.py': 'def z(): pass\n',
    'main.py': 'import zed.mod\nimport lib.util\n',
  };
  const { linked } = await repo(files);
  const imports = pairs(linked, 'IMPORTS');
  assert.ok(imports.includes('module:svc/app.py -> module:svc/lib/util.py')); // svc/ is a source root
  assert.ok(imports.includes('module:main.py -> module:svc/lib/util.py'), 'svc root also serves repo-root modules');
  assert.ok(imports.includes('module:main.py -> dependency:zed')); // not importable without the extra root
  assert.ok(pairs(linked, 'CALLS').length === 0); // module-level calls are not function calls

  const withRoot = (await repo(files, unsupportedExec, { roots: ['vendor_root/'] })).linked;
  assert.ok(pairs(withRoot, 'IMPORTS').includes('module:main.py -> module:vendor_root/zed/mod.py'));
});

test('relative imports respect level and package boundaries', async () => {
  const { linked } = await repo({
    'pyproject.toml': '[project]\nname = "p"\n',
    'a/__init__.py': '',
    'a/x.py': 'from . import y\nfrom .. import top\nfrom ...way import too_far\nfrom .y import f\n',
    'a/y.py': 'def f(): pass\n',
    'a/sub/__init__.py': '',
    'a/sub/z.py': 'from .. import y\nfrom ..y import f\nfrom . import nothing_here\n',
    'top.py': 'T = 1\n',
  });
  const imports = pairs(linked, 'IMPORTS').filter((p) => p.includes('-> module:'));
  assert.deepEqual(imports, [
    'module:a/sub/z.py -> module:a/sub/__init__.py', // `from . import nothing_here` binds a symbol of the package
    'module:a/sub/z.py -> module:a/y.py',
    'module:a/x.py -> module:a/y.py',
    'module:a/x.py -> module:top.py',
  ]);
  assert.ok(!pairs(linked, 'IMPORTS').some((p) => p.includes('dependency:'))); // `...way` leaves the repo: dropped, not guessed
});

test('unresolvable internal-looking imports never invent dependencies', async () => {
  const { linked } = await repo({
    'pkg/__init__.py': '',
    'pkg/a.py': 'import pkg.missing\nfrom pkg import nothing\nimport numpy as np\nimport PIL.Image\nfrom __future__ import annotations\n',
  });
  const deps = nodes(linked, 'dependency').map((n) => n.id).sort();
  assert.deepEqual(deps, ['dependency:numpy', 'dependency:pillow', 'dependency:python:__future__']);
});

test('link is deterministic and tolerates facts from other adapters', async () => {
  const { m } = await repo({ 'a.py': 'import os\n', 'b.py': 'import a\n' });
  m.set('Dockerfile', []);
  m.set('other', [{ kind: 'node', id: 'service:x', type: 'service', name: 'x', path: null, attrs: {}, provenance: { source_type: 'config', source_ref: null, extractor: 'x@1', confidence: 'high', scope: [], contradicts: [] } }]);
  const a = JSON.stringify(linkFacts(m));
  const b = JSON.stringify(linkFacts(new Map([...m].reverse())));
  assert.equal(a, b);
  assert.equal(adapter.link({ files: new Map(), factsByFile: new Map(), options: {} }).length, 0);
});

// --- manifests ---------------------------------------------------------------------

test('pyproject.toml: project and poetry dependencies', () => {
  const text = [
    '[project]', 'name = "Acme_Widgets"', 'version = "1.2.0"',
    'dependencies = [', '  "requests>=2.31",', '  "PyYAML==6.0.1",  # pinned', "  \"click[extra]>=8; python_version >= '3.9'\",", ']',
    '[project.optional-dependencies]', 'dev = ["pytest>=8"]',
    '[tool.poetry.dependencies]', 'python = "^3.9"', 'rich = "^13.0"', 'httpx = { version = "^0.27", optional = true }',
    '[tool.poetry.group.test.dependencies]', 'hypothesis = "*"',
  ].join('\n');
  const facts = manifestFacts('pyproject.toml', text);
  const pkg = facts.find((f) => f.type === 'package');
  assert.equal(pkg.id, 'package:acme-widgets');
  assert.equal(pkg.attrs.version, '1.2.0');
  const deps = edges(facts, 'DEPENDS_ON').map((e) => [e.to, e.attrs.spec, e.attrs.group]);
  assert.deepEqual(deps, [
    ['dependency:requests', '>=2.31', 'main'], ['dependency:pyyaml', '==6.0.1', 'main'], ['dependency:click', '>=8', 'main'],
    ['dependency:pytest', '>=8', 'dev'], ['dependency:rich', '^13.0', 'main'], ['dependency:httpx', '^0.27', 'main'],
    ['dependency:hypothesis', '*', 'test'],
  ]);
  assert.ok(!deps.some(([d]) => d === 'dependency:python'));
  assert.equal(pkg.provenance.source_type, 'config');
});

test('requirements.txt: comments, options, urls and extras', () => {
  const text = [
    '# top comment', '-r base.txt', '--index-url https://example.invalid/simple', 'Flask==2.3  # web', 'requests[security]>=2',
    'git+https://example.invalid/x.git#egg=x', '-e .', './local', 'SQLAlchemy~=2.0 ; python_version >= "3.8"', '',
  ].join('\n');
  const facts = manifestFacts('services/api/requirements-dev.txt', text);
  assert.equal(facts[0].id, 'package:python:services/api');
  assert.deepEqual(edges(facts, 'DEPENDS_ON').map((e) => [e.to, e.attrs.spec]), [
    ['dependency:flask', '==2.3'], ['dependency:requests', '>=2'], ['dependency:sqlalchemy', '~=2.0'],
  ]);
});

test('setup.cfg and setup.py: name and install_requires', () => {
  const cfg = ['[metadata]', 'name = my.pkg', 'version = 0.3', '', '[options]', 'install_requires =', '    attrs>=21', '    click', '',
    '[options.extras_require]', 'dev =', '    black'].join('\n');
  const f = manifestFacts('setup.cfg', cfg);
  assert.equal(f[0].id, 'package:my-pkg');
  assert.deepEqual(edges(f, 'DEPENDS_ON').map((e) => [e.to, e.attrs.group]), [
    ['dependency:attrs', 'main'], ['dependency:click', 'main'], ['dependency:black', 'dev'],
  ]);
  const py = manifestFacts('setup.py', "from setuptools import setup\nsetup(name='legacy', install_requires=['six>=1.0', \"pytz\"])\n");
  assert.equal(py[0].id, 'package:legacy');
  assert.deepEqual(edges(py, 'DEPENDS_ON').map((e) => e.to), ['dependency:six', 'dependency:pytz']);
});

test('manifest helpers and the adapter route manifests without python3', async () => {
  assert.deepEqual(parseRequirement('Foo_Bar[x,y] >= 1.0 ; sys_platform == "win32"'), { name: 'Foo_Bar', spec: '>= 1.0' });
  assert.equal(parseRequirement('==nonsense'), null);
  const t = parseToml('a = 1\n[x.y]\nk = [\n "a", # c\n "b"\n]\n');
  assert.equal(t.get('x.y').get('k').replace(/\s+/g, ' '), '[ "a", "b" ]');
  const m = await adapter.extractBatch([
    { file: { path: 'requirements.txt' }, text: 'six\n' },
    { file: { path: 'setup.py' }, text: "setup(name='s')\n" },
  ], { exec: unsupportedExec });
  assert.deepEqual(all(m).filter((f) => f.type === 'package').map((f) => f.id), ['package:python:.', 'package:s']);
  assert.deepEqual(nodes(adapter.extract({ path: 'requirements.txt' }, 'six\n', {})).map((f) => f.id), ['package:python:.', 'dependency:six']);
  assert.equal(edges(adapter.extract({ path: 'requirements.txt' }, 'six\n', {}), 'DEPENDS_ON').length, 1);
  assert.equal(nodes(adapter.extract({ path: 'setup.py' }, "setup(name='s')\n", {}), 'module').length, 1);
});
