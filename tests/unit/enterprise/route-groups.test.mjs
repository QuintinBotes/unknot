// One rule for route groups in every language: a group is created with a prefix (from the app or
// another group), held in a variable or chained directly, and the routes registered on it join
// every prefix up the chain. A group handed to a function in the repository that registers on its
// parameter is followed; a prefix that cannot be resolved keeps the endpoint and says so. Each row
// is one spelling; the same cases run for all of them, and a workspace map of the service with a
// client that declares the full routes links every client route.

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
const { mapRepository } = await import('../../../runtime/graph/builder.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

const ROUTES = ['GET /v1/orders/:id', 'POST /v1/orders'];

const ROWS = [
  {
    name: 'C# minimal API: MapGroup',
    grouped: {
      'src/Program.cs': `var app = builder.Build();
var v1 = app.MapGroup("/v1");
v1.MapGet("/orders/{id}", (string id) => id);
v1.MapPost("/orders", () => 1);
`,
    },
    nested: {
      'src/Program.cs': `var app = builder.Build();
var api = app.MapGroup("/a").MapGroup("/b");
api.MapGet("/x", () => 1);
app.MapGroup("/c").MapGroup("/d").MapGet("/y", () => 1);
`,
    },
    nestedRoutes: ['GET /a/b/x', 'GET /c/d/y'],
    crossFile: {
      'src/Program.cs': `var app = builder.Build();
var v1 = app.MapGroup("/v1");
v1.MapOrders();
`,
      'src/OrdersEndpoints.cs': `public static class OrdersEndpoints
{
    public static void MapOrders(this IEndpointRouteBuilder app)
    {
        app.MapGet("/orders/{id}", (string id) => id);
        app.MapPost("/orders", () => 1);
    }
}
`,
    },
    unresolved: {
      'src/LooseEndpoints.cs': `public static class LooseEndpoints
{
    public static void MapLoose(this IEndpointRouteBuilder app)
    {
        app.MapGet("/loose", () => 1);
    }
}
`,
    },
    computed: {
      'src/Program.cs': `var app = builder.Build();
var g = app.MapGroup(settings.Prefix);
g.MapGet("/computed", () => 1);
`,
    },
  },
  {
    name: 'Express: Router and app.use',
    grouped: {
      'src/app.js': `const express = require('express');
const app = express();
const r = express.Router();
r.get('/orders/:id', h);
r.post('/orders', h);
app.use('/v1', r);
`,
    },
    nested: {
      'src/app.js': `const express = require('express');
const app = express();
const outer = express.Router();
const inner = express.Router();
inner.get('/x', h);
outer.use('/b', inner);
app.use('/a', outer);
`,
    },
    nestedRoutes: ['GET /a/b/x'],
    crossFile: {
      'src/app.js': `const express = require('express');
const { registerOrders } = require('./orders');
const app = express();
const v1 = express.Router();
registerOrders(v1);
app.use('/v1', v1);
`,
      'src/orders.js': `exports.registerOrders = function registerOrders(r) {
  r.get('/orders/:id', h);
  r.post('/orders', h);
};
`,
    },
    imported: {
      'src/app.js': `const express = require('express');
const orders = require('./orders');
const app = express();
app.use('/v1', orders);
`,
      'src/orders.js': `const express = require('express');
const router = express.Router();
router.get('/orders/:id', h);
router.post('/orders', h);
module.exports = router;
`,
    },
    unresolved: {
      'src/loose.js': `export function registerLoose(r) {
  r.get('/loose', h);
}
`,
    },
  },
  {
    name: 'Go chi: Route',
    grouped: {
      'main.go': `package main

func main() {
	r := chi.NewRouter()
	r.Route("/v1", func(r chi.Router) {
		r.Get("/orders/{id}", getOrder)
		r.Post("/orders", createOrder)
	})
}
`,
    },
    nested: {
      'main.go': `package main

func main() {
	r := chi.NewRouter()
	r.Route("/a", func(r chi.Router) {
		r.Route("/b", func(r chi.Router) {
			r.Get("/x", h)
		})
	})
}
`,
    },
    nestedRoutes: ['GET /a/b/x'],
    crossFile: {
      'main.go': `package main

func main() {
	r := chi.NewRouter()
	r.Route("/v1", func(r chi.Router) {
		registerOrders(r)
	})
}
`,
      'orders.go': `package main

func registerOrders(r chi.Router) {
	r.Get("/orders/{id}", getOrder)
	r.Post("/orders", createOrder)
}
`,
    },
    unresolved: {
      'loose.go': `package main

func registerLoose(r chi.Router) {
	r.Get("/loose", h)
}
`,
    },
  },
  {
    name: 'Go gin: Group',
    grouped: {
      'main.go': `package main

func main() {
	r := gin.New()
	g := r.Group("/v1")
	g.GET("/orders/:id", getOrder)
	g.POST("/orders", createOrder)
}
`,
    },
    nested: {
      'main.go': `package main

func main() {
	r := gin.New()
	g := r.Group("/a").Group("/b")
	g.GET("/x", h)
	r.Group("/c").Group("/d").GET("/y", h)
}
`,
    },
    nestedRoutes: ['GET /a/b/x', 'GET /c/d/y'],
    crossFile: {
      'main.go': `package main

func main() {
	r := gin.New()
	g := r.Group("/v1")
	registerOrders(g)
}
`,
      'orders.go': `package main

func registerOrders(g *gin.RouterGroup) {
	g.GET("/orders/:id", getOrder)
	g.POST("/orders", createOrder)
}
`,
    },
    unresolved: {
      'loose.go': `package main

func registerLoose(g *gin.RouterGroup) {
	g.GET("/loose", h)
}
`,
    },
  },
  {
    name: 'Python FastAPI: APIRouter and include_router',
    grouped: {
      'app/main.py': `from fastapi import FastAPI, APIRouter

app = FastAPI()
router = APIRouter(prefix="/orders")


@router.get("/{id}")
def get_order(id): ...


@router.post("")
def create_order(): ...


app.include_router(router, prefix="/v1")
`,
    },
    nested: {
      'app/main.py': `from fastapi import FastAPI, APIRouter

app = FastAPI()
parent = APIRouter(prefix="/a")
child = APIRouter(prefix="/b")


@child.get("/x")
def one(): ...


parent.include_router(child)
app.include_router(parent)
`,
    },
    nestedRoutes: ['GET /a/b/x'],
    crossFile: {
      'app/main.py': `from fastapi import FastAPI, APIRouter
from .orders import register

app = FastAPI()
router = APIRouter(prefix="/v1")
register(router)
app.include_router(router)
`,
      'app/orders.py': `def register(r):
    @r.get("/orders/{id}")
    def get_order(id): ...

    @r.post("/orders")
    def create_order(): ...
`,
    },
    imported: {
      'app/main.py': `from fastapi import FastAPI
from .routers import orders

app = FastAPI()
app.include_router(orders.router, prefix="/v1")
`,
      'app/routers/orders.py': `from fastapi import APIRouter

router = APIRouter(prefix="/orders")


@router.get("/{id}")
def get_order(id): ...


@router.post("")
def create_order(): ...
`,
    },
    unresolved: {
      'app/loose.py': `def register_loose(r):
    @r.get("/loose")
    def loose(): ...
`,
    },
    computed: {
      'app/main.py': `from fastapi import FastAPI, APIRouter

app = FastAPI()
router = APIRouter(prefix=settings.PREFIX)


@router.get("/computed")
def computed(): ...
`,
    },
  },
  {
    name: 'Python Flask: Blueprint url_prefix',
    grouped: {
      'app/main.py': `from flask import Flask, Blueprint

app = Flask(__name__)
bp = Blueprint("orders", __name__, url_prefix="/v1")


@bp.route("/orders/<id>")
def get_order(id): ...


@bp.post("/orders")
def create_order(): ...


app.register_blueprint(bp)
`,
    },
    nested: {
      'app/main.py': `from flask import Flask, Blueprint

app = Flask(__name__)
parent = Blueprint("parent", __name__, url_prefix="/a")
child = Blueprint("child", __name__, url_prefix="/b")


@child.route("/x")
def one(): ...


parent.register_blueprint(child)
app.register_blueprint(parent)
`,
    },
    nestedRoutes: ['GET /a/b/x'],
    crossFile: {
      'app/main.py': `from flask import Flask, Blueprint
from .orders import register

app = Flask(__name__)
bp = Blueprint("orders", __name__, url_prefix="/v1")
register(bp)
app.register_blueprint(bp)
`,
      'app/orders.py': `def register(b):
    @b.route("/orders/<id>")
    def get_order(id): ...

    @b.post("/orders")
    def create_order(): ...
`,
    },
    unresolved: {
      'app/loose.py': `def register_loose(b):
    @b.route("/loose")
    def loose(): ...
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
  return dir;
}

async function endpointsOf(files) {
  const parent = mkdtempSync(join(tmpdir(), 'uk-grp-'));
  const dir = repo(parent, 'svc', files);
  const ctx = openProject(dir, { create: true });
  const cfg = loadConfig(ctx);
  await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, history: false });
  return Graph.fromStore(ctx.store).nodes('endpoint').map((n) => ({ name: n.name, unresolved: n.attrs.prefix_unresolved === true, attrs: n.attrs })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

const names = (list) => list.map((e) => e.name);

for (const row of ROWS) {
  test(`${row.name}: the group prefix joins every route registered on it`, { timeout: 120_000 }, async () => {
    const found = await endpointsOf(row.grouped);
    assert.deepEqual(names(found), ROUTES);
    assert.ok(found.every((e) => !e.unresolved), 'a resolved prefix is not flagged');
  });

  test(`${row.name}: nested groups join both prefixes`, { timeout: 120_000 }, async () => {
    assert.deepEqual(names(await endpointsOf(row.nested)), row.nestedRoutes);
  });

  test(`${row.name}: a group handed to a registration function in another file is joined`, { timeout: 120_000 }, async () => {
    const found = await endpointsOf(row.crossFile);
    assert.deepEqual(names(found), ROUTES);
    assert.ok(found.every((e) => !e.unresolved));
    assert.ok(found.every((e) => e.attrs.route_group === undefined), 'link-only attributes are not persisted');
  });

  test(`${row.name}: a group nobody hands to the registration function keeps the endpoint and says the prefix is unresolved`, { timeout: 120_000 }, async () => {
    const found = await endpointsOf(row.unresolved);
    assert.deepEqual(names(found), ['GET /loose']);
    assert.equal(found[0].unresolved, true);
  });

  if (row.imported) {
    test(`${row.name}: a group another file mounts takes the mount's prefix`, { timeout: 120_000 }, async () => {
      assert.deepEqual(names(await endpointsOf(row.imported)), ROUTES);
    });
  }

  if (row.computed) {
    test(`${row.name}: a prefix that is not a literal is flagged, the route is kept`, { timeout: 120_000 }, async () => {
      const found = await endpointsOf(row.computed);
      assert.deepEqual(names(found), ['GET /computed']);
      assert.equal(found[0].unresolved, true);
    });
  }

  test(`${row.name}: a workspace map links every client route to the grouped endpoint`, { timeout: 180_000 }, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'uk-grp-ws-'));
    repo(parent, 'app', {
      'src/Clients/IOrdersApi.cs': `using System.Threading.Tasks;
namespace Shop.Clients
{
    public interface IOrdersApi
    {
        [Get("/v1/orders/{id}")]
        Task<OrderDto> GetAsync(string id);

        [Post("/v1/orders")]
        Task<OrderDto> CreateAsync([Body] OrderDto order);
    }
    public class OrderDto { public string Id { get; set; } }
}
`,
    });
    repo(parent, 'svc', row.grouped);
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
    assert.deepEqual(g.nodes('endpoint').filter((n) => n.id.startsWith('endpoint:svc:')).map((n) => n.name).sort(), ROUTES);
    assert.equal(r.analysis.client_operations.total, 2);
    assert.equal(r.analysis.client_operations.linked, 2);
    assert.deepEqual(r.analysis.client_operations.unmatched, []);
  });
}
