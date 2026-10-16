# Grafana

Exposes the Grafana 12+ HTTP API (310 operations: dashboards, folders, search, data sources and queries, annotations, alerting provisioning, users, teams, orgs, service accounts, access control, playlists, library panels, snapshots and more) of a self-hosted Grafana or a Grafana Cloud stack through Synoikia's `search` and `execute` tools. The catalog comes from the spec the instance serves at `/public/openapi3.json`, so a Grafana upgrade needs no change here; Grafana 11 and older are refused. Design: [`docs/designs/grafana.md`](../../docs/designs/grafana.md).

The sandbox calls `grafana.request({ method, path, query, body })` with a path under `/api` (the prefix is optional):

```js
const [hit] = await grafana.request({ path: '/search', query: { query: 'node exporter', type: 'dash-db' } });
return await grafana.request({ path: `/dashboards/uid/${hit.uid}` });
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes Grafana's API.

## Connection

A base URL and a service account token (sent as `Authorization: Bearer`). The service account's role bounds what any call can do.

## Files

| File              | What                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `manifest.json`   | Binding, connection form, `sensitiveKeys` and network hosts                                           |
| `plugin.yaml`     | Excluded routes, locked operations, confirmation literals, sensitive params and results               |
| `instructions.md` | Agent instructions (API shape, paging, common workflows); core adds it to the MCP server instructions |
| `src/plugin.ts`   | Spec discovery and the two clients (spec at the base URL, API under `/api`)                           |
| `src/version.ts`  | Version from `/api/health` or the frontend settings; refuses Grafana below 12                         |
| `src/locks.ts`    | Refuses a spec that lacks a locked operation                                                          |
| `src/targets.ts`  | Names the stored data source (type and URL) in data source approvals                                  |
| `src/auth.ts`     | The Bearer header                                                                                     |
| `test/`           | A fake Grafana serving the pinned v12.4.13 spec, unit, golden and e2e tests                           |

## Locked operations

User, org, team, role and service-account administration; token creation and deletion; data source changes; folder and dashboard permissions, public dashboards and snapshots; contact points, notification policies, alert, recording and imported rules, mute timings; reports and cloud migration; admin settings and provisioning reloads; every delete. Data source and plugin proxies, sign-in flows, renders and the decrypting contact point export are excluded. Reasons and literals are in the design note and `plugin.yaml`.
