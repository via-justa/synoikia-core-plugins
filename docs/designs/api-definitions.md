# API definitions of the upstreams

Where each plugin gets its catalog, checked against each project's source on 2026-10-14. A spec the running instance serves is preferred: it always matches the installed version. A spec published upstream is fetched for the instance's version (the Seerr pattern). Without any spec, operations are declared in `plugin.yaml` (`static-rest`).

| Upstream | Plugin | API and auth | Spec served by the instance | Spec published elsewhere | Catalog from |
| --- | --- | --- | --- | --- | --- |
| Mealie | `mealie` | REST `/api`, bearer token | `/openapi.json` (FastAPI default; `API_DOCS` only toggles `/docs`) | — | served spec |
| Profilarr v2 | `profilarr` | REST `/api/v1`, API key | `/api/v1/openapi.json` | `docs/api/v1/openapi.yaml` | served spec |
| Nginx Proxy Manager | `npm` | REST `/api`, JWT from `POST /api/tokens` | `/api/schema` (compiled OpenAPI 3) | `backend/schema/` | served spec |
| Grafana 12+ (self-hosted and Cloud stacks) | `grafana` | HTTP API, service-account token | `/public/openapi3.json` and `/openapi/v3` (app platform) | `public/openapi3.json` | served spec |
| Backstage | `backstage` | `/api/<pluginId>/*`, static external-access token | `/api/<pluginId>/openapi.json` for catalog, scaffolder, search, events, notifications | `plugins/<id>-backend/src/schema/openapi.yaml` | served specs, merged |
| Radarr | `radarr` | REST `/api/v3`, `X-Api-Key` | No: Swagger only in debug builds (`Startup.cs`, `BuildInfo.IsDebug`) | `src/Radarr.Api.V3/openapi.json` per release tag | spec for the instance's version |
| Sonarr | `sonarr` | REST `/api/v3`, `X-Api-Key` | No (as Radarr) | `src/Sonarr.Api.V3/openapi.json` | spec for the instance's version |
| Lidarr | `lidarr` | REST `/api/v1`, `X-Api-Key` | No (as Radarr) | `src/Lidarr.Api.V1/openapi.json` | spec for the instance's version |
| Prowlarr | `prowlarr` | REST `/api/v1`, `X-Api-Key` | No (as Radarr) | `src/Prowlarr.Api.V1/openapi.json` | spec for the instance's version |
| Plex Media Server | `plex` | PMS HTTP API, `X-Plex-Token`, JSON with `Accept: application/json` | No | Community `LukeHagar/plex-api-spec`; Plex's own docs (developer.plex.tv) not used | community spec |
| grafana.com | `grafanacloud` | REST, Cloud access-policy token | n/a | `grafana.com/api/openapi.json`, mirrored in `grafana/grafana-com-public-clients` | published spec |
| Grafana Adaptive Metrics, Logs, Traces | `grafana-adaptive` | Stack Prometheus, Loki and Tempo endpoints, basic auth with an access-policy token | No | No (prose docs only) | declared in `plugin.yaml` |
| Jenkins 2.x | `jenkins` | Remote access API (`…/api/json`, `tree=`), API-token basic auth | No (self-describing objects, no OpenAPI) | No | declared in `plugin.yaml` |
| qBittorrent 5 | `qbittorrent` | WebUI API `/api/v2`, session cookie (`SID`, or `QBT_SID_<port>` from 5.2), form-encoded POSTs (`torrents/add` multipart) | No | No (wiki only; checked against the source) | declared in `plugin.yaml` |

Not built:

| Upstream | Why |
| --- | --- |
| Calibre-Web-Automated | No JSON API: HTML forms with CSRF, read-only OPDS (Atom XML), Kobo sync and a loopback-only internal API |
| Syncthing | Dropped by decision; REST `/rest` with no spec |
| Shelfmark | Dropped by decision; file-based, no spec |
| Grafana k6, IRM/OnCall, Incident, Synthetic Monitoring | Out of scope for now; k6 serves `api.k6.io/cloud/v6/openapi`, the others have no spec |

## Agent instructions

Each plugin ships a short `instructions.md` (about 1.5 KB at most) so the agent spends fewer calls discovering conventions: how the API is laid out (base path, versioning, where IDs come from), how to call it (operation keys, paging and filters, async patterns), the 3–5 most common workflows as operation-key sequences, and one line on what is locked or excluded. It never covers auth, secrets or approvals, which core handles. The manifest names it in `"instructions": "instructions.md"`, and core adds its text to the MCP server instructions in a `<plugin-notes>` block. Core accepts at most 4096 bytes of UTF-8 with no control characters (except tab, CR and LF), no `\p{Cf}`, U+2028 or U+2029 characters, and no `plugin-notes` tag; the file must be a regular `.md` file, not a symbolic link. `synoikia-plugin check` applies the same rules.
