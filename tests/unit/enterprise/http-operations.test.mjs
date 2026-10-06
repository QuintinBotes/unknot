// One rule for HTTP operations in every language: a method that declares an HTTP method and a
// route through an attribute, annotation or decorator is an operation; on an interface or abstract
// type it is a client's (a `contract` the module consumes), on a concrete handler an endpoint.
// Each row is a client interface with a base path and a matching server in another repository;
// a workspace map must link every client operation to the endpoint that serves it.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../../runtime/context.mjs');
const { loadConfig } = await import('../../../runtime/policy/config.mjs');
const { stringifyYAML } = await import('../../../runtime/core/yaml.mjs');
const { graphFromDocument, loadWorkspaceGraph, mapWorkspace } = await import('../../../runtime/enterprise/workspace.mjs');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

const CLIENT_ROUTES = ['GET /v1/orders/:id', 'POST /v1/orders'];
const SERVER_ROUTES = ['GET /v1/orders/:orderId', 'POST /v1/orders'];

const CSHARP_CLIENT = {
  'src/Clients/IOrdersApi.cs': `using System.Threading.Tasks;
namespace Shop.Clients
{
    [Route("v1")]
    public interface IOrdersApi
    {
        [Get("orders/{id}")]
        Task<OrderDto> GetAsync(string id);

        [Post("orders")]
        Task<OrderDto> CreateAsync([Body] OrderDto order);
    }
    public class OrderDto { public string Id { get; set; } }
}
`,
};

const ROWS = [
  {
    lang: 'C#',
    client: CSHARP_CLIENT,
    server: {
      'src/Api/OrdersController.cs': `using Microsoft.AspNetCore.Mvc;
namespace Billing.Api
{
    [Route("v1/orders")]
    public class OrdersController : ControllerBase
    {
        [HttpGet("{orderId}")]
        public IActionResult Get(string orderId) { return Ok(); }

        [HttpPost]
        public IActionResult Create() { return Ok(); }
    }
}
`,
    },
  },
  {
    lang: 'Java',
    client: {
      'src/main/java/shop/OrdersClient.java': `package shop;
@RequestMapping("/v1")
public interface OrdersClient {
  @GetMapping("/orders/{id}")
  Order get(@PathVariable("id") String id);
  @RequestLine("POST /orders")
  Order create(Order o);
}
`,
    },
    server: {
      'src/main/java/billing/OrdersController.java': `package billing;
@RequestMapping("/v1")
public class OrdersController {
  @GetMapping("/orders/{orderId}")
  public String get(@PathVariable String orderId) { return ""; }
  @PostMapping("/orders")
  public String create() { return ""; }
}
`,
    },
  },
  {
    lang: 'Kotlin',
    client: {
      'src/main/kotlin/shop/OrdersClient.kt': `package shop
@RequestMapping("/v1")
interface OrdersClient {
    @GET("orders/{id}")
    suspend fun get(@Path("id") id: String): Order
    @POST("orders")
    suspend fun create(@Body o: Order): Order
}
`,
    },
    server: {
      'src/main/kotlin/billing/OrdersController.kt': `package billing
@RestController
@RequestMapping("/v1")
class OrdersController {
    @GetMapping("/orders/{orderId}")
    fun get(@PathVariable orderId: String): String { return orderId }
    @PostMapping("/orders")
    fun create(): String { return "" }
}
`,
    },
  },
  {
    lang: 'TypeScript',
    client: {
      'src/orders-client.ts': `@Controller('v1')
export abstract class OrdersClient {
  @Get('orders/:id')
  abstract get(id: string): Promise<Order>;

  @Post('orders')
  abstract create(order: Order): Promise<Order>;
}
`,
    },
    server: {
      'src/orders.controller.ts': `@Controller('v1')
export class OrdersController {
  @Get('orders/:orderId')
  one(orderId: string) { return orderId; }

  @Post('orders')
  create() { return null; }
}
`,
    },
  },
  {
    lang: 'Python',
    client: {
      'shop/orders_client.py': `from typing import Protocol


@client("/v1")
class OrdersApi(Protocol):
    @get("orders/{id}")
    def get(self, id: str) -> dict: ...

    @post("orders")
    def create(self, order: dict) -> dict: ...
`,
    },
    server: {
      'billing/orders.py': `from fastapi import APIRouter

router = APIRouter(prefix="/v1")


@router.get("/orders/{orderId}")
def get_order(orderId: str):
    return {"id": orderId}


@router.post("/orders")
def create_order():
    return {}
`,
    },
  },
  {
    lang: 'Go (server only; the client is C#)',
    client: CSHARP_CLIENT,
    server: {
      'billing/main.go': `package main

import "net/http"

func getOrder(w http.ResponseWriter, r *http.Request) {}

func createOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		return
	}
}

func main() {
	r := chi.NewRouter()
	r.Get("/v1/orders/{orderId}", getOrder)
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/orders", createOrder)
}
`,
    },
  },
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
}

for (const row of ROWS) {
  test(`${row.lang}: a client interface and a server endpoint declare the same route and a workspace map links them`, { timeout: 120_000 }, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'uk-ops-'));
    repo(parent, 'app', row.client);
    repo(parent, 'svc', row.server);
    const root = join(parent, 'platform');
    mkdirSync(join(root, '.unknot'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'workspace root\n');
    git(parent, 'init', '-q', 'platform');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    writeFileSync(join(root, '.unknot/config.yaml'), stringifyYAML({ version: 1, mode: 'plan', workspace: { repositories: [{ name: 'app', path: '../app' }, { name: 'svc', path: '../svc' }] } }));
    const ctx = openProject(root, { create: true });
    const cfg = loadConfig(ctx);
    const r = await mapWorkspace(ctx, { config: cfg.config, history: false });
    const g = graphFromDocument(loadWorkspaceGraph(ctx));

    // The base path of the type is joined to each method's route, on the client and on the server.
    const clientOps = g.nodes('contract').filter((n) => n.attrs?.kind === 'client_operation' && n.id.startsWith('contract:app:')).map((n) => `${n.attrs.method} ${n.attrs.path}`).sort();
    assert.deepEqual(clientOps, CLIENT_ROUTES);
    const endpoints = g.nodes('endpoint').filter((n) => n.id.startsWith('endpoint:svc:')).map((n) => n.name).sort();
    assert.deepEqual(endpoints, SERVER_ROUTES);

    // The client interface is one contract, declared and consumed by its module.
    const ifaces = g.nodes('contract').filter((n) => n.attrs?.kind === 'http_client' && n.id.startsWith('contract:app:'));
    assert.equal(ifaces.length, 1);
    assert.deepEqual(ifaces[0].attrs.operations.map((o) => `${o.method} ${o.path}`).sort(), CLIENT_ROUTES);
    assert.ok(g.edges('CONSUMES').some((e) => e.from.startsWith('module:app:') && e.to.startsWith('contract:app:')), 'the declaring module consumes its routes');

    // Every client operation is linked to the endpoint that serves it in the other repository.
    const link = (from, to) => g.edges('CONSUMES').find((e) => e.from === from && e.to === to && e.attrs.cross_repo && e.attrs.via === 'contract');
    assert.ok(link('contract:app:GET /v1/orders/:id', 'endpoint:svc:GET /v1/orders/:orderId'), 'GET links by path template');
    assert.ok(link('contract:app:POST /v1/orders', 'endpoint:svc:POST /v1/orders'), 'POST links');
    assert.equal(r.analysis.client_operations.total, 2);
    assert.equal(r.analysis.client_operations.linked, 2);
    assert.deepEqual(r.analysis.client_operations.unmatched, []);
  });
}

test('a controller is not a client, an interface with no route is not an operation, a bare verb needs a route', async () => {
  const { default: generic } = await import('../../../adapters/language/generic/index.mjs');
  const facts = generic.extract({ path: 'src/Mixed.java' }, `
interface Resource { @GET @Path("x") String g(); }
interface Plain { void run(); }
abstract class Base {
  @GetMapping("/abstract/{id}") abstract String one(String id);
  @GetMapping("/concrete") String two() { return ""; }
}
`, {});
  const clients = facts.filter((f) => f.type === 'contract' && f.attrs.kind === 'http_client');
  assert.deepEqual(clients.map((c) => [c.name, c.attrs.operations.map((o) => `${o.method} ${o.path}`)]), [['Base', ['GET /abstract/:id']]]);
  assert.deepEqual(facts.filter((f) => f.type === 'endpoint').map((f) => f.id), ['endpoint:GET /concrete']);
});

// An interface a concrete type in the repository implements is a server-side API declaration: its
// routes are endpoints served by the implementer. Without an implementer it is a client.
const { mapRepository } = await import('../../../runtime/graph/builder.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');

const IMPLEMENTED = [
  {
    lang: 'Java',
    api: { 'src/main/java/shop/OrdersApi.java': 'package shop;\n@RequestMapping("/v1")\npublic interface OrdersApi {\n  @GetMapping("/orders/{id}")\n  String get(String id);\n  @PostMapping("/orders")\n  String create();\n}\n' },
    impl: { 'src/main/java/shop/OrdersController.java': 'package shop;\npublic class OrdersController implements OrdersApi {\n  public String get(String id) { return id; }\n  public String create() { return ""; }\n}\n' },
    owns: { 'src/main/java/shop/OrdersController.java': 'package shop;\npublic class OrdersController implements OrdersApi {\n  @GetMapping("/own/{id}")\n  public String get(String id) { return id; }\n  public String create() { return ""; }\n}\n' },
  },
  {
    lang: 'C#',
    api: { 'src/IOrdersApi.cs': 'namespace Shop {\n  [Route("v1")]\n  public interface IOrdersApi {\n    [Get("orders/{id}")]\n    string Get(string id);\n    [Post("orders")]\n    string Create();\n  }\n}\n' },
    impl: { 'src/OrdersController.cs': 'namespace Shop {\n  public class OrdersController : IOrdersApi {\n    public string Get(string id) { return id; }\n    public string Create() { return ""; }\n  }\n}\n' },
    owns: { 'src/OrdersController.cs': 'namespace Shop {\n  public class OrdersController : IOrdersApi {\n    [HttpGet("/own/{id}")]\n    public string Get(string id) { return id; }\n    public string Create() { return ""; }\n  }\n}\n' },
  },
  {
    lang: 'TypeScript',
    api: { 'src/orders-api.ts': "@Controller('v1')\nexport abstract class OrdersApi {\n  @Get('orders/:id')\n  abstract get(id: string): string;\n  @Post('orders')\n  abstract create(): string;\n}\n" },
    impl: { 'src/orders.controller.ts': "import { OrdersApi } from './orders-api';\nexport class OrdersController extends OrdersApi {\n  get(id: string) { return id; }\n  create() { return ''; }\n}\n" },
    owns: { 'src/orders.controller.ts': "import { OrdersApi } from './orders-api';\nexport class OrdersController extends OrdersApi {\n  @Get('/own/:id')\n  get(id: string) { return id; }\n  create() { return ''; }\n}\n" },
  },
];

async function mapped(dir) {
  const ctx = openProject(dir, { create: true });
  const cfg = loadConfig(ctx);
  await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, history: false });
  return Graph.fromStore(ctx.store);
}

const routesOf = (g) => ({
  clients: g.nodes('contract').filter((n) => n.attrs?.kind === 'client_operation').map((n) => n.name).sort(),
  interfaces: g.nodes('contract').filter((n) => n.attrs?.kind === 'http_client').length,
  endpoints: g.nodes('endpoint').map((n) => n.name).sort(),
  consumes: g.edges('CONSUMES').filter((e) => e.to.startsWith('contract:')).length,
});

for (const row of IMPLEMENTED) {
  test(`${row.lang}: an interface with an implementer in the repository serves endpoints; without one it is a client`, { timeout: 120_000 }, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'uk-impl-'));
    repo(parent, 'alone', row.api);
    const client = routesOf(await mapped(join(parent, 'alone')));
    assert.deepEqual(client.clients, CLIENT_ROUTES);
    assert.equal(client.interfaces, 1);
    assert.deepEqual(client.endpoints, []);

    repo(parent, 'served', { ...row.api, ...row.impl });
    const served = routesOf(await mapped(join(parent, 'served')));
    assert.deepEqual(served.endpoints, ['GET /v1/orders/:id', 'POST /v1/orders']);
    assert.deepEqual(served.clients, []);
    assert.equal(served.interfaces, 0);
    assert.equal(served.consumes, 0, 'no CONSUMES client facts');

    // The implementer's own markers win for the methods that have them.
    repo(parent, 'own', { ...row.api, ...row.owns });
    const own = routesOf(await mapped(join(parent, 'own')));
    assert.ok(own.endpoints.includes('GET /own/:id'));
    assert.ok(!own.endpoints.includes('GET /v1/orders/:id'));
    assert.ok(own.endpoints.includes('POST /v1/orders'));
  });
}
