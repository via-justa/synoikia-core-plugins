# Seerr plugin

Exposes a Seerr instance's whole REST API (about 210 operations: requests, media, users, settings, notifications, discover sliders, …) through the two MCP tools, `search` and `execute`, behind core's permission gate. Seerr has no introspection endpoint, so the catalog comes from its OpenAPI spec, `seerr-api.yml`, fetched for the release the instance runs. A Seerr upgrade needs no change here. Design: [`docs/reference/seerr-mcp-design.md`](https://github.com/via-justa/home-server-mcps/blob/main/docs/reference/seerr-mcp-design.md), mapped onto the plugin hooks in [`docs/design/unified-mcp-server.md`](https://github.com/via-justa/home-server-mcps/blob/main/docs/design/unified-mcp-server.md) §3.3–§3.4.

## Signing in

Seerr has no service accounts and no per-user API keys, so there are two choices:

- **A dedicated local Seerr user (recommended).** Create it in _Users → Create Local User_, set its password yourself, and grant it only the permissions this server needs. The plugin signs in with `POST /auth/local` and signs in again when the session expires. The setup checklist is shown on the Connection page.
- **The global API key** (_Settings → General_). It acts as the first admin, or as the user in _Act as user ID_ (`X-API-User`). Anyone holding the key can act as any user, and `POST /settings/main/regenerate` invalidates it, including for this server.

| Field                      | Meaning                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Base URL                   | `https://seerr.internal.lan` (a path is kept, for a reverse proxy).                                                          |
| Local user email/password  | The dedicated user. The password is stored encrypted and never shown again.                                                  |
| API key / Act as user ID   | The alternative sign-in.                                                                                                     |
| API spec source (advanced) | Leave empty to fetch from GitHub. Set a mirror laid out as `<url>/<git ref>/seerr-api.yml` if the server can't reach GitHub. |

## The spec

On sync the plugin reads the instance's version from `GET /status` and fetches `seerr-api.yml` from the matching release tag (`v3.4.1`), falling back to `develop` for nightly or self-built instances. The Connection page shows which one was used (`sourceRef`). A fetch that isn't OpenAPI 3.0, or has fewer than 50 operations, is rejected, and the last synced catalog stays in place.

The plugin keeps nothing on disk. After a plugin restart it fetches the spec again on first use; while the spec source is unreachable, calls fail with `UPSTREAM_ERROR` until it is back.

## Calling it

```js
// search: find operations and their parameters
return catalog.find({ text: 'request' });

// execute: one call per API operation; the path is the concrete URL path
const { results } = await seerr.request({ path: '/request', query: { take: 10, filter: 'pending' } });
return await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 603 } });
```

`method` defaults to `GET`. The `/api/v1` prefix is optional. Query parameters go in `query`, not in the path.

## Classification

Every operation is classified when the catalog syncs, by its HTTP method: `GET` is a read, everything else a write. Admins can't change it. The locked list always wins, and a `GET` that acts is a write until reviewed (below).

- **Locked** (always a human, with a name typed back; never pre-approved):
  - `DELETE /user/{userId}` (type the user's email), `PUT /user` (batch permission changes);
  - `DELETE /settings/radarr/{radarrId}` and `/sonarr/{sonarrId}` (the instance name), `DELETE /settings/discover/{sliderId}` (the slider title);
  - `POST /settings/initialize`, `POST /settings/main/regenerate`, `GET /settings/discover/reset` (the application title);
  - approving or declining a request **someone else filed** (`POST /request/{requestId}/{status}#on-behalf`, the requester's name). If the requester can't be checked, the call counts as someone else's;
  - syncing or changing the enabled libraries: `GET /settings/{plex,jellyfin}/library#apply` whenever the call passes `sync` or `enable` (with any value; `enable` disables every library it leaves out). The typed name is the application title. Without either, listing libraries is a read;
  - starting a full Plex or Jellyfin library scan: `POST /settings/{plex,jellyfin}/sync#start` whenever `start` could be truthy (the application title), and `POST /settings/jobs/{jobId}/run#start` for any scheduled job not on the known-cheap list: the full scans, `availability-sync`, `download-sync-reset`, `process-blocklisted-tags` and any unknown job (the job id). Cheap jobs (recently added scans, Radarr/Sonarr scans, watchlist sync, download sync, token refresh, image cache cleanup) use the ordinary key.
- **By verb:** `GET` is a read; `POST`, `PUT`, `PATCH` and `DELETE` are writes.
- **GET as action:** a `GET` whose summary, description or query parameters read like an action (reset, regenerate, sync, flush, run, cancel, invoke) is a write flagged for review until it is reviewed here: a real read goes on the reviewed list, one that changes something on the locked list or a locked split key. The flagged list for the pinned spec is a regression test.

Access groups are the first OpenAPI tag (`request`, `settings`, `users`, `search`, …). New groups start at Read.

## Pre-approval rules

`POST /request` offers the `media-request` profile: **4K request** (yes/no) and **media type** (movie, tv). Rules are strict: every other body field (`mediaId`, `seasons`, …) must be allowed with "any value", or the call asks a human. A request that leaves out `is4k` is sent with `is4k: false` (Seerr's default), so a "4K: no" rule matches it. For example, standard-quality movie requests:

| Field           | Condition |
| --------------- | --------- |
| 4K request      | no        |
| Media type      | movie     |
| `/body/mediaId` | any value |

## Redaction

Settings reads return credentials, so results are redacted under core's global list (passwords, tokens, secrets, API keys, …) plus `connect.sid`, `plexToken`, `jellyfinAuthToken`, `webhookUrl`, `botAPI` (Telegram), `authHeader` (webhook), `pgpKey`, `pushoverUserKey`, and the web-push `p256dh`/`auth` keys.

## Development

```sh
pnpm --filter @synoikia/plugin-seerr test    # builds, then unit tests, SDK conformance and end to end
pnpm --filter @synoikia/plugin-seerr build   # dist/index.js (self-contained bundle)
```

The end-to-end suite (`test/e2e.test.ts`) runs the real core on the built bundle through core's plugin harness (`@synoikia/core/testing`).

The fake server (`test/fake-seerr.ts`) serves `/api/v1` and the spec. The spec fixture, `test/fixtures/seerr-api.yml`, is Seerr's own (MIT) from tag `v3.4.1`; update it to pick up a newer release in the tests. The live checklist for a real instance is in [`RUNBOOK.md`](RUNBOOK.md).
