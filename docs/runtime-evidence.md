# Getting runtime evidence out of a hosted observability vendor

Unknot never calls a vendor. It reads files you export and list under `evidence.traces`, `evidence.metrics` and `evidence.profiles` in `.unknot/config.yaml`. Without them, decomposition's runtime signals (chattiness, independent scaling, call coupling) stay unknown rather than zero. For call volumes, latency and errors across a boundary there is also one plain table you can import directly (see "Import table" below). This page shows how to produce those files from a hosted vendor. Vendor details were taken from the vendors' own documentation (linked per section); anything not verified is said so.

## What Unknot needs

| Need | Used for | Source |
|---|---|---|
| Which service calls which (client span to server span, `peer.service`, `http.route`) | Call coupling, cross-boundary calls per request | Traces |
| Request rate per service over time | `request_rate_p95`, `request_rate_cv` (independent scaling) | Metrics |
| Error ratio per service | Error hotspots | Metrics (or 5xx counters) or span status |
| CPU, memory, replicas per service | `cpu_cores_p95`, `memory_bytes_p95`, `replicas` | Metrics |
| Table reads and writes (`db.sql.table`, `db.statement`) | Shared-table evidence, when your instrumentation records them | Traces |

A day or a week of normal traffic is more useful than a peak hour. The service label must identify the same service in metrics and traces.

## Accepted formats

| Config key | Accepted |
|---|---|
| `traces` | OTLP JSON (`resourceSpans`), OTLP JSON Lines (one export request per line), Jaeger JSON (`{"data":[...]}`), Zipkin v2 JSON (array of spans, or array of traces) |
| `metrics` | Prometheus text exposition; Prometheus HTTP API JSON (`/api/v1/query` vector, `/api/v1/query_range` matrix); a JSON array of rows; CSV with a header |

Recognised metric names (others are ignored): `cpu_cores`, `container_cpu_usage_cores`, `memory_bytes`, `container_memory_working_set_bytes`, `process_resident_memory_bytes`, `request_rate`, `requests_per_second`, `http_requests_per_second`, `http_requests_total`, `http_server_requests_total`, `error_ratio`, `replicas`, `kube_deployment_status_replicas`, and the 5xx counters; see `adapters/runtime/metrics.mjs`. The service comes from the first of the labels `service`, `service_name`, `app`, `application`, `deployment`, `job`.

A Prometheus API response names its metric by the series' `__name__` label, else a `metric` label, else a top-level `"metric"` key you add to the saved file. Aggregations such as `sum by (service) (...)` drop `__name__`, so add the key (see below). A response with no name anywhere yields no samples; Unknot does not guess.

Span attributes are allowlisted at import; unknown attributes (often personal data) are dropped. Still strip secrets and personal data before saving: do not commit files that contain tokens, and keep query strings and user identifiers out of exports where you can.

## Import table: call volumes, latency and errors

`decompose` needs measured traffic across a boundary: how many calls cross it, how slow they are and how often they fail. The simplest way to give it that is one table, whatever produced it. Import it with:

```
unknot import runtime <file> [--source <label>] [--json]
```

The file is CSV (with a header) or JSON (an array of row objects, or `{"rows": [...]}`). An example is `tests/fixtures/runtime/import-table.csv`.

| Column | Required | Meaning |
|---|---|---|
| `caller` | yes | Who makes the call (see "Naming a caller or callee"). |
| `callee` | yes | Who receives it. |
| `operation` | no | A label such as the method or span name. Rows for the same caller and callee combine. |
| `count` | yes | Calls in the window: a non-negative integer. |
| `p95_ms` | no | 95th percentile latency in milliseconds. Empty means not measured. |
| `error_rate` | no | Failed calls as a ratio from 0 to 1 (not a percentage). Empty means not measured. |
| `window` | yes | Over what time the numbers were taken: an ISO 8601 interval `2026-09-01T00:00:00Z/2026-09-08T00:00:00Z`, or a duration (`P7D`, `PT24H`, `7d`, `24h`) that ends when you import. |

```csv
caller,callee,operation,count,p95_ms,error_rate,window
shop/orders/o0.js,shop/stock/s0.js,reserve,12000,45.5,0.012,P7D
GET /v1/orders/{id},shop/stock/s0.js,read,90,15,0,P7D
```

### Naming a caller or callee

Each side is matched onto a graph node, in this order:

1. A route template, optionally with a method: `GET /v1/orders/{id}`. `{id}`, `:id` and `<int:id>` are the same parameter, whatever it is called. It matches an endpoint or route node, else a string constant with that exact value. A route without a method that fits several methods is ambiguous and is not guessed.
2. A module path relative to the repository root: `shop/orders/o0.js`.
3. A service name. It matches a service node from imported traces or a catalog, or a name you map to code in `.unknot/config.yaml`, which also makes a service node:

   ```yaml
   adapters:
     runtime:
       service_map:
         orders-api: services/orders
   ```

4. A code symbol: `createOrder`, `Orders.create`, or `src/orders/create.ts#createOrder` when the bare name is defined in more than one place.

A row whose caller or callee matches nothing is reported and left out; it never fails the import. A row that breaks the format (a negative count, a ratio above 1, an unreadable window) refuses the whole file and stores nothing, with the first 20 problems listed.

### What is stored, and how it behaves

- Matched rows become `RUNTIME_CALLS` edges between the matched nodes (the same edge type traces produce), with `calls`, `p95_ms`, `error_rate`, the window, the source label, the import time and an expiry (the window end plus `ttl_days`, default 14). `unknot status` lists them as stale when the expiry passes, and `decompose` stops using them then. One edge holds one caller and callee pair: rows for the pair, from any source, combine as calls added, the largest p95, an error rate weighted by calls, and the span of the windows. Do not import overlapping windows of the same traffic under two sources.
- The rows are kept in the project's store and re-matched on every `unknot map`, so a re-map keeps them even when files move.
- Importing the same file again with the same source changes nothing (it says "unchanged"). A different file with the same `--source` replaces the earlier import. A different source adds to the others. The default source is the file name.
- The import command reads one file you name. The file must be inside the repository, outside `.unknot/`, and not a credential path (`.env`, keys, and so on).
- The command runs `unknot map` for you so the graph carries the rows. It says how many rows matched, how many did not, and why for the first 20 that did not.

### Exporting the table from an OpenTelemetry-compatible trace backend

Any backend that stores OpenTelemetry spans can produce this table with one aggregation: group the server-side spans by calling service, called service and route, over a window you choose, and count them. This recipe is generic; check span and attribute names against what your instrumentation emits, because they vary.

1. Choose the window, for example the last 7 days of normal traffic. Use the same start and end in the query and in the `window` column.
2. Select the spans for calls that cross a service boundary. A call is a client span (kind `CLIENT`) and the server span (kind `SERVER`) that is its child; the caller is the client span's service (`service.name` of its resource), the callee is the server span's service, and the operation is the server span's route (the `http.route` attribute, a template such as `/v1/orders/{id}`, or `rpc.method`). Spans with no parent in another service are not calls between services.
3. Group by caller, callee and route. For each group compute the span count (`count`), the 95th percentile of the server span duration in milliseconds (`p95_ms`) and the share of spans with error status or an HTTP status of 500 or above (`error_rate`, as a ratio).
4. Write the groups as CSV with the header above, putting the route template in `operation` and the interval in `window`. Name the callee as the route (`GET /v1/orders/{id}`) when you want the row matched to an endpoint, or as the callee service name when you map services to code with `service_map`.

If your backend can run SQL over exported spans (for example a trace table in a data warehouse), the query has this shape. Column names are placeholders for your schema:

```sql
SELECT
  c.service_name                                             AS caller,
  CONCAT(s.http_method, ' ', s.http_route)                   AS callee,
  s.http_route                                               AS operation,
  COUNT(*)                                                   AS count,
  APPROX_PERCENTILE(s.duration_ms, 0.95)                     AS p95_ms,
  AVG(CASE WHEN s.status = 'ERROR' OR s.http_status >= 500 THEN 1.0 ELSE 0.0 END) AS error_rate,
  '2026-09-01T00:00:00Z/2026-09-08T00:00:00Z'                AS window
FROM spans s
JOIN spans c ON c.trace_id = s.trace_id AND c.span_id = s.parent_span_id
WHERE s.kind = 'SERVER' AND c.kind = 'CLIENT'
  AND c.service_name <> s.service_name
  AND s.start_time >= TIMESTAMP '2026-09-01 00:00:00'
  AND s.start_time <  TIMESTAMP '2026-09-08 00:00:00'
GROUP BY 1, 2, 3
```

Percentile function names differ between engines (`APPROX_PERCENTILE`, `PERCENTILE_CONT`, `quantile`). If the backend exposes the same aggregation through an HTTP query API instead, run the equivalent query there and convert the result to CSV or JSON with the columns above. Sampled traces make `count` approximate: scale it by the sampling rate before importing, or say so in `--source` (for example `traces-sampled-10pct`). The export contains route templates and service names only; keep user identifiers and query strings out of it.

## Vendor-neutral recipes

### Metrics: PromQL HTTP API to a JSON file

Any PromQL-compatible endpoint returns the same response shape. Query request rate per service over a week at 5 minute resolution:

```bash
curl -sG "$PROM_URL/api/v1/query_range" \
  -H "$AUTH_HEADER" \
  --data-urlencode 'query=sum by (service) (rate(http_server_requests_total[5m]))' \
  --data-urlencode "start=$(date -u -v-7d +%s)" \
  --data-urlencode "end=$(date -u +%s)" \
  --data-urlencode 'step=300' \
  | jq '. + {metric: "request_rate"}' > .unknot/evidence/request-rate.json
```

(`date -v-7d` is BSD/macOS; on GNU use `date -u -d '7 days ago' +%s`.) `rate(...)` of a counter is already a rate, so name it `request_rate`. Add one file per quantity, for example `cpu_cores` from `sum by (service) (rate(container_cpu_usage_seconds_total[5m]))`, or `replicas`. A raw counter query that keeps `__name__` (for example `http_server_requests_total` with its `code` label) needs no `metric` key. Instant queries (`/api/v1/query`) work too but give one point, so no rate variation.

### Traces: OpenTelemetry Collector `file` exporter

If your services send OTLP to a Collector, add a second exporter to the traces pipeline, next to the vendor's. Spans then land locally in OTLP JSON Lines, one export request per line:

```yaml
exporters:
  file/unknot:
    path: /var/lib/otelcol/unknot-traces.jsonl
    format: json
    rotation: { max_megabytes: 200, max_backups: 3 }

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [file/unknot]   # add this beside your vendor exporter
```

The `file` exporter is in the Collector contrib distribution; `format` defaults to `json`, and with no compression each line is one JSON object ([README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/fileexporter/README.md)). Do not set `compression`; Unknot reads plain text. Capture for a representative period, copy the file into the repository's evidence directory, and remove the exporter afterwards if you do not want the disk usage. Add a `probabilistic_sampler` or `tail_sampling` processor to the file branch only if the volume is a problem; sampling makes call counts approximate.

### Config

```yaml
evidence:
  traces:
    - .unknot/evidence/traces.jsonl
  metrics:
    - .unknot/evidence/request-rate.json
    - .unknot/evidence/cpu-cores.json
```

Then `unknot map`; `unknot status` shows evidence as stale after its expiry, so refresh the files on a schedule.

## Vendors

### Coralogix

Metrics. Coralogix's Metrics API is PromQL compatible: `https://api.<region domain>/metrics`, with `/api/v1/query` and `/api/v1/query_range` beneath it, authenticated with `Authorization: Bearer <API key>`. The key needs the `DataQuerying` role preset or the `metrics.data-api#high:ReadData` permission ([Metrics API](https://coralogix.com/docs/user-guides/data-query/metrics-api/)). Region domains include `eu1.coralogix.com`, `eu2.coralogix.com`, `us1.coralogix.com`, `us2.coralogix.com`, `us3.coralogix.com`, `ap1.coralogix.com`, `ap2.coralogix.com`, `ap3.coralogix.com` ([domains](https://coralogix.com/docs/user-guides/account-management/account-settings/coralogix-domain/); that page lists team hostnames, so the `api.` prefix is taken from the Metrics API page's example `api.eu2.coralogix.com`).

```bash
curl -sG "https://api.<region domain>/metrics/api/v1/query_range" \
  -H "Authorization: Bearer $CX_API_KEY" \
  --data-urlencode 'query=sum by (service_name) (rate(http_server_requests_total[5m]))' \
  --data-urlencode "start=$(date -u -v-7d +%s)" --data-urlencode "end=$(date -u +%s)" \
  --data-urlencode 'step=300' \
  | jq '. + {metric: "request_rate"}' > .unknot/evidence/request-rate.json
```

Metric and label names are whatever your services send; check them in Coralogix first. The page gives no `query_range` example of its own and points to the Prometheus HTTP API for parameters.

Traces. Coralogix documents a DataPrime query API (`POST https://api.<region domain>/api/v1/dataprime/query`, bearer key, body `{"query": "source spans | limit 100"}`; [docs](https://coralogix.com/docs/dataprime/API/direct-archive-query-http-api/)). Its results are Coralogix rows, not OTLP, Jaeger or Zipkin, and no converter is provided here, so they are not importable as they are. Use the Collector recipe above and add `file/unknot` beside the Coralogix exporter.

### Datadog

Metrics. `GET /api/v1/query` on your site's API host takes `from`, `to` (seconds) and `query` ([docs](https://docs.datadoghq.com/api/latest/metrics/query-timeseries-points/)). It uses Datadog query syntax, not PromQL, and returns `series[].pointlist` of `[ms, value]`, which Unknot does not read directly; convert with `jq` to the accepted JSON rows. The documented site list (for example `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`, `us5.datadoghq.com`, `ap1.datadoghq.com`) names the app host; the API host is `api.<site>`, per the page's `api.datadoghq.com` example. Authentication: `DD-API-KEY` and `DD-APPLICATION-KEY` headers (the page's own sample shows a bearer token form; check which your organization uses). Put the metric you want in the query; the one below is a placeholder, use your own request-hit metric.

```bash
curl -sG "https://api.<site>/api/v1/query" \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  --data-urlencode "from=$(date -u -v-7d +%s)" --data-urlencode "to=$(date -u +%s)" \
  --data-urlencode 'query=sum:<your.request.hits.metric>{*} by {service}.as_rate()' \
  | jq '[.series[] | {service: (.scope | capture("service:(?<s>[^,]+)").s)} as $l
         | .pointlist[] | {metric: "request_rate", value: .[1], timestamp: .[0], labels: $l}]' \
  > .unknot/evidence/request-rate.json
```

Traces. Not verified: Datadog's span-search API output is Datadog's own format, so it is not importable as is. Send OTLP through a Collector with the `file` exporter alongside the Datadog exporter.

### Grafana Cloud

Metrics. Grafana Cloud Metrics (Mimir) serves the Prometheus HTTP API. Use HTTP basic auth, user = your metrics instance ID, password = a Cloud Access Policy token; copy the query endpoint and instance ID from the Prometheus card in the Cloud Portal ([docs](https://grafana.com/docs/grafana-cloud/send-data/metrics/metrics-prometheus/query-http-api/)). The docs show `/api/v1/query` appended to that endpoint; `query_range` is the same Prometheus API on the same base (no separate example in that page).

```bash
curl -sG -u "$METRICS_INSTANCE_ID:$GC_TOKEN" "<query endpoint>/api/v1/query_range" \
  --data-urlencode 'query=sum by (service) (rate(http_server_requests_total[5m]))' \
  --data-urlencode "start=$(date -u -v-7d +%s)" --data-urlencode "end=$(date -u +%s)" \
  --data-urlencode 'step=300' \
  | jq '. + {metric: "request_rate"}' > .unknot/evidence/request-rate.json
```

Traces. Tempo's `GET /api/v2/traces/<traceid>` returns OTLP JSON by default ([docs](https://grafana.com/docs/tempo/latest/api_docs/)), one trace per call, and `/api/search` (TraceQL `q`, `start`, `end`, `limit`) lists trace IDs. Fetching many traces is possible but I did not verify the Grafana Cloud trace host or auth form; for volume, prefer the Collector recipe. Each response is one trace; the importer reads one OTLP document per file or one per line, so check that the saved JSON has `resourceSpans` at its top level (I did not verify whether the v2 response nests it) before listing it.

### Honeycomb

Metrics and traces. The Query Results API returns aggregated query results, not spans, and is not Prometheus-shaped ([docs](https://docs.honeycomb.io/api/query-results)): `POST /1/query_results/{datasetSlug}` with the `X-Honeycomb-Team` key (needs "Manage Queries and Columns" and "Run Queries"), results polled by ID, data from the past 7 days, rate limited. Its output is not an accepted format, and I did not verify a span-export API. Use the Collector recipe with `file/unknot` beside the Honeycomb exporter for traces, and derive request rates from your Prometheus-compatible store if you have one.

## Checklist before saving

- Strip personal data and secrets: no API keys in files or shell history committed to the repository; no user identifiers in span attributes you added; exports of `db.statement` are redacted by Unknot at import but not at rest, so check the raw file.
- Keep files outside version control if they are large; evidence paths must stay inside the repository and must not have credential-like names.
- Re-export on a schedule; imported facts expire.
