# Grafana Adaptive Telemetry

Grafana Cloud Adaptive Metrics, Adaptive Logs and Adaptive Traces for Synoikia: aggregation rules and recommendations, log drop rules and exemptions, trace sampling policies and recommendations. The three APIs serve no spec, so the operations are declared in `plugin.yaml`. Design: [`docs/designs/grafana-adaptive.md`](../../docs/designs/grafana-adaptive.md).

The sandbox calls `grafanaAdaptive.call(key, { path, query, body, ifMatch })`. Each key's first part (`metrics`, `logs`, `traces`) names the stack endpoint it is sent to. Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes the Adaptive APIs.

## Files

| File                | What                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| `manifest.json`     | Binding, connection form (three optional services, one token), network hosts           |
| `plugin.yaml`       | The declared operations, locks and confirmation literals                               |
| `instructions.md`   | How to call the APIs, for the model                                                    |
| `src/plugin.ts`     | Handlers: catalog per configured service, summaries, invoke with `If-Match`            |
| `src/connection.ts` | Per-service endpoints, URL checks (https, origin only), HTTP Basic per instance id     |
| `src/request.ts`    | Path, query, body and `ifMatch` checks; Go case-folded and non-ASCII body keys refused |
| `src/stored.ts`     | Stored objects read back for targets and confirmation literals                         |
| `src/summary.ts`    | Approval summaries: what is dropped first, then the request                            |
| `test/`             | Three fake services, unit, catalog, golden and e2e tests on Synoikia's harness         |

## Connection

See the manifest's `connection.help`: the Prometheus, Loki and Tempo URLs with their instance IDs (each pair optional, at least one), and one Cloud access policy token with only the Adaptive scopes Synoikia should have.

## Locked operations

Every write but `traces.recommendations.dismiss`: they change which metrics, log lines and traces are kept. `metrics.rules.replace`, `metrics.recommendations.updateConfig` and `traces.recommendations.apply` confirm the service's instance ID; per-rule writes the metric; metrics exemptions the metric; logs exemptions the stream selector; drop rules and trace policies their stored name (the name in the call for a create).
