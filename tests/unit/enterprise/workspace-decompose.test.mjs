// Cross-repository clients and endpoints count for a decomposition run inside one repository:
// a workspace map records the workspace in each member's store, and decompose reads its links.

import '../../helpers/git-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { mkTmp } from '../../helpers/tmp.mjs';

process.env.UNKNOT_HOME = mkTmp(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../../runtime/context.mjs');
const { loadConfig } = await import('../../../runtime/policy/config.mjs');
const { stringifyYAML } = await import('../../../runtime/core/yaml.mjs');
const { mapWorkspace, workspaceLinks } = await import('../../../runtime/enterprise/workspace.mjs');
const { mapRepository } = await import('../../../runtime/graph/builder.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { boundaryMetrics } = await import('../../../runtime/decompose/candidates.mjs');
const { decompose } = await import('../../../runtime/decompose/index.mjs');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

const NAMES = ['a1', 'a2', 'a3', 'a4'];
const group = (extra) => Object.fromEntries([...NAMES, ...extra].map((n) => [`src/orders/${n}.ts`, `${[...NAMES, ...extra].filter((m) => m !== n).map((m) => `import { f_${m} } from './${m}';`).join('\n')}\nexport function f_${n}() { return 1; }\n`]));

const CLIENT = `@Controller('v1')
export abstract class OrdersClient {
  @Get('orders/:id')
  abstract get(id: string): Promise<Order>;

  @Post('orders')
  abstract create(order: Order): Promise<Order>;
}
`;
const SERVER = `@Controller('v1')
export class OrdersController {
  @Get('orders/:orderId')
  one(orderId: string) { return orderId; }

  @Post('orders')
  create() { return null; }
}
`;
const OTHER = { 'src/billing/x.ts': 'export const x = 1;\n' };
const tsOrders = (name, body) => ({ ...group([name]), [`src/orders/${name}.ts`]: `${NAMES.map((m) => `import { f_${m} } from './${m}';`).join('\n')}\n${body}`, ...OTHER });

const REFIT = {
  'src/Orders/IOrdersApi.cs': `using Refit;
namespace Shop.Orders
{
    public interface IOrdersApi
    {
        [Get("/orders/{id}")]
        Task<OrderDto> GetAsync(string id);
    }
}
`,
  'src/Orders/OrderDto.cs': `namespace Shop.Orders
{
    public class OrderDto { public string Id { get; set; } }
}
`,
  'src/Orders/OrderService.cs': `namespace Shop.Orders
{
    public class OrderService
    {
        private readonly IOrdersApi _api;
        public OrderService(IOrdersApi api) { _api = api; }
        public async Task<OrderDto> Load(string id) { return await _api.GetAsync(id); }
    }
}
`,
  'src/Billing/Invoice.cs': 'namespace Shop.Billing\n{\n    public class Invoice { public int Total { get; set; } }\n}\n',
};
const JAVA = 'src/main/java/com/shop';
const SPRING = {
  [`${JAVA}/orders/OrdersController.java`]: `package com.shop.orders;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrdersController {
    private final OrderRepository repo;
    public OrdersController(OrderRepository repo) { this.repo = repo; }

    @GetMapping("/{id}")
    public Order get(@PathVariable String id) { return repo.find(id); }
}
`,
  [`${JAVA}/orders/OrderRepository.java`]: 'package com.shop.orders;\n\npublic class OrderRepository {\n    public Order find(String id) { return new Order(id); }\n}\n',
  [`${JAVA}/orders/Order.java`]: 'package com.shop.orders;\n\npublic class Order {\n    public final String id;\n    public Order(String id) { this.id = id; }\n}\n',
  [`${JAVA}/billing/Invoice.java`]: 'package com.shop.billing;\n\npublic class Invoice { public int total; }\n',
};

/** Each language pair: the consumer (`app`) and provider (`svc`) files, the module prefix of the orders candidate in each, and the routes they share. */
const PAIRS = [
  { name: 'TypeScript client, TypeScript server', app: tsOrders('orders-client', CLIENT), svc: tsOrders('orders-controller', SERVER), appModules: 'module:src/orders/', svcModules: 'module:src/orders/', routes: ['GET /v1/orders/:', 'POST /v1/orders'] },
  { name: 'C# Refit client, Java Spring server', app: REFIT, svc: SPRING, appModules: 'module:src/Orders/', svcModules: `module:${JAVA}/orders/`, routes: ['GET /orders/:'] },
];

function repo(parent, name, files) {
  const dir = join(parent, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(parent, 'init', '-q', name);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

async function fixture(pair) {
  const parent = mkTmp(join(tmpdir(), 'uk-wsd-'));
  const appDir = repo(parent, 'app', pair.app);
  const svcDir = repo(parent, 'svc', pair.svc);
  const alone = repo(parent, 'alone', pair.svc);
  const root = join(parent, 'platform');
  mkdirSync(join(root, '.unknot'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'workspace root\n');
  git(parent, 'init', '-q', 'platform');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  writeFileSync(join(root, '.unknot/config.yaml'), stringifyYAML({ version: 1, mode: 'plan', workspace: { repositories: [{ name: 'app', path: '../app' }, { name: 'svc', path: '../svc' }] } }));
  const ctx = openProject(root, { create: true });
  await mapWorkspace(ctx, { config: loadConfig(ctx).config, history: false });
  return { appDir, svcDir, alone };
}

async function candidates(dir, prefix, { map = false } = {}) {
  const ctx = openProject(dir, { create: true });
  const cfg = loadConfig(ctx);
  if (map) await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, history: false });
  // The measured boundary of the orders modules, and the record decompose writes for them.
  const graph = Graph.fromStore(ctx.store);
  const members = graph.nodes('module').map((n) => n.id).filter((id) => id.startsWith(prefix));
  const measured = boundaryMetrics(graph, new Set(members), { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: 0, workspace: workspaceLinks(ctx) });
  const out = await decompose(ctx, { config: cfg.config, dryRun: true });
  const record = out.details.find((r) => r.candidate.modules.some((m) => m.startsWith(prefix)));
  return { measured, record };
}

for (const pair of PAIRS) {
  test(`${pair.name}: after a workspace map, the repository that serves a route lists the repository that calls it`, { timeout: 180_000 }, async () => {
    const { svcDir } = await fixture(pair);
    const { measured, record } = await candidates(svcDir, pair.svcModules);
    assert.equal(measured.metrics['contracts.present'], 1);
    assert.equal(measured.metrics['clients.count'], 1);
    const routes = record.candidate.contracts;
    assert.deepEqual(routes.map((r) => r.route), pair.routes);
    for (const r of routes) {
      assert.deepEqual(r.client_repositories, ['app']);
      assert.equal(r.clients, 1);
      assert.ok(r.workspace_mapped_at);
    }
    assert.equal(record.candidate.workspace.stale, false);
    assert.ok(!record.evidence_gaps.some((g) => /stale cross-repository/.test(g)));
    // The handler the caller reaches is the seam, however deep in the module it is declared.
    assert.equal(measured.metrics['requests.interceptable'], 1);
    assert.ok(!record.evidence_gaps.some((g) => /no routable seam/.test(g)), JSON.stringify(record.evidence_gaps));
  });

  test(`${pair.name}: the repository that calls a route names the repository that serves it`, { timeout: 180_000 }, async () => {
    const { appDir } = await fixture(pair);
    const { measured, record } = await candidates(appDir, pair.appModules);
    assert.equal(measured.metrics['contracts.present'], 1);
    for (const route of pair.routes) assert.ok(record.candidate.contracts.some((r) => r.route === route), route);
    for (const r of record.candidate.contracts) assert.deepEqual(r.served_by, ['svc']);
  });

  test(`${pair.name}: a repository mapped again after the workspace map says its cross-repository evidence is stale`, { timeout: 180_000 }, async () => {
    const { svcDir } = await fixture(pair);
    const { measured, record } = await candidates(svcDir, pair.svcModules, { map: true });
    assert.equal(record.candidate.workspace.stale, true);
    assert.ok(record.evidence_gaps.some((g) => /stale cross-repository evidence/.test(g)), JSON.stringify(record.evidence_gaps));
    assert.ok(measured.gaps.some((g) => /stale cross-repository evidence/.test(g)));
    assert.equal(measured.metrics['contracts.present'], 1);
  });

  test(`${pair.name}: a project outside any workspace is unchanged`, { timeout: 180_000 }, async () => {
    const { alone } = await fixture(pair);
    const { measured, record } = await candidates(alone, pair.svcModules, { map: true });
    assert.equal(record.candidate.workspace, undefined);
    assert.ok(!(record.candidate.contracts ?? []).some((r) => r.workspace_mapped_at));
    assert.ok(!record.evidence_gaps.some((g) => /cross-repository/.test(g)));
    assert.equal(measured.metrics['clients.count'], undefined);
  });
}
