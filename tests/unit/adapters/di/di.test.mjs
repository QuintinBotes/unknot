// Dependency-injection container bindings as graph facts (adapters/language/di-ops.mjs,
// adapters/language/di/index.mjs): every row of DI_SYNTAX gives the expected registration,
// and, with the service and implementation types declared in fixture files read by the
// adapter for that language, the RESOLVES_TO and DEPENDS_ON edges. Unresolved and
// ambiguous names give no edge, and a registered implementation is not dead code.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'unknot-di-home-'));

import diAdapter from '../../../../adapters/language/di/index.mjs';
import genericAdapter from '../../../../adapters/language/generic/index.mjs';
import javascriptAdapter from '../../../../adapters/language/javascript/index.mjs';
import pythonAdapter from '../../../../adapters/language/python/index.mjs';
import { DI_SYNTAX, diCandidates } from '../../../../adapters/language/di-ops.mjs';
import { ADAPTERS } from '../../../../adapters/registry.mjs';
import local from '../../../../runtime/diagnose/detectors/local.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';
import { LANGUAGE_IDS } from '../../../../runtime/graph/languages.mjs';
import { hasPython, realExec, unsupportedExec } from '../python/helpers.mjs';

const L = LANGUAGE_IDS;
const entryOf = (path, text) => ({ path, size: text.length, language: null, kind: 'source', blob: path });
const brief = (cs) => cs.map(({ container, service, implementation, lifetime }) => ({ container, service, implementation, lifetime }));

// --------------------------------------------------------------------- candidates

const reg = (container, service, implementation, lifetime) => ({ container, service, implementation, lifetime });

const CANDIDATES = [
  { name: 'microsoft-di generic pair', lang: L.CSHARP, src: 'services.AddSingleton<IInvoiceService, InvoiceService>();', expected: [reg('microsoft-di', 'IInvoiceService', 'InvoiceService', 'singleton')] },
  { name: 'microsoft-di scoped and transient', lang: L.CSHARP, src: 'services.AddScoped<IOrderService, OrderService>();\nservices.AddTransient<ILedgerService, LedgerService>();', expected: [reg('microsoft-di', 'IOrderService', 'OrderService', 'scoped'), reg('microsoft-di', 'ILedgerService', 'LedgerService', 'transient')] },
  { name: 'microsoft-di TryAdd forms', lang: L.CSHARP, src: 'services.TryAddSingleton<IInvoiceService, InvoiceService>();\nservices.TryAddScoped<IOrderService, OrderService>();\nservices.TryAddTransient<ILedgerService, LedgerService>();', expected: [reg('microsoft-di', 'IInvoiceService', 'InvoiceService', 'singleton'), reg('microsoft-di', 'IOrderService', 'OrderService', 'scoped'), reg('microsoft-di', 'ILedgerService', 'LedgerService', 'transient')] },
  { name: 'microsoft-di self form', lang: L.CSHARP, src: 'services.AddScoped<LedgerService>();', expected: [reg('microsoft-di', 'LedgerService', 'LedgerService', 'scoped')] },
  { name: 'microsoft-di typeof form', lang: L.CSHARP, src: 'services.AddScoped(typeof(IInvoiceService), typeof(InvoiceService));', expected: [reg('microsoft-di', 'IInvoiceService', 'InvoiceService', 'scoped')] },
  { name: 'autofac singleton', lang: L.CSHARP, src: 'builder.RegisterType<InvoiceService>().As<IInvoiceService>().SingleInstance();', expected: [reg('autofac', 'IInvoiceService', 'InvoiceService', 'singleton')] },
  { name: 'autofac scoped spellings', lang: L.CSHARP, src: 'builder.RegisterType<OrderService>().As<IOrderService>().InstancePerLifetimeScope();\nbuilder.RegisterType<LedgerService>().As<ILedgerService>().InstancePerRequest();', expected: [reg('autofac', 'IOrderService', 'OrderService', 'scoped'), reg('autofac', 'ILedgerService', 'LedgerService', 'scoped')] },
  { name: 'autofac transient spellings', lang: L.CSHARP, src: 'builder.RegisterType<OrderService>().As<IOrderService>().InstancePerDependency();\nbuilder.RegisterType<LedgerService>().As<ILedgerService>();', expected: [reg('autofac', 'IOrderService', 'OrderService', 'transient'), reg('autofac', 'ILedgerService', 'LedgerService', 'transient')] },
  { name: 'autofac AsSelf', lang: L.CSHARP, src: 'builder.RegisterType<LedgerService>().AsSelf();', expected: [reg('autofac', 'LedgerService', 'LedgerService', 'transient')] },
  { name: 'guice java singleton spellings', lang: L.JAVA, src: 'bind(IInvoiceService.class).to(InvoiceService.class).in(Singleton.class);\nbind(IOrderService.class).to(OrderService.class).in(Scopes.SINGLETON);\nbind(ILedgerService.class).to(LedgerService.class).asEagerSingleton();', expected: [reg('guice', 'IInvoiceService', 'InvoiceService', 'singleton'), reg('guice', 'IOrderService', 'OrderService', 'singleton'), reg('guice', 'ILedgerService', 'LedgerService', 'singleton')] },
  { name: 'guice java default transient', lang: L.JAVA, src: 'bind(IInvoiceService.class).to(InvoiceService.class);', expected: [reg('guice', 'IInvoiceService', 'InvoiceService', 'transient')] },
  { name: 'guice kotlin', lang: L.KOTLIN, src: 'bind(IInvoiceService::class.java).to(InvoiceService::class.java)', expected: [reg('guice', 'IInvoiceService', 'InvoiceService', 'transient')] },
  { name: 'spring bean java default singleton', lang: L.JAVA, src: '@Bean\npublic IInvoiceService invoiceService() { return new InvoiceService(); }', expected: [reg('spring', 'IInvoiceService', 'InvoiceService', 'singleton')] },
  { name: 'spring bean prototype spellings', lang: L.JAVA, src: '@Bean\n@Scope("prototype")\npublic IOrderService orderService() { return new OrderService(); }\n@Scope(ConfigurableBeanFactory.SCOPE_PROTOTYPE)\n@Bean\npublic ILedgerService ledgerService() { return new LedgerService(); }', expected: [reg('spring', 'IOrderService', 'OrderService', 'transient'), reg('spring', 'ILedgerService', 'LedgerService', 'transient')] },
  { name: 'spring bean request and session scope', lang: L.JAVA, src: '@Bean\n@Scope("request")\npublic IOrderService orderService() { return new OrderService(); }\n@Bean\n@Scope("session")\npublic ILedgerService ledgerService() { return new LedgerService(); }', expected: [reg('spring', 'IOrderService', 'OrderService', 'scoped'), reg('spring', 'ILedgerService', 'LedgerService', 'scoped')] },
  { name: 'spring bean kotlin', lang: L.KOTLIN, src: '@Bean\nfun invoiceService(): IInvoiceService { return InvoiceService() }', expected: [reg('spring', 'IInvoiceService', 'InvoiceService', 'singleton')] },
  { name: 'spring component java', lang: L.JAVA, src: '@Service\npublic class InvoiceService implements IInvoiceService {\n}', expected: [reg('spring', 'IInvoiceService', 'InvoiceService', 'singleton')], scanned: true },
  { name: 'spring component java several interfaces', lang: L.JAVA, src: '@RestController\npublic class OrderService implements IOrderService, ILedgerService {\n}', expected: [reg('spring', 'ILedgerService', 'OrderService', 'singleton'), reg('spring', 'IOrderService', 'OrderService', 'singleton')], scanned: true },
  { name: 'spring component kotlin', lang: L.KOTLIN, src: '@Component\nclass LedgerService : ILedgerService {\n}', expected: [reg('spring', 'ILedgerService', 'LedgerService', 'singleton')], scanned: true },
  { name: 'spring repository and controller markers', lang: L.JAVA, src: '@Repository\npublic class InvoiceService implements IInvoiceService {\n}\n@Controller\npublic class OrderService implements IOrderService {\n}', expected: [reg('spring', 'IInvoiceService', 'InvoiceService', 'singleton'), reg('spring', 'IOrderService', 'OrderService', 'singleton')], scanned: true },
  { name: 'dagger binds java', lang: L.JAVA, src: '@Binds\nabstract IInvoiceService bindInvoiceService(InvoiceService impl);', expected: [reg('dagger', 'IInvoiceService', 'InvoiceService', 'unknown')] },
  { name: 'dagger binds singleton', lang: L.JAVA, src: '@Singleton\n@Binds\nabstract IOrderService bindOrderService(OrderService impl);', expected: [reg('dagger', 'IOrderService', 'OrderService', 'singleton')] },
  { name: 'dagger binds kotlin', lang: L.KOTLIN, src: '@Binds\nabstract fun bindLedgerService(impl: LedgerService): ILedgerService', expected: [reg('dagger', 'ILedgerService', 'LedgerService', 'unknown')] },
  { name: 'nest provider default singleton', lang: L.TYPESCRIPT, src: 'const providers = [{ provide: IInvoiceService, useClass: InvoiceService }];', expected: [reg('nest-angular', 'IInvoiceService', 'InvoiceService', 'singleton')] },
  { name: 'nest provider scopes', lang: L.TYPESCRIPT, src: 'const providers = [{ provide: IOrderService, useClass: OrderService, scope: Scope.REQUEST }, { provide: ILedgerService, useClass: LedgerService, scope: Scope.TRANSIENT }];', expected: [reg('nest-angular', 'IOrderService', 'OrderService', 'scoped'), reg('nest-angular', 'ILedgerService', 'LedgerService', 'transient')] },
  { name: 'nest provider string token', lang: L.TYPESCRIPT, src: "const providers = [{ provide: 'ORDERS', useClass: OrderService }];", expected: [reg('nest-angular', 'ORDERS', 'OrderService', 'singleton')] },
  { name: 'inversify type argument names the service', lang: L.TYPESCRIPT, src: 'container.bind<IInvoiceService>(TYPES.IInvoiceService).to(InvoiceService).inSingletonScope();', expected: [reg('inversify', 'IInvoiceService', 'InvoiceService', 'singleton')] },
  { name: 'inversify scopes', lang: L.TYPESCRIPT, src: 'container.bind<IOrderService>(TYPES.IOrderService).to(OrderService).inRequestScope();\ncontainer.bind<ILedgerService>(TYPES.ILedgerService).to(LedgerService).inTransientScope();\ncontainer.bind<IInvoiceService>(TYPES.IInvoiceService).to(InvoiceService);', expected: [reg('inversify', 'IOrderService', 'OrderService', 'scoped'), reg('inversify', 'ILedgerService', 'LedgerService', 'transient'), reg('inversify', 'IInvoiceService', 'InvoiceService', 'transient')] },
  { name: 'laravel bind forms', lang: L.PHP, src: "<?php\n$this->app->bind(IInvoiceService::class, InvoiceService::class);\napp()->bind(IOrderService::class, OrderService::class);\nApp::bind(ILedgerService::class, LedgerService::class);", expected: [reg('laravel', 'IInvoiceService', 'InvoiceService', 'transient'), reg('laravel', 'IOrderService', 'OrderService', 'transient'), reg('laravel', 'ILedgerService', 'LedgerService', 'transient')] },
  { name: 'laravel singleton and scoped', lang: L.PHP, src: "<?php\n$this->app->singleton(IInvoiceService::class, InvoiceService::class);\n$this->app->scoped(IOrderService::class, OrderService::class);", expected: [reg('laravel', 'IInvoiceService', 'InvoiceService', 'singleton'), reg('laravel', 'IOrderService', 'OrderService', 'scoped')] },
  { name: 'python injector singleton', lang: L.PYTHON, src: 'binder.bind(IInvoiceService, to=InvoiceService, scope=singleton)\n', expected: [reg('injector', 'IInvoiceService', 'InvoiceService', 'singleton')] },
  { name: 'python injector default transient', lang: L.PYTHON, src: 'binder.bind(IOrderService, to=OrderService)\n', expected: [reg('injector', 'IOrderService', 'OrderService', 'transient')] },
  { name: 'go wire', lang: L.GO, src: 'wire.Bind(new(IInvoiceService), new(*InvoiceService))', expected: [reg('wire', 'IInvoiceService', 'InvoiceService', 'unknown')] },
];

for (const c of CANDIDATES) {
  test(`candidates: ${c.name}`, () => {
    const got = diCandidates('fixture', c.src, c.lang);
    assert.deepEqual(brief(got), c.expected);
    for (const g of got) {
      assert.equal(g.scanned, c.scanned || undefined);
      assert.ok(Number.isInteger(g.line) && g.line >= 1);
      assert.ok(Number.isInteger(g.index) && g.index >= 0);
    }
  });
}

test('the table has a candidate case for every row', () => {
  const covered = new Set(CANDIDATES.flatMap((c) => c.expected.map((e) => `${e.container}|${c.lang}`)));
  for (const row of DI_SYNTAX) {
    assert.ok(row.languages.some((lang) => covered.has(`${row.container}|${lang}`)), `${row.container} (${row.kind}) has a case`);
  }
});

test('a registration in a comment or a string gives nothing', () => {
  assert.deepEqual(diCandidates('a.cs', '// services.AddSingleton<IInvoiceService, InvoiceService>();\nvar s = "AddScoped<IOrderService, OrderService>()";', L.CSHARP), []);
  assert.deepEqual(diCandidates('a.java', '/* bind(IInvoiceService.class).to(InvoiceService.class); */\nString s = "@Bean";', L.JAVA), []);
  assert.deepEqual(diCandidates('a.ts', 'const s = "{ provide: IInvoiceService, useClass: InvoiceService }";', L.TYPESCRIPT), []);
});

test('a file naming none of the table, or in an uncovered language, gives nothing', () => {
  assert.deepEqual(diCandidates('a.cs', 'public class InvoiceService {\n}', L.CSHARP), []);
  assert.deepEqual(diCandidates('a.rb', 'bind(IInvoiceService, InvoiceService)', L.RUBY), []);
});

// --------------------------------------------------------------------- linking

/**
 * Every fact for a set of files: the language adapter that reads `lang` (extract and
 * link, as in orm-maps.test.mjs), then the di adapter's extract and link over the same
 * per-file facts. Returns the language facts alone too, for the dead-code control.
 */
async function factsFor(lang, sources) {
  const files = new Map();
  const factsByFile = new Map();
  let languageLinked = [];
  if (lang === L.PYTHON) {
    const items = Object.entries(sources).map(([path, text]) => ({ file: entryOf(path, text), text }));
    for (const it of items) files.set(it.file.path, it.file);
    const records = await pythonAdapter.extractBatch(items, { exec: hasPython ? realExec : unsupportedExec, options: {} });
    for (const [path, facts] of records) factsByFile.set(path, [...facts]);
    languageLinked = pythonAdapter.link({ files, factsByFile, options: {} });
  } else {
    const adapter = [L.TYPESCRIPT, L.JAVASCRIPT].includes(lang) ? javascriptAdapter : genericAdapter;
    for (const [path, text] of Object.entries(sources)) {
      const entry = entryOf(path, text);
      files.set(path, entry);
      factsByFile.set(path, adapter.extract(entry, text, { commit: 'test', options: {} }));
    }
    languageLinked = adapter.link({ files, factsByFile, options: {}, resolve: null });
  }
  const languageFacts = [...factsByFile.values()].flat().concat(languageLinked);
  for (const [path, text] of Object.entries(sources)) {
    const facts = diAdapter.extract(entryOf(path, text), text, { commit: 'test', options: {} });
    if (facts.length) factsByFile.set(path, [...(factsByFile.get(path) ?? []), ...facts]);
  }
  const notes = [];
  const stats = {};
  const diLinked = diAdapter.link({ files, factsByFile, options: {}, notes, stats });
  return { facts: [...factsByFile.values()].flat().concat(languageLinked, diLinked), languageFacts, diLinked, factsByFile, notes, stats };
}

const svc = (path, name, kind = 'interface') => `${kind}:${path}#${name}`;
const impl = (path, name) => `class:${path}#${name}`;

// One link case per row: the registering file, the service and implementation files.
const LINKS = [
  {
    name: 'microsoft-di', lang: L.CSHARP, registeredIn: 'App/Program.cs',
    sources: {
      'App/Program.cs': 'public class Program\n{\n    void Register(IServiceCollection services) { services.AddScoped<IInvoiceService, InvoiceService>(); }\n}\n',
      'Billing/IInvoiceService.cs': 'public interface IInvoiceService\n{\n}\n',
      'Billing/InvoiceService.cs': 'public class InvoiceService : IInvoiceService\n{\n}\n',
    },
    service: svc('Billing/IInvoiceService.cs', 'IInvoiceService'), implementation: impl('Billing/InvoiceService.cs', 'InvoiceService'),
    container: 'microsoft-di', lifetime: 'scoped', implModule: 'Billing/InvoiceService.cs',
  },
  {
    name: 'autofac', lang: L.CSHARP, registeredIn: 'App/Module.cs',
    sources: {
      'App/Module.cs': 'public class BillingModule\n{\n    void Load(ContainerBuilder builder) { builder.RegisterType<OrderService>().As<IOrderService>().SingleInstance(); }\n}\n',
      'Orders/IOrderService.cs': 'public interface IOrderService\n{\n}\n',
      'Orders/OrderService.cs': 'public class OrderService : IOrderService\n{\n}\n',
    },
    service: svc('Orders/IOrderService.cs', 'IOrderService'), implementation: impl('Orders/OrderService.cs', 'OrderService'),
    container: 'autofac', lifetime: 'singleton', implModule: 'Orders/OrderService.cs',
  },
  {
    name: 'guice', lang: L.JAVA, registeredIn: 'src/BillingModule.java',
    sources: {
      'src/BillingModule.java': 'public class BillingModule {\n    void configure() { bind(IInvoiceService.class).to(InvoiceService.class).in(Singleton.class); }\n}\n',
      'src/IInvoiceService.java': 'public interface IInvoiceService {\n}\n',
      'src/InvoiceService.java': 'public class InvoiceService implements IInvoiceService {\n}\n',
    },
    service: svc('src/IInvoiceService.java', 'IInvoiceService'), implementation: impl('src/InvoiceService.java', 'InvoiceService'),
    container: 'guice', lifetime: 'singleton', implModule: 'src/InvoiceService.java',
  },
  {
    name: 'spring bean', lang: L.JAVA, registeredIn: 'src/BillingConfig.java',
    sources: {
      'src/BillingConfig.java': 'public class BillingConfig {\n    @Bean\n    public IInvoiceService invoiceService() { return new InvoiceService(); }\n}\n',
      'src/IInvoiceService.java': 'public interface IInvoiceService {\n}\n',
      'src/InvoiceService.java': 'public class InvoiceService implements IInvoiceService {\n}\n',
    },
    service: svc('src/IInvoiceService.java', 'IInvoiceService'), implementation: impl('src/InvoiceService.java', 'InvoiceService'),
    container: 'spring', lifetime: 'singleton', implModule: 'src/InvoiceService.java',
  },
  {
    name: 'spring component scanning', lang: L.JAVA, registeredIn: 'src/OrderService.java', depends: false, confidence: 'low',
    sources: {
      'src/IOrderService.java': 'public interface IOrderService {\n}\n',
      'src/OrderService.java': '@Service\npublic class OrderService implements IOrderService {\n}\n',
    },
    service: svc('src/IOrderService.java', 'IOrderService'), implementation: impl('src/OrderService.java', 'OrderService'),
    container: 'spring', lifetime: 'singleton', implModule: 'src/OrderService.java',
  },
  {
    name: 'dagger', lang: L.JAVA, registeredIn: 'src/LedgerModule.java',
    sources: {
      'src/LedgerModule.java': 'public abstract class LedgerModule {\n    @Singleton\n    @Binds\n    abstract ILedgerService bindLedgerService(LedgerService impl);\n}\n',
      'src/ILedgerService.java': 'public interface ILedgerService {\n}\n',
      'src/LedgerService.java': 'public class LedgerService implements ILedgerService {\n}\n',
    },
    service: svc('src/ILedgerService.java', 'ILedgerService'), implementation: impl('src/LedgerService.java', 'LedgerService'),
    container: 'dagger', lifetime: 'singleton', implModule: 'src/LedgerService.java',
  },
  {
    name: 'nest provider', lang: L.TYPESCRIPT, registeredIn: 'src/billing.providers.ts',
    sources: {
      'src/billing.providers.ts': 'export const providers = [{ provide: IInvoiceService, useClass: InvoiceService }];\n',
      'src/invoice-service.ts': 'export interface IInvoiceService {\n}\n',
      'src/invoice-service-impl.ts': 'export class InvoiceService {\n}\n',
    },
    service: svc('src/invoice-service.ts', 'IInvoiceService'), implementation: impl('src/invoice-service-impl.ts', 'InvoiceService'),
    container: 'nest-angular', lifetime: 'singleton', implModule: 'src/invoice-service-impl.ts',
  },
  {
    name: 'inversify', lang: L.TYPESCRIPT, registeredIn: 'src/container.ts',
    sources: {
      'src/container.ts': 'container.bind<IOrderService>(TYPES.IOrderService).to(OrderService).inRequestScope();\n',
      'src/order-service.ts': 'export interface IOrderService {\n}\n',
      'src/order-service-impl.ts': 'export class OrderService {\n}\n',
    },
    service: svc('src/order-service.ts', 'IOrderService'), implementation: impl('src/order-service-impl.ts', 'OrderService'),
    container: 'inversify', lifetime: 'scoped', implModule: 'src/order-service-impl.ts',
  },
  {
    name: 'laravel', lang: L.PHP, registeredIn: 'app/Providers/BillingProvider.php',
    sources: {
      'app/Providers/BillingProvider.php': "<?php\nclass BillingProvider\n{\n    public function register() { $this->app->singleton(IInvoiceService::class, InvoiceService::class); }\n}\n",
      'app/Billing/IInvoiceService.php': "<?php\ninterface IInvoiceService\n{\n}\n",
      'app/Billing/InvoiceService.php': "<?php\nclass InvoiceService implements IInvoiceService\n{\n}\n",
    },
    service: svc('app/Billing/IInvoiceService.php', 'IInvoiceService'), implementation: impl('app/Billing/InvoiceService.php', 'InvoiceService'),
    container: 'laravel', lifetime: 'singleton', implModule: 'app/Billing/InvoiceService.php',
  },
  {
    name: 'python injector', lang: L.PYTHON, registeredIn: 'billing/container.py',
    sources: {
      'billing/container.py': 'def configure(binder):\n    binder.bind(IInvoiceService, to=InvoiceService, scope=singleton)\n',
      'billing/contracts.py': 'class IInvoiceService:\n    pass\n',
      'billing/service.py': 'class InvoiceService:\n    pass\n',
    },
    service: svc('billing/contracts.py', 'IInvoiceService', 'class'), implementation: impl('billing/service.py', 'InvoiceService'),
    container: 'injector', lifetime: 'singleton', implModule: 'billing/service.py',
  },
  {
    name: 'go wire', lang: L.GO, registeredIn: 'billing/wire.go',
    sources: {
      'billing/wire.go': 'package billing\n\nvar set = wire.Bind(new(ILedgerService), new(*LedgerService))\n',
      'billing/contracts.go': 'package billing\n\ntype ILedgerService interface {\n\tPost()\n}\n',
      'billing/service.go': 'package billing\n\ntype LedgerService struct {\n}\n',
    },
    service: svc('billing/contracts.go', 'ILedgerService'), implementation: impl('billing/service.go', 'LedgerService'),
    container: 'wire', lifetime: 'unknown', implModule: 'billing/service.go',
  },
];

for (const c of LINKS) {
  test(`link: ${c.name} gives RESOLVES_TO${c.depends === false ? ' only (the implementation registers itself)' : ' and DEPENDS_ON'}`, async () => {
    const { facts, diLinked, factsByFile } = await factsFor(c.lang, c.sources);
    facts.forEach(assertFact);
    const resolves = diLinked.filter((f) => f.kind === 'edge' && f.type === 'RESOLVES_TO');
    assert.deepEqual(resolves.map((e) => [e.from, e.to]), [[c.service, c.implementation]]);
    const [edge] = resolves;
    assert.equal(edge.attrs.via, 'container');
    assert.equal(edge.attrs.container, c.container);
    assert.equal(edge.attrs.lifetime, c.lifetime);
    assert.equal(edge.attrs.registered_in, c.registeredIn);
    assert.ok(Number.isInteger(edge.attrs.line));
    assert.equal(edge.provenance.extractor, 'di@0.1.0');
    assert.equal(edge.provenance.source_type, 'inference');
    assert.equal(edge.provenance.confidence, c.confidence ?? 'medium');
    const depends = diLinked.filter((f) => f.kind === 'edge' && f.type === 'DEPENDS_ON');
    if (c.depends === false) {
      assert.deepEqual(depends, []);
    } else {
      assert.deepEqual(depends.map((e) => [e.from, e.to]), [[`module:${c.registeredIn}`, `module:${c.implModule}`]]);
      assert.equal(depends[0].attrs.via, 'container');
      assert.equal(depends[0].attrs.container, c.container);
      assert.equal(depends[0].attrs.lifetime, c.lifetime);
      assert.equal(depends[0].provenance.confidence, c.confidence ?? 'medium');
    }
    // The link-only candidates attribute is gone after linking.
    for (const list of factsByFile.values()) for (const f of list) assert.equal(f.attrs?.di_candidates, undefined);
  });
}

// --------------------------------------------------------------------- resolution

const CS_PAIR = {
  'Billing/IInvoiceService.cs': 'public interface IInvoiceService\n{\n}\n',
  'Billing/InvoiceService.cs': 'public class InvoiceService : IInvoiceService\n{\n}\n',
};

test('an undeclared name gives no edge and is reported as unresolved', async () => {
  const { diLinked, notes, stats } = await factsFor(L.CSHARP, {
    'App/Program.cs': 'public class Program\n{\n    void Register(IServiceCollection services) { services.AddSingleton<IInvoiceService, MissingService>(); }\n}\n',
    ...CS_PAIR,
  });
  assert.deepEqual(diLinked, []);
  assert.deepEqual(stats.di, { registrations: 1, unresolved: 1 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /di: 1 of 1 container registration/);
});

test('a name declared in two files gives no edge for that side', async () => {
  const { diLinked, stats } = await factsFor(L.CSHARP, {
    'App/Program.cs': 'public class Program\n{\n    void Register(IServiceCollection services) { services.AddSingleton<IInvoiceService, InvoiceService>(); }\n}\n',
    ...CS_PAIR,
    'Other/InvoiceService.cs': 'public class InvoiceService\n{\n}\n',
  });
  assert.deepEqual(diLinked, []);
  assert.deepEqual(stats.di, { registrations: 1, unresolved: 1 });
});

test('a type declared in the registering file wins over a same-named type elsewhere', async () => {
  const { diLinked } = await factsFor(L.CSHARP, {
    'App/Program.cs': 'public class InvoiceService : IInvoiceService\n{\n}\npublic class Program\n{\n    void Register(IServiceCollection services) { services.AddSingleton<IInvoiceService, InvoiceService>(); }\n}\n',
    ...CS_PAIR,
  });
  const resolves = diLinked.filter((f) => f.type === 'RESOLVES_TO');
  assert.deepEqual(resolves.map((e) => [e.from, e.to]), [[svc('Billing/IInvoiceService.cs', 'IInvoiceService'), impl('App/Program.cs', 'InvoiceService')]]);
  // The implementation is in the registering module, so there is no DEPENDS_ON.
  assert.deepEqual(diLinked.filter((f) => f.type === 'DEPENDS_ON'), []);
});

test('a self-binding gives DEPENDS_ON and no RESOLVES_TO', async () => {
  const { diLinked } = await factsFor(L.CSHARP, {
    'App/Program.cs': 'public class Program\n{\n    void Register(IServiceCollection services) { services.AddScoped<InvoiceService>(); }\n}\n',
    ...CS_PAIR,
  });
  assert.deepEqual(diLinked.filter((f) => f.type === 'RESOLVES_TO'), []);
  const depends = diLinked.filter((f) => f.type === 'DEPENDS_ON');
  assert.deepEqual(depends.map((e) => [e.from, e.to]), [['module:App/Program.cs', 'module:Billing/InvoiceService.cs']]);
  assert.equal(depends[0].attrs.service, 'InvoiceService');
  assert.equal(depends[0].attrs.implementation, 'InvoiceService');
  assert.equal(depends[0].attrs.lifetime, 'scoped');
});

test('a string token leaves the service unresolved but still wires the implementation module', async () => {
  const { diLinked, stats } = await factsFor(L.TYPESCRIPT, {
    'src/billing.providers.ts': "export const providers = [{ provide: 'INVOICES', useClass: InvoiceService }];\n",
    'src/invoice-service-impl.ts': 'export class InvoiceService {\n}\n',
  });
  assert.deepEqual(diLinked.filter((f) => f.type === 'RESOLVES_TO'), []);
  assert.deepEqual(diLinked.filter((f) => f.type === 'DEPENDS_ON').map((e) => [e.from, e.to]),
    [['module:src/billing.providers.ts', 'module:src/invoice-service-impl.ts']]);
  assert.deepEqual(stats.di, { registrations: 1, unresolved: 1 });
});

// --------------------------------------------------------------------- dead code

test('the dead-code detector does not report an implementation module only a registration references', async () => {
  const sources = {
    'src/container.ts': "import { IInvoiceService } from './invoice-service';\nexport const providers = [{ provide: IInvoiceService, useClass: InvoiceService }];\n",
    'src/invoice-service.ts': 'export interface IInvoiceService {\n}\n',
    'src/invoice-service-impl.ts': 'export class InvoiceService {\n}\n',
  };
  const { facts, languageFacts } = await factsFor(L.TYPESCRIPT, sources);
  const dead = local.find((d) => d.id === 'local.dead-code');
  const unreferenced = (fs) => dead.detect({ graph: Graph.fromFacts(fs), options: {} })
    .filter((d) => /invoice-service-impl\.ts is imported by nothing/.test(d.title));
  assert.equal(unreferenced(languageFacts).length, 1, 'without container wiring the implementation module looks dead');
  assert.equal(unreferenced(facts).length, 0, 'the registration DEPENDS_ON counts as runtime wiring');
});

// --------------------------------------------------------------------- adapter shape

test('the di adapter is a framework adapter registered right after contracts', () => {
  assert.equal(diAdapter.id, 'di');
  assert.equal(diAdapter.version, '0.1.0');
  assert.equal(diAdapter.kind, 'framework');
  assert.deepEqual(diAdapter.capabilities.executes, []);
  assert.equal(diAdapter.capabilities.network, false);
  assert.ok(diAdapter.capabilities.files.includes('**/*.cs'));
  assert.ok(diAdapter.capabilities.files.includes('**/*.py'));
  const ids = ADAPTERS.map((a) => a.id);
  assert.equal(ids[ids.indexOf('contracts') + 1], 'di');
  assert.equal(ADAPTERS.find((a) => a.id === 'di').module, './language/di/index.mjs');
});

