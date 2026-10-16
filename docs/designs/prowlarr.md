# Prowlarr plugin: design

Prowlarr (https://github.com/Prowlarr/Prowlarr) manages indexers (Usenet and torrent) for the other Servarr apps. It searches them, proxies their feeds and downloads, and pushes them to the applications it syncs (Sonarr, Radarr, Lidarr, …). This plugin exposes its v1 REST API through Synoikia's `search` and `execute` tools. It follows the [Radarr design](radarr.md) (Servarr code base); this note lists only what differs. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

As Radarr: `Startup.cs` mounts Swagger only `if (BuildInfo.IsDebug)`, so the spec comes from `src/Prowlarr.Api.V1/openapi.json` at the tag `v<4-part version>` reported by `GET /api/v1/system/status`, else `develop`, from `specBaseUrl` (default `https://raw.githubusercontent.com/Prowlarr/Prowlarr`). Keys are the spec's paths, `/api/v1` included. A spec with fewer than 90 operations is refused. Tests pin tag `v2.6.5.5623` (the `master` head; `test/fixtures/prowlarr-openapi.json`, responses reduced to their descriptions, unreferenced schemas dropped): 128 spec operations, 118 in the catalog after exclusions and twins.

`src/spec.ts`, `src/locks.ts`, `src/request.ts` and `src/auth.ts` are Radarr's, unchanged. `src/fields.ts` adds the Cardigann and guid rules below.

## Excluded

Radarr's web UI, sign-in, log file, filesystem and backup upload exclusions with the `/api/v1` prefix (`GET /api/v1/log/file*` also covers the update logs), plus the Newznab/Torznab endpoints:

| Operation | Why |
| --- | --- |
| `GET /api/v1/indexer/{id}/newznab`, `GET /{id}/api` | The feed apps read: XML. `GET /api/v1/search` returns the same results as JSON |
| `GET /api/v1/indexer/{id}/download`, `GET /{id}/download` | Fetches a release file from the indexer with its credentials and returns the file. Its `link` is an encrypted indexer URL |

## Locks

Radarr's locks for host settings, shutdown and restart, backups, download clients, notifications and their tests, `#stored` provider tests and actions, and `DELETE *`, with these Prowlarr ones:

| Operation | Why | Literal |
| --- | --- | --- |
| `POST /api/v1/applications`, `PUT /api/v1/applications/{id}` | Prowlarr pushes every synced indexer to the app's `baseUrl`, with Prowlarr's API key and `prowlarrUrl`, and keeps the app's API key | body `name` on create, stored name on update |
| `POST /api/v1/applications/test`, `/action/{name}` | Even without an `id`, a test posts a test indexer with Prowlarr's API key to the host in the body | body `name`, else instance name |
| `POST /api/v1/applications/{test,action/{name}}#stored` | With an `id`, Prowlarr also fills in the stored app API key | stored name |
| `POST /api/v1/applications/testall` | Posts a test indexer with Prowlarr's API key to every stored application | instance name |
| `PUT /api/v1/applications/bulk` | Sync level (`fullSync` removes indexers from the apps) and tags of many apps | `<n> applications` |
| `POST /api/v1/indexer`, `PUT /api/v1/indexer/{id}` | Credentials and site URL; a new indexer is pushed to every synced app | body `name`, stored name |
| `PUT /api/v1/indexer/bulk`, `DELETE /api/v1/indexer/bulk` | App profile, tags (which apps and proxies apply), enable and seed settings of many indexers | `<n> indexers` |
| `POST /api/v1/indexerproxy`, `PUT /api/v1/indexerproxy/{id}` | All traffic of the indexers with its tags goes through the proxy (HTTP, SOCKS, FlareSolverr) | body `name`, stored name |
| `POST /api/v1/indexerproxy/{test,action/{name}}#stored` | As for other providers | stored name |
| `PUT /api/v1/config/development/{id}` | Turns on logging of indexer responses (session cookies, keys) and SQL to the log files | instance name |
| `DELETE /api/v1/downloadclient/bulk` | Bulk delete | `<n> download clients` |
| `POST /api/v1/command#heavy` | Any command not in `plugin.quickCommands`: `ApplicationIndexerSync` (pushes all indexers to every app; `forceSync` overwrites the app side), `ApplicationUpdateCheck` (installs an update when started by hand), `ApplicationUpdate`, `ClearHistory`, `CleanUpHistory`, `ClearLog`, `DeleteLogFiles`, `DeleteUpdateLogFiles`, `ResetApiKey`, `Shutdown`, `Restart`, … and future ones | the command name, else instance name |

Quick commands: `Backup`, `CheckHealth`, `Housekeeping`, `IndexerDefinitionUpdate` (fetches indexer definitions from Prowlarr's own server, as the scheduled task does).

These stay writes: `POST /api/v1/indexer/testall` (stored indexers only), `PUT /api/v1/downloadclient/bulk` (enable, priority, tags), `POST /api/v1/search` and `/search/bulk` (grab a cached release by `guid` and `indexerId`; no URL from the caller), app profiles and tags.

**Targets.** Provider calls show `<kind> <name> (<implementation>) → <destinations>` as in Radarr; for an application that is its `prowlarrUrl` and `baseUrl`, in field order. A `host` that is a URL (FlareSolverr) shows its origin. Bulk calls list up to 10 providers by stored name. A grab shows each release (up to 10) as `release <guid> ("<title>") → download client <name> (from <indexer>)`. Prowlarr takes the release from its cache by `indexerId` and `guid` and ignores `title`, so the guid leads and the title is the caller's claim. The client is the one in the body for a single grab (its id when the lookup fails), else the indexer's stored one, else Prowlarr's default. `indexerId`, `downloadClientId` and `title` are in `plugin.canonicalKeys`, so `DownloadClientId` is read as Prowlarr binds it.

## Secrets

As Radarr, plus:

- Cardigann indexer settings come back unmasked (`privacy: normal`) and their names vary per definition (`pid`, `passkey`, `cookie`, …). For an `implementation` of `Cardigann`, `src/fields.ts` fails closed: every non-empty string becomes `[REDACTED]`, except `baseUrl` (a select; origin only) and other `select` or `checkbox` values. For other providers it also hides a field whose `type` is `password`, or whose name matches `2fa` or is `pin`.
- Search `downloadUrl` and `magnetUrl` are Prowlarr proxy links with Prowlarr's API key: `sensitiveResult` on `/api/v1/search*`.
- A history `data.url` is the indexer request URL (Newznab `apikey`) or the download link (passkey): `sensitiveResult` on `url` for `/api/v1/history*`. `sensitiveResult` keys match exactly, so `src/plugin.ts` also hides `downloadUrl`, `magnetUrl` and `url` in any case (`Url`) in search and history results.
- Cardigann and other indexers use the download link as the release `guid`. Search and history results keep only the origin of a `guid`, `infoUrl` or `commentUrl` that is a URL, in any key case (grab history stores `InfoUrl`). Such a release can't be grabbed through the API (the write guard refuses the masked guid); grab it in Prowlarr or the app.
