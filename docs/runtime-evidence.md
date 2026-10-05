# Getting runtime evidence out of a hosted observability vendor

Unknot never calls a vendor. It reads files you export and list under `evidence.traces`, `evidence.metrics` and `evidence.profiles` in `.unknot/config.yaml`. Without them, decomposition's runtime signals (chattiness, independent scaling, call coupling) stay unknown rather than zero. This page shows how to produce those files from a hosted vendor. Vendor details were taken from the vendors' own documentation (linked per section); anything not verified is said so.

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
