# Grafana

Grafana 12+ HTTP API. Operation keys are `<VERB> <path>` under `/api`, written without the prefix, as in `GET /dashboards/uid/{uid}`. Dashboards, folders, data sources, alert rules and contact points are addressed by string `uid`; users, teams, orgs and service accounts by numeric `id`. Calls act in the token's organization (`GET /org`).

Paging: `GET /search` and `GET /folders` take `limit` and `page`; user, team and service-account searches take `perpage` and `page`; `GET /annotations` takes `limit` and `from`/`to` (epoch ms).

Workflows:

- Find a dashboard: `GET /search` with `query` (and `type=dash-db`) → `GET /dashboards/uid/{uid}`.
- Query a data source: `GET /datasources` → `POST /ds/query` with `queries: [{ refId, datasource: { uid }, expr }]`, `from`, `to`.
- Alerting: `GET /v1/provisioning/alert-rules`; recent state changes with `GET /annotations` and `type=alert`.
- Annotate: `POST /annotations` with `dashboardUID`, `time`, `tags`, `text`.
- Add or update a dashboard: `POST /dashboards/db` with `dashboard`, `folderUid`, `overwrite`.

Locked (a person types a confirmation): user, org, team, role and service-account admin, tokens, data source changes, permissions, public dashboards and snapshots, contact points, notification policies, alert and recording rule changes, admin settings, and every delete. Not available: data source and plugin proxies, rendering, sign-in.
