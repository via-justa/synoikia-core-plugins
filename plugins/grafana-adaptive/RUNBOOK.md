# Grafana Adaptive Telemetry runbook

The plugin is tested against fake services. This checklist confirms it against a real Grafana Cloud stack before a release. It takes about 20 minutes. Use a test stack: the writes change what telemetry is kept.

**Before you start:** a Grafana Cloud stack that receives some metrics, logs and traces, with Adaptive Metrics, Logs and Traces enabled. Create an access policy for the stack with the Adaptive scopes from the manifest's help, and a token for it.

1. **Connect.** New endpoint → **Grafana Adaptive Telemetry**: the Prometheus, Loki and Tempo URLs and instance IDs from the stack's details pages (paste the Prometheus URL with `/api/prom` to check that the path is ignored), and the token. **Test connection** reports `adaptive (metrics, logs, traces)`. A wrong token or a wrong instance ID fails the test. Clear the Tempo fields: the test reports `adaptive (metrics, logs)` and the `traces.*` operations disappear after a sync. Put them back.
2. **Sync.** 36 operations appear in the `metrics.*`, `logs.*` and `traces.*` groups; every write but `traces.recommendations.dismiss` is locked.
3. **Metrics reads.** `metrics.rules.list` returns `etag` and `rules`; `metrics.recommendations.list` with `verbose: true` shows series before and after; without it, `rulesVersion` is set. `metrics.recommendations.config`, `metrics.segments.list`, `metrics.exemptions.list` answer.
4. **Rules.** `metrics.rules.check` with a bad metric name returns `valid: false`. `metrics.rules.create` on a test metric with the `etag` asks to type the metric name, and the summary shows the dropped labels. Repeat with the old `etag`: it fails with a 412 message naming `metrics.rules.list`. `metrics.rules.replace` with the current rules plus one `drop: true` rule: the summary leads with `drops entirely:`, and the literal is the metrics instance ID. Delete the test rule again.
5. **Logs.** `logs.recommendations.list` shows patterns with drop rates. Create a drop rule with `drop_rate` 0 on a test selector: the literal is its name. Update and delete it: the summaries show the stored rule. Create, then delete, an exemption: the literal is the stream selector.
6. **Traces.** `traces.policies.list`, `traces.recommendations.list`. Create a probabilistic policy with a high percentage: the literal is its name; update and delete it. If a recommendation exists, check that `traces.recommendations.apply` asks for the traces instance ID and lists its actions (don't apply it on a shared stack).
7. **Refusals.** `traces.policies.get` with `id: '..'`, a query key not declared, a body with both `name` and `Name`, or `metrics.rules.replace` without `ifMatch` are refused without a request.
8. **Audit.** The audit log lists each call; the token appears nowhere.
