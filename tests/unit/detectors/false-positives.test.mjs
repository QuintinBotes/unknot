// Five known false-positive classes on compiled-language monoliths are gone (#81).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, ofKind } from '../../golden/_harness.mjs';

const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { classifyStyles } = await import('../../../runtime/artifacts/styles.mjs');

const cs = (ns, body, using = '') => `${using}namespace ${ns}\n{\n${body}\n}\n`;
const proj = '<Project Sdk="Microsoft.NET.Sdk"></Project>\n';

test('scenario 1: configuration, data and view-template files are never dead code', async () => {
  const { findings } = await analyse('equivalent-csharp', {
    extra: {
      'src/Web/appsettings.json': '{ "Logging": { "LogLevel": { "Default": "Information" } } }\n',
      'src/Web/Data/regions.csv': 'id,name\n1,North\n2,South\n',
      'src/Web/Views/Home/Index.cshtml': '@model Shop.Web.HomeModel\n<h1>@Model.Title</h1>\n',
    },
  });
  const paths = ofKind(findings, 'code.dead-code').flatMap((f) => f.scope);
  assert.ok(!paths.some((p) => /\.(json|csv|cshtml)$/.test(p)), paths.join(', '));
});

/** A project `lib` whose type is used by four files of Shop.Web and once by each of `others`. */
function consumed(lib, others = []) {
  const ref = (n) => `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../${lib}/${lib}.csproj" /></ItemGroup></Project>\n`;
  const user = (ns, name) => cs(ns, `    public class ${name}\n    {\n        public OrderPlaced Last;\n    }`, `using ${lib};\n`);
  return {
    [`src/${lib}/${lib}.csproj`]: proj,
    [`src/${lib}/OrderPlaced.cs`]: cs(lib, '    public class OrderPlaced\n    {\n        public int Id;\n    }'),
    'src/Shop.Web/Shop.Web.csproj': ref(),
    ...Object.fromEntries([0, 1, 2, 3].map((i) => [`src/Shop.Web/Page${i}.cs`, user('Shop.Web', `Page${i}`)])),
    ...Object.fromEntries(others.flatMap((n) => [[`src/Shop.${n}/Shop.${n}.csproj`, ref()], [`src/Shop.${n}/${n}Service.cs`, user(`Shop.${n}`, `${n}Service`)]])),
  };
}
const misplaced = async (lib, others) => ofKind((await analyse('equivalent-csharp', { extra: consumed(lib, others) })).findings, 'decomposition.misplaced-module').filter((f) => f.scope.some((p) => p.includes(lib))).map((f) => f.title);

test('scenario 2: a package whose role is to be consumed is not a misplaced module', async () => {
  assert.deepEqual(await misplaced('Shop.Contracts'), [], 'by name');
  assert.deepEqual(await misplaced('Shop.Pricing', ['Billing', 'Shipping', 'Stock']), [], 'by fan-in from several packages');
  assert.equal((await misplaced('Shop.Pricing')).length, 1, 'a neutral package used by one other is still misplaced');
  const tests = Object.fromEntries(['Pricing.Tests', 'Web.Tests'].flatMap((n) => [[`tests/Shop.${n}/Shop.${n}.csproj`, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup><ProjectReference Include="../../src/Shop.Pricing/Shop.Pricing.csproj" /></ItemGroup></Project>\n'], [`tests/Shop.${n}/${n.replace('.', '')}.cs`, cs(`Shop.${n}`, `    public class ${n.replace('.', '')}\n    {\n        public OrderPlaced Last;\n    }`, 'using Shop.Pricing;\n')]]));
  const withTests = ofKind((await analyse('equivalent-csharp', { extra: { ...consumed('Shop.Pricing'), ...tests } })).findings, 'decomposition.misplaced-module').filter((f) => f.scope.some((p) => p.includes('Shop.Pricing/')));
  assert.equal(withTests.length, 1, 'test projects importing it do not make it a shared library');
});

test('scenario 3: an interface with one implementation and a mocking-library double is not reported', async () => {
  const run = (double) => analyse('equivalent-csharp', {
    extra: {
      'src/Time/IClock.cs': cs('Shop.Time', '    public interface IClock\n    {\n        int Now();\n    }'),
      'src/Time/SystemClock.cs': cs('Shop.Time', '    public class SystemClock : IClock\n    {\n        public int Now() { return 1; }\n    }'),
      'src/Time/Scheduler.cs': cs('Shop.Time', '    public class Scheduler\n    {\n        private readonly IClock _clock;\n        public Scheduler(IClock clock) { _clock = clock; }\n        public int Next() { return _clock.Now() + 1; }\n    }'),
      'tests/Time.Tests/SchedulerTests.cs': cs('Shop.Time.Tests', `    public class SchedulerTests\n    {\n        public void Next()\n        {\n            var clock = ${double};\n            var s = new Scheduler(clock.Object);\n        }\n    }`, `using ${double.startsWith('new Mock') ? 'Moq' : 'NSubstitute'};\nusing Shop.Time;\n`),
    },
  });
  for (const double of ['new Mock<IClock>()', 'Substitute.For<IClock>()']) {
    const { findings } = await run(double);
    assert.deepEqual(ofKind(findings, 'code.one-implementation-interface').filter((f) => /IClock/.test(f.title)).map((f) => f.title), [], double);
  }
});

test('scenario 4: records, DTOs and primary constructors with nine parameters are not long parameter lists', async () => {
  const nine = 'int a, int b, int c, int d, int e, int f, int g, int h, int i';
  const { findings } = await analyse('equivalent-csharp', {
    extra: {
      'src/Dto/OrderRecord.cs': cs('Shop.Dto', `    public record OrderRecord(${nine});`),
      'src/Dto/OrderDto.cs': cs('Shop.Dto', `    public class OrderDto\n    {\n        public OrderDto(${nine}) { }\n    }`),
      'src/Dto/OrderView.cs': cs('Shop.Dto', `    public class OrderView(${nine})\n    {\n        public int Sum() { return a + i; }\n    }`),
      'src/Dto/Pricing.cs': cs('Shop.Dto', `    public class Pricing\n    {\n        public int Quote(${nine}) { return a + i; }\n    }`),
      'src/Dto/Money.cs': cs('Shop.Dto', `    public readonly record struct Money\n    {\n        public Money(${nine}) { }\n        public override string ToString() { return ""; }\n    }`),
      'src/Dto/OrderSync.cs': cs('Shop.Dto', `    public class OrderSync\n    {\n        public OrderSync(${nine}) { }\n        public void Run() { }\n    }`),
    },
  });
  const long = ofKind(findings, 'code.long-parameter-list').filter((f) => f.scope.some((p) => p.startsWith('src/Dto/')));
  assert.deepEqual(long.map((f) => f.scope[0]).sort(), ['src/Dto/OrderSync.cs', 'src/Dto/Pricing.cs'], 'a method and a service constructor keep their findings');
});

const styles = async (files) => {
  const { ctx } = await analyse('equivalent-csharp', { extra: files, skipDiagnose: true });
  return classifyStyles(Graph.fromStore(ctx.store)).map((s) => s.style);
};

test('scenario 5: an Extensions folder of extension-method classes is no plugin directory', async () => {
  const ext = (n) => cs('Shop.Extensions', `    public static class ${n}Extensions\n    {\n        public static int Twice(this int x) { return x * 2; }\n    }`);
  const found = await styles({
    'src/Extensions/StringExtensions.cs': ext('String'),
    'src/Extensions/ListExtensions.cs': ext('List'),
    'src/Extensions/DateExtensions.cs': ext('Date'),
    'src/Core/PluginRegistry.cs': cs('Shop.Core', '    public class PluginRegistry\n    {\n    }'),
  });
  assert.ok(!found.includes('microkernel/plugin'), found.join(', '));
  const plugins = await styles({
    'src/Extensions/Stripe/StripePlugin.cs': cs('Shop.Extensions', '    public class StripePlugin\n    {\n    }'),
    'src/Extensions/Ups/UpsPlugin.cs': cs('Shop.Extensions', '    public class UpsPlugin\n    {\n    }'),
    'src/Core/ExtensionHost.cs': cs('Shop.Core', '    public class ExtensionHost\n    {\n    }'),
  });
  assert.ok(plugins.includes('microkernel/plugin'), `plugins loaded by an extension host stay a plugin style: ${plugins.join(', ')}`);
});

test('scenario 6: three chained CI jobs are no batch pipeline', async () => {
  const found = await styles({
    '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: dotnet build\n  test:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: dotnet test\n  pack:\n    needs: test\n    runs-on: ubuntu-latest\n    steps:\n      - run: dotnet pack\n',
  });
  assert.ok(!found.includes('pipes-and-filters/batch'), found.join(', '));
});

test('a Go test that only asserts with testify mocks nothing', async () => {
  const run = (imp) => analyse('equivalent-go', { extra: {
    'store/store.go': 'package store\n\ntype Store interface {\n\tGet(id string) string\n}\n\ntype pgStore struct{}\n\nfunc (p pgStore) Get(id string) string { return id }\n\nfunc New() Store { return pgStore{} }\n',
    'store/store_test.go': `package store\n\nimport (\n\t"testing"\n\t"${imp}"\n)\n\nfunc TestGet(t *testing.T) {\n\tvar s Store = New()\n\t_ = s\n\t_ = assert.Equal\n}\n`,
  } });
  const found = async (imp) => ofKind((await run(imp)).findings, 'code.one-implementation-interface').filter((f) => /Store/.test(f.title)).length;
  assert.equal(await found('github.com/stretchr/testify/assert'), 1);
  assert.equal(await found('github.com/stretchr/testify/mock'), 0);
});

// Test doubles are judged per interface, and a `global using` in another file counts (#125).
const timeFiles = (tests, extra = {}) => ({
  'src/Time/Time.cs': cs('Shop.Time', '    public interface IClock\n    {\n        int Now();\n    }\n    public interface IRng\n    {\n        int Next();\n    }\n    public class SystemClock : IClock\n    {\n        public int Now() { return 1; }\n    }\n    public class SystemRng : IRng\n    {\n        public int Next() { return 1; }\n    }'),
  ...tests,
  ...extra,
});
const mocking = (usings, doubles) => cs('Shop.Time.Tests', `    public class SchedulerTests\n    {\n        public void Run()\n        {\n${doubles.map((d, i) => `            var d${i} = ${d};\n`).join('')}        }\n    }`, usings);
const flagged = async (files) => ofKind((await analyse('equivalent-csharp', { extra: files })).findings, 'code.one-implementation-interface').map((f) => f.title.split(' ')[0]).filter((n) => ['IClock', 'IRng'].includes(n)).sort();

test('#125 item 2: a global using of a mocking library in another file counts', async () => {
  const test = mocking('using Shop.Time;\n', ['new Mock<IClock>()']);
  assert.deepEqual(await flagged(timeFiles({ 'tests/Time.Tests/SchedulerTests.cs': test })), ['IClock', 'IRng'], 'without the library nothing is a double');
  assert.deepEqual(await flagged(timeFiles({ 'tests/Time.Tests/SchedulerTests.cs': test, 'tests/Time.Tests/GlobalUsings.cs': 'global using Moq;\n' })), ['IRng'], 'the global using makes the Mock a double of IClock');
});

test('#125 item 1: a double of one interface says nothing about another interface of the same file, whichever test file holds it', async () => {
  const moq = (doubles) => mocking('using Moq;\nusing Shop.Time;\n', doubles);
  const plain = cs('Shop.Time.Tests', '    public class OtherTests\n    {\n        public void Run()\n        {\n            var c = new SystemClock();\n        }\n    }', 'using Shop.Time;\n');
  for (const order of [['AOther.cs', 'ZMock.cs'], ['AMock.cs', 'ZOther.cs']]) {
    const files = {};
    for (const f of order) files[`tests/Time.Tests/${f}`] = f.includes('Mock') ? moq(['new Mock<IClock>()']) : plain;
    assert.deepEqual(await flagged(timeFiles(files)), ['IRng'], order.join());
  }
  assert.deepEqual(await flagged(timeFiles({ 'tests/Time.Tests/SchedulerTests.cs': moq(['new Mock<IClock>()', 'new Mock<IRng>()']) })), [], 'both mocked, in one file');
});
