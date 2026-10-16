# Grafana plugin: design

Grafana (https://github.com/grafana/grafana) 12 and later, self-hosted or a Grafana Cloud stack (`https://<stack>.grafana.net`). This plugin exposes Grafana's HTTP API through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies. The grafana.com API (stacks, access policies) is a separate plugin, `grafanacloud`.

## Catalog source

Every Grafana serves the HTTP API's OpenAPI 3.0 spec as a static file at `<baseUrl>/public/openapi3.json` (the `/swagger` page loads it; `public/openapi3.json` in the repository). The plugin fetches it on every sync, so the catalog matches the installed version and `network.hosts` is only the instance. The file sits outside `/api`, so the plugin keeps two clients on the same base URL: one for the spec, one for `/api`.

Operation keys are the spec's paths, relative to its server `/api` (`GET /dashboards/uid/{uid}`). The model may pass the path with or without `/api`. A spec with fewer than 250 operations, or one missing any key `plugin.yaml` locks, is refused, so a truncated document or an upstream rename never replaces a synced catalog or silently drops a lock.

Tests pin the spec from tag `v12.4.13` (`plugins/grafana/test/fixtures/grafana-openapi3.json`, from `git show v12.4.13:public/openapi3.json`). The fixture keeps every path, method, parameter, summary and description verbatim; only `description` and `example` text inside `components.schemas` and `components.responses` was dropped (property names kept), and Prettier reformatted it: 804 KB to 553 KB.

**Version.** `GET /api/health` `version`; when `anonymous.hide_version` hides it there, `GET /api/frontend/settings` `buildInfo.version`. A major below 12 fails the connection test and the sync with "Grafana X is not supported; this plugin needs Grafana 12 or later". `/api/health` is public, so the connection test also reads `GET /api/org` to prove the token.

**Scope.** 331 operations in the v12.4.13 spec, 310 in the catalog. Left out of this version:

- **App platform** (`/apis/<group>/<version>/…`, specs at `/openapi/v3`). Dashboards and folders there duplicate the legacy endpoints; the other groups' specs are generated at runtime by kube-openapi and could not be pinned without a running Grafana. Follow-up.
- **Alert state** (Prometheus-compatible `/api/prometheus/grafana/api/v1/alerts`, Alertmanager `/api/alertmanager/grafana/api/v2/*`). Not in the served spec. Alert rules are in the catalog, and state changes show as `GET /annotations` with `type=alert`. Follow-up, from ngalert's tooling spec.
- **SLO app** (`/api/plugins/grafana-slo-app/resources/v1/*`). Its spec is published separately (`grafana/slo-openapi-client`), not served. Follow-up: an optional second spec when `GET /api/plugins/grafana-slo-app/settings` answers 200.
- **API keys**: removed in Grafana 12; service account tokens replace them.

## Auth

A service account token (`glsa_…`), sent as `Authorization: Bearer`. The account's role (Viewer, Editor, Admin, plus RBAC roles on Enterprise and Cloud) bounds what any call can do; calls act in the account's organization.

## Classification

GET reads, every other verb writes, and anything the rules don't settle stays a write.

- Reads by review: the three `/access-control/*/search` POSTs.
- `POST /ds/query` stays a write. A SQL data source runs the query's `rawSql` as its stored database user, so a query can change data. Its targets are the data sources it names (`queries[].datasource.uid`, `queries[].datasourceId` or a `queries[].datasource` name, each resolved to `<name> (<type>, <url>)` with the stored uid as its id; an unknown uid is shown as itself, an id or name that can't be read is refused, and so are more than 20), so approvers and pre-approval rules see what it hits.
- GETs the action heuristic flagged and that only read: `GET /search`, `/folders`, `/annotations`, `/users`, dashboard versions, and others listed in `plugin.yaml`.
- GETs that write: `GET /licensing/refresh-stats`, `GET /user/helpflags/clear`, and `GET /snapshots-delete/{deleteKey}` (deletes a snapshot; locked).

Excluded:

| Operations | Why |
| --- | --- |
| `* /datasources/proxy/*`, `* /datasources/{id}/resources/*`, `* /datasources/uid/{uid}/resources/*`, `* /plugins/*/resources/*` | Forward any request to a data source or plugin with its stored credentials |
| `* /saml/*`, `GET /logout/saml`, `GET /user/email/update` | Sign-in, single logout and the email-change confirmation link |
| `* /public/dashboards/*` | Anonymous public-dashboard viewer endpoints, addressed by access token |
| `GET /reports/render/*`, `GET /reports/images/*` | PDF, CSV and image downloads the JSON binding cannot carry |
| `GET /v1/provisioning/contact-points/export` | With `decrypt=true` it returns contact point credentials, as YAML or HCL text that key masking cannot reach |

## Locks

Each is locked with a typed confirmation. Literals come from the stored object (a lookup by the path id) or the path, never from a body field the model writes; creates, which have nothing stored yet, confirm against the organization name (`GET /org`). A failed lookup falls back to the path id.

| Area | Operations | Literal |
| --- | --- | --- |
| Server admin | `/admin/users` create, delete, disable, enable, logout, password, permissions, revoke session; `PUT /users/{user_id}`; `PUT /user/password` | user login (lookup), else org |
| Server config | `GET /admin/settings` (full server configuration), `/admin/provisioning/*/reload`, SSO settings `PUT`/`PATCH`, `POST /licensing/token` | org |
| Orgs | `POST /orgs`, `DELETE /orgs/{org_id}`, org user add and role change (`/org/users`, `/orgs/{org_id}/users`), `POST /org/invites` | org name or user login (lookup) |
| Teams | delete, members add, set, update and remove, external group sync | team name (lookup) |
| Roles (RBAC) | custom role create, update, delete and assignments; team and user role grants; resource permissions (`/access-control/{resource}/{resourceID}…`); `/groupsync/groups/{group_id}` | role display name, team name or user login (lookup); resource id; group id |
| Service accounts | create, update (role), delete; token create and delete | account name (lookup) |
| Data sources | create, update (by id and uid), delete (by id, uid, name), LBAC rules | data source name (lookup) |
| Sharing | folder and dashboard permissions, folder move (changes inherited permissions), public dashboard create and update, `POST /snapshots` (`external: true` uploads to the snapshot server) | folder or dashboard title (lookup) |
| Alerting | contact point create, update, delete; notification policy tree replace and reset; alert rule create, update, delete; rule group replace and delete; Prometheus rule imports (`/convert/*`); mute timings create and update | contact point name (lookup by uid), rule title (lookup), group, namespace or timing name |
| Unattended or outbound | recording rules create and update, recording rule writer, reports create, update, email and test email, cloud migration session, upload and token | report name (lookup) or org |
| Bulk | `POST /annotations/mass-delete` | org |

A `DELETE *` rule locks every delete, including any a newer spec adds (the locked-key check covers exact keys only).

**Destinations.** Approvals put the body's destination fields first, ahead of the body cut at 1000 characters, so padding cannot hide them: `url`, `settings.addresses`, `recipients`, `emails`, `external`, `receiver` (`plugin.destinationFields`). Targets (`capabilities.targets`) add the rest: a non-GET call on `/datasources/{id}` or `/datasources/uid/{uid}` names the stored data source as `<name> (<type>, <url>)`; `POST /ds/query` names each data source it queries; a contact point create or update names only the host of `settings.url` (`hooks.slack.com (contact point URL)`), since Slack, Discord, Teams and webhook URLs carry their token in the path.

**Key spelling.** Grafana is Go: `encoding/json` binds body keys case-insensitively (the last match wins) and folds `ſ` to `s` and the Kelvin sign to `k`. A `POST /ds/query` with `{"datasource": {"uid": "prom"}, "Datasource": {"uid": "mysql-prod"}}` would show `prom` and query `mysql-prod`. So `resolveOperation` checks the query and the body along every pointer the plugin or core reads: the destination fields, the target fields and the rules' `sensitiveParams`. Each object on those pointers, and anything under `queries`, is refused with `INVALID_PARAMS` when two keys are equal under case-folding or a key is not printable ASCII. A lone key in another case (`URL`) is renamed to the read spelling. Free-form maps off those pointers (dashboard JSON, `jsonData`) pass as sent.

## Secrets

- Manifest `sensitiveKeys`: `token`, `key`, `apiKey`, `api_key`, `password`, `basicAuthPassword`, `secret`, `secureJsonData`. Core masks these by name in params, results and the audit log (`key` also covers `deleteKey`; `token` covers `authToken` and `accessToken`).
- `sensitiveParams`: data source `secureJsonData`, `basicAuthPassword`, `password`; contact point `settings.url` and `settings.password`; user passwords; SSO `clientSecret` and `privateKey`; the cloud migration `authToken`; the license `token`.
- `sensitiveResult`: data source credentials (deep); `url` (deep) on contact points, whose provisioning API keeps integration secrets in `settings`; `code` and `url` on org invites (join links); `key`, `token`, `deleteKey` and `deleteUrl` on service account token creation, cloud migration token creation and snapshot creation. A snapshot's view `url` stays visible, since sharing it is the point.
