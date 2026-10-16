# Profilarr plugin: design

Profilarr v2 (https://github.com/Dictionarry-Hub/profilarr) links curated configuration databases (git repositories of quality profiles, custom formats, regular expressions and delay profiles) and syncs them into Radarr and Sonarr. This plugin exposes its REST API through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

Profilarr is a SvelteKit app; every instance serves its OpenAPI 3.1 spec at `<baseUrl>/api/v1/openapi.json` (`src/routes/api/v1/openapi.json/+server.ts` returns the bundled `src/lib/api/v1.openapi.json`, built from `docs/api/v1/openapi.yaml`). The plugin fetches it on every sync with the connection's key, so the catalog matches the installed version and `network.hosts` is only the instance. The version comes from `GET /api/v1/status` (`version`); the spec's own `info.version` is the API's, not the app's.

Operation keys are the spec's paths, which are relative to its server `/api/v1` (`GET /databases/{id}`). The model may pass the path with or without `/api/v1`. A spec with fewer than 15 operations, or one missing any key `plugin.yaml` locks, is refused, so a truncated document or an upstream rename never replaces a synced catalog or silently drops a lock.

Tests pin the spec from tag `v2.2.0` (`plugins/profilarr/test/fixtures/profilarr-openapi.json`, `src/lib/api/v1.openapi.json` as tagged, reformatted by Prettier).

**Scope.** The v1 API covers arr instances (list only), databases (link, update, unlink, sync), jobs, backups, announcements, health and status: 20 operations, 17 in the catalog. It has no endpoints for editing quality profiles, custom formats or arr sync settings, for backup restore, for deleting arr instances, or for Profilarr's own auth and API key; those stay in Profilarr's UI.

## Auth

The API key from Settings → Security, sent as `X-Api-Key` (`src/lib/server/utils/auth/middleware.ts`). It is a single instance-wide key with full API access. Only `/api/v1/health` is public, so `GET /status` both reports the version and proves the key.

## Classification

GET reads, every other verb writes, and anything the rules don't settle stays a write. `GET /jobs/{id}` is flagged by the action heuristic ("creating a backup", "has run" in its description); it only returns the job record, so it is a read.

Excluded: the spec route, `GET /backups/{filename}` (a gzip download) and `POST /backups/upload` (multipart; restoring arbitrary data is UI-only anyway).

## Locks

Each is locked with a typed confirmation. Literals come from the stored object or the path, never from a body field the model writes:

| Operation | Why | Literal |
| --- | --- | --- |
| `POST /databases/{id}/sync` | With auto-pull on, a pull triggers the arr syncs set to run on pull (`pcdManager.sync` → `triggerSyncs({ event: 'on_pull' })`), which overwrite quality profiles and custom formats in Radarr/Sonarr | database name (lookup) |
| `PATCH /databases/{id}` | Turns auto-pull and the sync interval on, which runs the same push on a schedule; replaces the GitHub token | database name (lookup) |
| `POST /databases` | Links any repository with a model-supplied token, `auto_pull` and a sync interval as short as a minute: unattended pushes into Radarr/Sonarr | instance name (`Profilarr`) |
| `DELETE /databases/{id}` | Unlinks the database and its local data | database name (lookup) |
| `DELETE /backups/{filename}` | Irreversible | the file name |
| `PATCH /backups/settings` | A shorter retention deletes older backups at the next cleanup; can turn backups off | instance name (`Profilarr`) |

A `DELETE *` rule locks any delete a newer spec adds until it is reviewed (the locked-key check covers exact keys only).

**Targets.** Non-GET calls on `/databases/{id}…` resolve the stored database through `GET /databases/{id}` as a core target (`capabilities.targets`), named `<name> (<repository_url>)`, and the approval text ends with it, so the approver sees which repository is synced, changed or unlinked. A failed lookup gives no target; the summary still shows the path id.

## Secrets

- Manifest `sensitiveKeys`: `apiKey`, `api_key` (arr instance keys), `personal_access_token` (database GitHub tokens), `token`, `password`, `secret`.
- `sensitiveParams`: `/body/personal_access_token` on database link and update.
- `sensitiveResult`: `personal_access_token` (deep) on database operations and `api_key` (deep) on `GET /arr`. Profilarr already strips both from responses; these keep them masked if a version stops doing so. Repository and arr URLs are left visible.
