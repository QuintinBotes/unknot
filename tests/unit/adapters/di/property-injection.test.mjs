// Container property injection (#230): Autofac `PropertiesAutowired()` and Unity
// `InjectionProperty("Name")` make a public settable property an injected member, so the
// unused-injected-member check considers it; without such a registration it stays a public
// contract member. Both adapters run as `map` runs them: extract, the generic link, then di.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import diAdapter from '../../../../adapters/language/di/index.mjs';
import genericAdapter from '../../../../adapters/language/generic/index.mjs';
import local from '../../../../runtime/diagnose/detectors/local.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';

function map(sources) {
  const files = new Map();
  const factsByFile = new Map();
  for (const [path, text] of Object.entries(sources)) {
    const entry = { path, size: text.length, language: null, kind: 'source', blob: path };
    files.set(path, entry);
    factsByFile.set(path, [...genericAdapter.extract(entry, text, { commit: 'test', options: {} }), ...diAdapter.extract(entry, text, { commit: 'test', options: {} })]);
  }
  const linked = genericAdapter.link({ files, factsByFile, options: {}, resolve: null });
  const diLinked = diAdapter.link({ files, factsByFile, options: {}, notes: [], stats: {} });
  const facts = [...[...factsByFile.values()].flat(), ...linked, ...diLinked];
  const edge = (from, to) => linked.find((f) => f.type === 'IMPORTS' && f.from === `module:${from}` && f.to === `module:${to}`);
  const findings = local.find((d) => d.id === 'local.unused-injected-member').detect({ graph: Graph.fromFacts(facts), options: {} });
  return { edge, diLinked, findings };
}

const INFRA = {
  'Infra/IClock.cs': 'namespace Shop.Infra\n{\n    public interface IClock\n    {\n    }\n}\n',
  'Infra/ILogger.cs': 'namespace Shop.Infra\n{\n    public interface ILogger\n    {\n        void Write(string m);\n    }\n}\n',
  'Infra/SystemClock.cs': 'namespace Shop.Infra\n{\n    public class SystemClock : IClock\n    {\n    }\n}\n',
  'Orders/IOrderService.cs': 'namespace Shop.Orders\n{\n    public interface IOrderService\n    {\n    }\n}\n',
};
const service = (body) => `using Shop.Infra;\nnamespace Shop.Orders\n{\n    public class OrderService : IOrderService\n    {\n${body}\n    }\n}\n`;
const READS_LOG = '        public IClock Clock { get; set; }\n        public ILogger Log { get; set; }\n        public void Place() { Log.Write("placed"); }';
const autofac = (chain) => `using Autofac;\nusing Shop.Orders;\nnamespace Shop.App\n{\n    public class OrderModule : Module\n    {\n        protected override void Load(ContainerBuilder builder)\n        {\n            builder.RegisterType<OrderService>().As<IOrderService>()${chain};\n        }\n    }\n}\n`;

test('autofac: PropertiesAutowired injects the public settable properties; an unread one is reported with its registration', () => {
  const { edge, diLinked, findings } = map({ ...INFRA, 'Orders/OrderService.cs': service(READS_LOG), 'App/OrderModule.cs': autofac('.PropertiesAutowired()') });
  const resolves = diLinked.find((f) => f.type === 'RESOLVES_TO');
  assert.equal(resolves.attrs.properties, 'autowired');
  assert.equal(resolves.attrs.container, 'autofac');
  const clock = edge('Orders/OrderService.cs', 'Infra/IClock.cs');
  assert.equal(clock.attrs.declared_only, true);
  assert.equal(clock.attrs.unused_member, 'Clock');
  assert.equal(clock.attrs.member_visibility, 'public');
  assert.equal(clock.attrs.injected_by, 'App/OrderModule.cs:9');
  assert.ok(!edge('Orders/OrderService.cs', 'Infra/ILogger.cs').attrs.declared_only, 'Log is read by Place');
  assert.equal(findings.length, 1);
  const [f] = findings;
  assert.match(f.title, /Orders\/OrderService\.cs holds Infra\/IClock\.cs only through the unused member Clock/);
  const reg = f.evidence.find((e) => e.source_ref === 'App/OrderModule.cs:9');
  assert.equal(reg.label, 'inferred');
  assert.match(reg.summary, /container registration at App\/OrderModule\.cs:9 injects Clock/);
});

test('autofac: without PropertiesAutowired public properties are contract members, not injected', () => {
  const { edge, findings } = map({ ...INFRA, 'Orders/OrderService.cs': service(READS_LOG), 'App/OrderModule.cs': autofac('') });
  assert.ok(!edge('Orders/OrderService.cs', 'Infra/IClock.cs').attrs.declared_only);
  assert.deepEqual(findings, []);
});

test('autofac: only a public, non-static auto-property with a public setter is autowired', () => {
  const body = '        public IClock Clock { get; private set; }\n        public static ILogger Log { get; set; }';
  const { edge, findings } = map({ ...INFRA, 'Orders/OrderService.cs': service(body), 'App/OrderModule.cs': autofac('.PropertiesAutowired()') });
  assert.ok(!edge('Orders/OrderService.cs', 'Infra/IClock.cs').attrs.declared_only);
  assert.ok(!edge('Orders/OrderService.cs', 'Infra/ILogger.cs').attrs.declared_only);
  assert.deepEqual(findings, []);
});

const unity = (args) => `using Unity;\nusing Shop.Orders;\nusing Shop.Infra;\nnamespace Shop.App\n{\n    public static class Container\n    {\n        public static void Configure(IUnityContainer container)\n        {\n            container.RegisterType<IOrderService, OrderService>(${args});\n            container.RegisterSingleton<IClock, SystemClock>();\n        }\n    }\n}\n`;
const BOTH_UNREAD = '        public IClock Clock { get; set; }\n        public ILogger Log { get; set; }';

test('unity: RegisterType and RegisterSingleton are registrations; InjectionProperty injects only the named property', () => {
  const { edge, diLinked } = map({ ...INFRA, 'Orders/OrderService.cs': service(BOTH_UNREAD), 'App/Container.cs': unity('new InjectionProperty("Clock")') });
  const resolves = diLinked.filter((f) => f.type === 'RESOLVES_TO').map((f) => [f.from, f.to, f.attrs.container, f.attrs.lifetime, f.attrs.properties]);
  assert.deepEqual(resolves, [
    ['interface:Orders/IOrderService.cs#IOrderService', 'class:Orders/OrderService.cs#OrderService', 'unity', 'transient', ['Clock']],
    ['interface:Infra/IClock.cs#IClock', 'class:Infra/SystemClock.cs#SystemClock', 'unity', 'singleton', undefined],
  ]);
  // Clock is injected; the registration names it in a string, which is a possible use by name.
  const clock = edge('Orders/OrderService.cs', 'Infra/IClock.cs');
  assert.equal(clock.attrs.use_evidence, 'name-only');
  assert.equal(clock.attrs.possible_receivers, 'App/Container.cs');
  const log = edge('Orders/OrderService.cs', 'Infra/ILogger.cs');
  assert.ok(!log.attrs.declared_only && !log.attrs.use_evidence, 'Log is not named, so not injected');
});

test('unity: a property name the implementation does not declare stays unresolved', () => {
  const { edge, findings } = map({ ...INFRA, 'Orders/OrderService.cs': service(BOTH_UNREAD), 'App/Container.cs': unity('new InjectionProperty("Missing")') });
  for (const to of ['Infra/IClock.cs', 'Infra/ILogger.cs']) {
    const e = edge('Orders/OrderService.cs', to);
    assert.ok(!e.attrs.declared_only && !e.attrs.use_evidence, to);
  }
  assert.deepEqual(findings, []);
});
