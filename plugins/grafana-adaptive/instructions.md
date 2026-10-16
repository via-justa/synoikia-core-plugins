# Grafana Adaptive Telemetry

`grafanaAdaptive.call(key, { path, query, body, ifMatch })`. `metrics.*` go to the stack's Prometheus host (`/aggregations/…`), `logs.*` to Loki (`/adaptive-logs/…`), `traces.*` to Tempo (`/adaptive-traces/api/v1/…`); only configured services exist.

- Metrics rule: `{ metric, match_type, drop, drop_labels | keep_labels, aggregations }`; `drop: true` discards the metric.
- Rules writes need `ifMatch`: read `metrics.rules.list` (`etag`, `rules`), change the list, send it all to `metrics.rules.replace` (or one rule: `metrics.rules.create`, `metrics.rules.update`, `metrics.rules.delete`). 412 means re-read. `metrics.rules.check` validates.
- Drop rule: `{ name, body: { drop_rate, stream_selector, levels, log_line_contains } }`. Trace policy: `{ type, name, body }`.

Workflows:

- Review metric recommendations: `metrics.recommendations.list` with `verbose: true` → `metrics.exemptions.list`.
- Apply them: without verbose it returns the full set and `rulesVersion` → `metrics.rules.replace` with it as `ifMatch`.
- Current rules: `metrics.rules.list`, `metrics.recommendations.config`.
- Log pattern drop rates: `logs.recommendations.list` → `logs.dropRules.list`, `logs.exemptions.list`.
- Trace sampling: `traces.policies.list` → `traces.recommendations.list`.

Locked (a person types the instance id, metric, stream selector or name): every create, update, delete, `metrics.rules.replace`, `metrics.recommendations.updateConfig`, `traces.recommendations.apply`.
