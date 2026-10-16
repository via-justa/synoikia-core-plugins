# Grafana Adaptive Telemetry plugin: design

Grafana Cloud Adaptive Telemetry reduces stored telemetry: Adaptive Metrics aggregates or drops metric series, Adaptive Logs drops a share of log lines, and Adaptive Traces samples traces through policies. This plugin exposes the three management APIs through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

The three APIs have no OpenAPI spec, served or published. The plugin is a `static-rest` plugin: `plugin.yaml` declares the operations. Each one was confirmed from two sources:

- grafana.com documentation (read through web search, as this environment cannot fetch grafana.com):
  - [Adaptive Metrics HTTP API](https://grafana.com/docs/grafana-cloud/adaptive-telemetry/adaptive-metrics/manage-as-code/adaptive-metrics-api/): `GET`/`POST /aggregations/rules` as read, modify, upload; `/aggregations/recommendations` and `/aggregations/recommendations/config` (`keep_labels`); the `Last-Modified` header; ETag missing or stale on upload.
  - [Adaptive Logs HTTP API](https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-logs/manage-as-code/adaptive-logs-api/): `GET /adaptive-logs/recommendations` with basic auth `<tenant>:<token>` and the `adaptive-logs:admin` scope; `configured_drop_rate` and `recommended_drop_rate`; exemptions by stream selector; [drop rules](https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-logs/drop-rules/).
  - [Adaptive Traces HTTP API](https://grafana.com/docs/grafana-cloud/adaptive-telemetry/adaptive-traces/manage-as-code/adaptive-traces-api/): `/adaptive-traces/api/v1/policies` list, get, create (`type`, `name`, `body`), update (`PUT`), delete; basic auth with the `adaptive-traces:admin` scope; a recommendations section.
- Grafana's own Apache-2.0 clients, for exact paths, methods, bodies and responses:
  - [`grafana/gcx`](https://github.com/grafana/gcx) (commit `e9515b39`), `internal/providers/{metrics,logs,traces}/adaptive/client.go` and `types.go`, and `internal/auth/adaptive/auth.go` (base URL = the stack's `hmInstancePromUrl`, `hlInstanceUrl`, `htInstanceUrl`; basic auth with the instance ID).
  - [`grafana/terraform-provider-grafana-adaptive-metrics`](https://github.com/grafana/terraform-provider-grafana-adaptive-metrics) (commit `f9db37d0`), `internal/client/*.go` and `internal/model/*.go` (rules with `If-Match`/`ETag`, recommendation config with `auto_apply`, exemptions).

Nothing else is declared, so nothing else is reachable.

## Connection

Three optional pairs and one token:

| Fields | Service | Paths |
| --- | --- | --- |
| `prometheusUrl`, `metricsInstanceId` | Adaptive Metrics | `/aggregations/…`, `/v1/recommendations/exemptions…` |
| `lokiUrl`, `logsInstanceId` | Adaptive Logs | `/adaptive-logs/…` |
| `tempoUrl`, `tracesInstanceId` | Adaptive Traces | `/adaptive-traces/api/v1/…` |

- A URL needs its numeric instance ID; at least one service is needed.
- URLs must be https; http only on a loopback address. Only the URL's origin is used: the APIs sit at the host root, and the stack page shows paths such as `/api/prom` or `/tempo`.
- Each request uses HTTP Basic with the service's instance ID and the access policy token (`writeOnly`, `secret` widget, in `sensitiveKeys`).
- `network.hosts` lists the three URL fields.
- The catalog holds only the operations of configured services. A call to another service is refused as an unknown operation.
- The connection test (and every sync) sends one read per configured service: `GET /aggregations/recommendations/config`, `GET /adaptive-logs/exemptions`, `GET /adaptive-traces/api/v1/policies`. The APIs report no version; the upstream version is `adaptive (<configured services>)`.

## Operations

The sandbox calls `grafanaAdaptive.call(key, { path, query, body, ifMatch })`.

| Key | Request | Class | Literal |
| --- | --- | --- | --- |
| `metrics.rules.list` | `GET /aggregations/rules` (`segment`); returns `{ etag, rules }` | read | |
| `metrics.rules.get` | `GET /aggregations/rule/{metric}` | read | |
| `metrics.rules.check` | `POST /aggregations/check-rules`; returns `{ valid, errors }` | read (validates only) | |
| `metrics.recommendations.list` | `GET /aggregations/recommendations` (`verbose`, `action`, `segment`); returns `{ rulesVersion?, recommendations }` | read | |
| `metrics.recommendations.config` | `GET /aggregations/recommendations/config` | read | |
| `metrics.segments.list` | `GET /aggregations/rules/segments` | read | |
| `metrics.exemptions.list`, `.get` | `GET /v1/recommendations/exemptions[/{id}]` | read | |
| `metrics.rules.replace` | `POST /aggregations/rules`, `If-Match` | locked | metrics instance ID |
| `metrics.rules.create`, `.update`, `.delete` | `POST`/`PUT`/`DELETE /aggregations/rule/{metric}`, `If-Match` | locked | the metric |
| `metrics.recommendations.updateConfig` | `POST /aggregations/recommendations/config` (`keep_labels`, `auto_apply`) | locked | metrics instance ID |
| `metrics.exemptions.create`, `.update`, `.delete` | `POST`/`PUT`/`DELETE /v1/recommendations/exemptions[/{id}]` | locked | the exemption's metric (stored) |
| `logs.recommendations.list` | `GET /adaptive-logs/recommendations` | read | |
| `logs.segments.list` | `GET /adaptive-logs/segments` | read | |
| `logs.dropRules.list`, `.get` | `GET /adaptive-logs/drop-rules[/{id}]` (`segment_id`, `expiration_filter`) | read | |
| `logs.exemptions.list`, `.get` | `GET /adaptive-logs/exemptions[/{id}]` | read | |
| `logs.dropRules.create`, `.update`, `.delete` | `POST`/`PUT`/`DELETE /adaptive-logs/drop-rules[/{id}]` | locked | the rule's name (stored) |
| `logs.exemptions.create`, `.update`, `.delete` | `POST`/`PUT`/`DELETE /adaptive-logs/exemptions[/{id}]` | locked | the stream selector (stored) |
| `traces.policies.list`, `.get` | `GET /adaptive-traces/api/v1/policies[/{id}]` | read | |
| `traces.recommendations.list` | `GET /adaptive-traces/api/v1/recommendations` | read | |
| `traces.policies.create`, `.update`, `.delete` | `POST`/`PUT`/`DELETE /adaptive-traces/api/v1/policies[/{id}]` | locked | the policy's name (stored) |
| `traces.recommendations.apply` | `POST /adaptive-traces/api/v1/recommendations/{id}/apply` | locked | traces instance ID |
| `traces.recommendations.dismiss` | `POST …/recommendations/{id}/dismiss` | write | |

"Applying metrics recommendations" has no endpoint of its own: `metrics.recommendations.list` without `verbose` returns the complete recommended rule set and its `Rules-Version` header, and `metrics.rules.replace` uploads it with that value as `If-Match` (as gcx does).

### Not included

- The pattern drop-rate write of Adaptive Logs (changing `configured_drop_rate` per pattern, bulk apply of recommended rates): the docs name the fields but no write endpoint, and gcx has none. Drop rules cover drop rates.
- Segment create, update and delete for metrics (`/aggregations/rules/segments`) and logs (`/adaptive-logs/segment`): confirmed, but structural; reads only.
- `/aggregations/segmented_rules` and `/v1/recommendations/segmented_exemptions` (cross-segment listings): confirmed; segment reads take `segment` instead.
- Adaptive Traces insights and tenant endpoints, and Adaptive Metrics usage analysis (`adaptive-metrics.grafana.net/api/v1/…` in some third-party guides): not in the docs or Grafana's clients.

## Requests

- Path params fill the template only: a metric is a Prometheus metric name, an ID matches `[A-Za-z0-9][A-Za-z0-9_.:-]*` (so `.`, `..` and `/` are refused). A path param the template does not take is refused.
- Query keys are the declared ones, with their types and enums; keys that differ only by case are refused. IDs follow the path ID form; `segment_id` also takes `__global__`, the tenant-wide drop rule segment.
- A body only where one is declared: a list of rules for `replace`/`check`, an object otherwise. The services are Go: `encoding/json` binds keys case-insensitively, the last match winning, and folds `ſ` and the Kelvin sign. Two keys that differ only in case, or a non-ASCII key, are refused at any depth, and the keys the plugin reads are renamed to one spelling, as in `grafanacloud`. The fields summaries read are type-checked (`drop` boolean, label lists of strings, `drop_rate` number, names and selectors non-empty strings), and `match_type` of rules and metrics exemptions must be `exact`, `prefix` or `suffix` (core does not enforce the `plugin.yaml` enum).
- `ifMatch` is required on rules writes and refused elsewhere: 1–256 visible ASCII characters. A 412 answer becomes "read them again with `metrics.rules.list` and retry". Successful rules writes return the new `etag`.
- `metrics.rules.create`/`update` need `body.metric` equal to `path.metric`.

## Locks

Every write that changes which telemetry is kept is locked, matched by verb (`*.create`, `*.update`, `*.delete`, `*.replace`, `*.apply`, `*.updateConfig`), so a later write with one of these verbs is locked until reviewed:

- Rules, recommendation settings (`auto_apply` changes rules without review) and trace policies decide what is aggregated, dropped or sampled away: data not kept is lost.
- Deleting an exemption or a rule lets recommendations drop data again, or raises cost; creating one changes what recommendations do.
- A trace recommendation applies policy changes in bulk.

Only `traces.recommendations.dismiss` is a plain write: it changes no policy.

Literals: instance-wide writes confirm on the service's instance ID. Per-object writes confirm on the stored object read back from the service (metric, stream selector or name); a create confirms on the metric or name in its call. When the stored object of an update or delete cannot be read, the literal is the instance ID.

## Targets

Writes name what they act on: `instance` (`<service>:<id>`) for instance-wide writes; `metric-rule`, `metrics-exemption`, `logs-exemption`, `drop-rule` or `policy` with the stored name for updates and deletes. `traces.recommendations.apply` also names the recommendation, with a hash of its actions in the id (`rec-1#9b882217f37a`), so a recommendation regenerated during the approval wait changes the target and core refuses the call. Creates have no target. Targets hold no status, as core resolves them again after the approval wait.

## Summaries

Destination first, then what is dropped, then the request: `Adaptive Metrics metrics.rules.replace on Adaptive Metrics instance 100001: drops entirely: "go_gc_duration_seconds"; aggregates: …; removes the rules of "debug_events_total" (kept in full again); 2 rules: 1 added, 1 changed, 1 removed, 0 unchanged — POST /aggregations/rules`. A replacement is compared with the rule set in force (read for the summary), by metric and match type; drops and removals name each rule as `"go_" (prefix match)`, so a prefix or suffix rule never reads as one metric. When the rule set cannot be read, the summary says so and lists the `drop` rules sent. A settings change reads the settings in force and lists the `keep_labels` it removes. Updates show the stored object as `(was …)`. Drop rules show their `segment_id`, exemptions their `expires_at`. Drop rates are shown as sent (`drop_rate 0.9`), as the docs and clients do not agree on a scale. Every model-written value (names, selectors, labels, aggregations, match types, expiry times) is quoted, escaped (control, bidi, zero-width, soft hyphen, U+061C and U+180E as `\uXXXX`) and truncated; lists stop after 20.

## Results

Responses carry no secrets. `metrics.rules.list` adds the `ETag` header as `etag`; non-verbose `metrics.recommendations.list` adds `Rules-Version` as `rulesVersion`.
