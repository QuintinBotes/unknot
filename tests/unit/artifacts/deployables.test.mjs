// Deployables (#79): the containers are what runs. Web and executable .NET projects, app-host
// resources and Dockerfile-built projects are containers; CI jobs never are.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mkTmp } from '../../helpers/tmp.mjs';

process.env.UNKNOT_HOME = mkTmp(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { default: generic } = await import('../../../adapters/language/generic/index.mjs');
const { extractDockerfile } = await import('../../../adapters/infrastructure/k8s/docker.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { architectureViews } = await import('../../../runtime/artifacts/architecture.mjs');
const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const architecture = await import('../../../runtime/cli/commands/architecture.mjs');
const { mod, node } = await import('../../fixtures/artifacts/systems.mjs');

const csproj = (path, body = '', sdk = 'Microsoft.NET.Sdk') => generic.extract({ path, size: 0, language: null, kind: 'source', blob: path }, `<Project Sdk="${sdk}">\n<PropertyGroup>${body}</PropertyGroup>\n</Project>`, {});
const ref = (...to) => `</PropertyGroup><ItemGroup>${to.map((t) => `<ProjectReference Include="${t}" />`).join('')}</ItemGroup><PropertyGroup>`;
// What the delivery adapter emits for a CI job named like a task: a low-confidence, inferred deployable.
const ciJobs = () => ['build', 'lint', 'test'].map((n) => node('deployable', n, { name: n, attrs: { inferred: true } }));
const containersOf = (facts, scope = []) => architectureViews(Graph.fromFacts(facts), { scope }).views.containers.containers;
const names = (list) => list.map((c) => c.name).sort();

const web = () => [
  ...csproj('src/Orders/Orders.Web.csproj', '', 'Microsoft.NET.Sdk.Web'),
  ...csproj('src/Billing/Billing.Worker.csproj', '', 'Microsoft.NET.Sdk.Worker'),
  mod('src/Orders/Program.cs', { language: 'csharp' }),
  mod('src/Billing/Worker.cs', { language: 'csharp' }),
];

test('scenario 1: a web and a worker project are the only containers, CI jobs are none', () => {
  const list = containersOf([...web(), ...ciJobs()]);
  assert.deepEqual(names(list), ['Billing.Worker', 'Orders.Web']);
});

test('scenario 1 (CLI): architecture --json reports exactly the 2 containers', async () => {
  const dir = mkTmp(join(tmpdir(), 'uk-dep-'));
  const ctx = openProject(dir, { create: true });
  project(ctx, [...web(), ...ciJobs()], { commit: 'abc123', observedAt: '2026-10-01T00:00:00.000Z' });
  let buf = '';
  const write = process.stdout.write;
  process.stdout.write = (c, ...r) => (typeof c === 'string' ? ((buf += c), true) : write.call(process.stdout, c, ...r));
  try { await architecture.run({ positional: [], flags: { cwd: dir, json: true } }); } finally { process.stdout.write = write; }
  assert.deepEqual(names(JSON.parse(buf).views.containers.containers), ['Billing.Worker', 'Orders.Web']);
});

test('scenario 2: OutputType Exe is a container; a test project that is an Exe is not', () => {
  const facts = [...csproj('tools/Cli/Cli.csproj', '<OutputType>Exe</OutputType>'), ...csproj('tests/Cli.Tests/Cli.Tests.csproj', '<OutputType>Exe</OutputType><IsTestProject>true</IsTestProject>'), mod('tools/Cli/Main.cs')];
  assert.deepEqual(names(containersOf(facts)), ['Cli']);
});

test('edge: a class library is never a container', () => {
  assert.deepEqual(names(containersOf([...web(), ...csproj('src/Lib/Lib.csproj'), mod('src/Lib/A.cs')])), ['Billing.Worker', 'Orders.Web']);
});

test('scenario 3: a Dockerfile whose build publishes a project is linked to that container', () => {
  const docker = extractDockerfile('src/Orders/Dockerfile', 'FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build\nCOPY . .\nRUN dotnet publish "src/Orders/Orders.Web.csproj" -c Release -o /app\nFROM mcr.microsoft.com/dotnet/aspnet:10.0\nENTRYPOINT ["dotnet","Orders.Web.dll"]\n');
  const list = containersOf([...web(), ...docker]);
  assert.equal(list.find((c) => c.name === 'Orders.Web').dockerfile, 'src/Orders/Dockerfile');
  assert.equal(list.find((c) => c.name === 'Billing.Worker').dockerfile, null);
});

test('scenario 4: an app host contributes the projects it references, not its shared library', () => {
  const facts = [
    ...csproj('src/AppHost/AppHost.csproj', `<OutputType>Exe</OutputType><IsAspireHost>true</IsAspireHost>${ref('../Api/Api.csproj', '../Extra/Extra.csproj', '../Defaults/Defaults.csproj')}`, 'Microsoft.NET.Sdk'),
    ...csproj('src/Api/Api.csproj', '', 'Microsoft.NET.Sdk.Web'),
    ...csproj('src/Extra/Extra.csproj'), // no marker of its own: runnable only because the app host names it
    ...csproj('src/Defaults/Defaults.csproj', '<IsAspireSharedProject>true</IsAspireSharedProject>'),
    mod('src/Api/P.cs'), mod('src/Extra/P.cs'), mod('src/Defaults/D.cs'), mod('src/AppHost/Program.cs'),
  ];
  assert.deepEqual(names(containersOf(facts)), ['Api', 'AppHost', 'Extra']);
});

test('scenario 5: a scope keeps only the containers under that path', () => {
  assert.deepEqual(names(containersOf([...web(), ...ciJobs()], ['src/Orders'])), ['Orders.Web']);
});

test('scenario 6: a container lists its modules, and 0 modules is a gap in the notes', () => {
  const list = containersOf(web());
  assert.deepEqual(list.find((c) => c.name === 'Orders.Web').modules, ['src/Orders/Program.cs']);
  const facts = [...web(), ...csproj('src/Empty/Empty.csproj', '', 'Microsoft.NET.Sdk.Web')];
  const v = architectureViews(Graph.fromFacts(facts)).views.containers;
  assert.deepEqual(v.containers.find((c) => c.name === 'Empty').modules, []);
  assert.ok(v.notes.some((n) => /Empty/.test(n) && /0 modules/.test(n)));
});

test('edge: with no recognisable deployable the view says so and shows no CI job', () => {
  const v = architectureViews(Graph.fromFacts([...ciJobs(), mod('src/a/x.cs'), mod('src/b/y.cs')])).views.containers;
  assert.ok(!v.containers.some((c) => ['build', 'lint', 'test'].includes(c.name)));
  assert.ok(v.notes.some((n) => /no deployable/i.test(n)));
});

test('a CI-inferred deployable named like a real project does not add a second container', () => {
  const facts = [...web(), node('deployable', 'orders.web', { name: 'orders.web', attrs: { inferred: true } })];
  assert.deepEqual(names(containersOf(facts)), ['Billing.Worker', 'Orders.Web']);
});

test('a web project and a measured deployable of the same name are one container with the module', () => {
  const facts = [...csproj('src/Api/Api.csproj', '', 'Microsoft.NET.Sdk.Web'), mod('src/Api/P.cs'), node('deployable', 'Api', { name: 'Api', attrs: { delivery: 'ci' } })];
  const list = containersOf(facts);
  assert.deepEqual(names(list), ['Api']);
  assert.deepEqual(list[0].modules, ['src/Api/P.cs']);
});

test('a bare published csproj name links the Dockerfile only to the project beside it', () => {
  const docker = extractDockerfile('src/A/Dockerfile', 'FROM mcr.microsoft.com/dotnet/sdk:10.0\nRUN dotnet publish Api.csproj -c Release\n');
  const facts = [...csproj('src/A/Api.csproj', '', 'Microsoft.NET.Sdk.Web'), ...csproj('src/B/Api.csproj', '', 'Microsoft.NET.Sdk.Web'), mod('src/A/P.cs'), mod('src/B/P.cs'), ...docker];
  const linked = containersOf(facts).filter((c) => c.dockerfile).map((c) => c.dockerfile);
  assert.deepEqual(linked, ['src/A/Dockerfile']);
});

const { extractCompose } = await import('../../../adapters/infrastructure/k8s/docker.mjs');
const nopDocker = () => extractDockerfile('src/Dockerfile', 'FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build\nWORKDIR /src\nCOPY ./src ./\nWORKDIR /src/Presentation/Nop.Web\nRUN dotnet publish Nop.Web.csproj -c Release -o /app\n');
const nopCompose = (build = 'build: .') => extractCompose('src/docker-compose.yml', `services:\n  web:\n    ${build}\n  db:\n    image: mcr.microsoft.com/mssql/server:2019\n`);
const nopFacts = (build) => [...csproj('src/Presentation/Nop.Web/Nop.Web.csproj', '', 'Microsoft.NET.Sdk.Web'), mod('src/Presentation/Nop.Web/P.cs'), ...nopDocker(), ...nopCompose(build)];

test('a compose service that builds a Dockerfile is the project that Dockerfile publishes', () => {
  for (const build of ['build: .', 'build:\n      context: .\n      dockerfile: Dockerfile']) {
    const list = containersOf(nopFacts(build));
    assert.deepEqual(names(list), ['Nop.Web', 'db']);
    assert.deepEqual(list.find((c) => c.name === 'Nop.Web').modules, ['src/Presentation/Nop.Web/P.cs']);
    assert.equal(list.find((c) => c.name === 'Nop.Web').dockerfile, 'src/Dockerfile');
  }
});

test('an image-only compose service is external and not a gap', () => {
  const v = architectureViews(Graph.fromFacts(nopFacts())).views.containers;
  assert.equal(v.containers.find((c) => c.name === 'db').external, true);
  assert.ok(!v.containers.find((c) => c.name === 'Nop.Web').external);
  assert.ok(!v.notes.some((n) => /db/.test(n) && /0 modules/.test(n)));
});
