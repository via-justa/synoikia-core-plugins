# Plex plugin: design

Plex Media Server (PMS) serves a household's movie, TV, music and photo libraries. This plugin exposes the PMS HTTP API through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

PMS serves no API spec, and Plex's own developer documentation is incomplete. The catalog comes from the community spec [`LukeHagar/plex-api-spec`](https://github.com/LukeHagar/plex-api-spec) (`plex-api-spec.yaml`, OpenAPI 3.1, Apache-2.0).

1. `GET /` (`MediaContainer.version`) gives the server version. It needs the token, so it also proves the token.
2. `src/spec.ts` fetches `<specBaseUrl>/<ref>/plex-api-spec.yaml`. `ref` is a full commit SHA pinned in `plugin.yaml` (`a632c48…`, 2026-10-14), next to the file's `sha256`. `parseSpecSource` refuses a branch or tag name. `fetchPlexSpec` refuses a file whose SHA-256 differs, from GitHub or a mirror: a change in a third-party repository or a mirror must not change the catalog without a plugin release. The ref is the catalog's `sourceRef`.
3. `specBaseUrl` defaults to `https://raw.githubusercontent.com/LukeHagar/plex-api-spec`; a mirror with the same `<ref>/<file>` layout works offline. No credentials go there. Both hosts are in `network.hosts`.

**PMS only.** The spec also describes plex.tv (account, sign-in, PINs, friends, sharing, home users, webhooks) and the cloud metadata and discover providers. Those operations declare their own `servers`. `pmsOnly` drops every operation that declares `servers`, at operation or path level, before the catalog is built. No plex.tv host is in `network.hosts`. Of 405 operations in the pinned spec, 52 are plex.tv or cloud, and 50 PMS operations are excluded (below); the catalog has 306 operations: 303 PMS operations and 3 split twins.

**`:` paths.** Plex keeps actions under a `:` segment (`/:/scrobble`, `/:/prefs`). The SDK's OpenAPI adapter skips paths with `:`, so `src/catalog.ts` builds them under a placeholder segment and restores the keys, templates and segments afterwards. A spec that already uses the placeholder is refused. The SDK should accept `:` segments; this is a core follow-up.

A spec with fewer than 250 PMS operations, or one missing any key `plugin.yaml` locks, splits or makes a write by name (also when the key moves to plex.tv), is refused (`requiredKeys` in `src/locks.ts`). Tests pin a reduced copy (`test/fixtures/plex-api-spec.yaml`): all 405 operations with their parameters, summaries, `servers` and `security` as pinned; responses cut to their descriptions; example values and hex identifiers replaced with `EXAMPLE`. The in-process tests and a staged copy of the built bundle in the e2e test expect that file's own digest; the shipped bundle and `plugin.yaml` keep the upstream file's.

## Auth and requests

The `X-Plex-Token` header, from the connection's `token`. Every request also sends `Accept: application/json` (PMS answers XML otherwise), `X-Plex-Client-Identifier: synoikia-<instance id>` (stable, not secret) and `X-Plex-Product: Synoikia`.

Plex takes almost every argument in the query. `src/request.ts` runs on every call, before the split checks:

- A query with two keys that differ only in case is refused (`INVALID_PARAMS`).
- The keys in `plugin.canonicalKeys` (`ratingKey`, `sessionId`, `name`, `url`, `uri`, `prefs`, `own` and the refresh flags) are renamed to Plex's spelling, so splits, literals and targets read what Plex binds. Each takes one plain value: a list or an object is refused, since Plex would read a value the target or split didn't check (`url: [a, b]`).
- `X-Plex-Token` in the query is refused: the plugin authenticates.
- A query or body that holds `[REDACTED]` (a masked value from an earlier result) is refused: Plex would store it.

## Classification

GET reads, every other verb writes, and anything unsettled stays a write. Reviewed GETs:

| Operation | Classification |
| --- | --- |
| `GET /:/progress`, `/library/sections/{sectionId}/refresh`, `/match`, `/media/grabbers/devices/discover`, `/system/updates` | write: they set progress, start a scan, match items, scan the network or check for updates |
| `GET /library/metadata/{ids}/subtitles` | locked: adds a subtitle that Plex downloads from `url` |
| `GET /playQueues/{playQueueId}` | read; `#own` twin (below) |
| `GET /library/sections/{sectionId}/emptyTrash`, `/unmatch`, `/optimize`, `GET /library/optimize` | locked (below) |
| `GET /library/metadata/{ids}`, `GET /library/sections/{sectionId}/all` | read; `#refresh` twin (below) |
| 11 others the action-word heuristic flags (`/sync*`, `computePath`, `autocomplete`, history, play queues, playlist items, subscriptions) | read: the word is in the docs, not the behavior |

Excluded:

| Operation | Why |
| --- | --- |
| `GET /:/eventsource/*`, `/:/websocket/*`, `/:/websockets/*` | Push channels |
| `* /music/:/transcode`, `/photo/:/transcode`, `/{transcodeType}/:/transcode/*`, `* /downloadQueue*` | Transcoder, streams and downloads (binary) |
| Composite, chapter, artwork, BIF, part and thumb GETs, `GET /library/metadata/{ids}/file`, live TV segments | Binary media |
| `POST /library/metadata/{id}/arts`, `/posters`, `POST /playlists/upload`, `POST /library/file` | Uploads and imports from a path or URL |
| `GET /diagnostics/*`, `* /log`, `* /log/*` | Log and database bundles, log writes, the Papertrail upload |
| `POST /security/token`, `GET /security/resources` | Mint transient tokens |
| `GET /services/*` | Filesystem browsing; ultrablur fetches any URL |
| `POST /myplex/claim` | Binds the server to a plex.tv account |
| `* /library/streams/{streamId}.{ext}` | Two parameters in one segment, which the SDK can't fill |

## Locks

Each is locked with a typed confirmation. Literals come from a lookup of the stored item, the path or the server name (`friendlyName` from `GET /`), never from a value the model writes, except on create where the approver sees the query.

| Operation | Why | Literal |
| --- | --- | --- |
| `DELETE *` | Irreversible; covers deletes a newer spec adds | the stored title (lookup), else the path id, else server name |
| `DELETE /library/sections/{sectionId}` | Removes the library and its watch history | section title (`title1`) |
| `GET`, `POST`, `PUT /library/sections/{sectionId}/emptyTrash` | Removes every item whose files are missing | section title |
| `PUT …/analyze`, `GET …/unmatch`, `GET`, `POST …/optimize`, `* /library/optimize`, `PUT /library/clean/bundles` | Library-wide, long-running or loses matches | section title, else server name |
| `POST /library/sections/all`, `PUT /library/sections/{sectionId}`, `PUT …/{sectionId}/all` | New or changed folders are shown to every user with access to all libraries; bulk edit of every item | `name` on create, else section title |
| `DELETE /library/metadata/{ids}`, `…/media/{mediaItem}` | Deletes the media files when the server allows media deletion | item title; `<n> items` for a list of ids |
| `POST /library/metadata/{ids}/extras`, `POST`, `PUT /library/metadata/{ids}/{element}`, `POST /media/providers`, `POST /media/grabbers/devices` | Plex fetches from, or connects to, a URL the model gives | item title, else server name |
| `PUT /:/prefs` | Server settings: remote access, sign-in, allowed networks, sharing | server name |
| `PUT /updater/apply`, `POST /butler`, `POST /butler/{butlerTask}` | Installs an update; starts maintenance tasks | server name; the task name |
| `POST /status/sessions/terminate` | Stops someone's playback | the title being played |
| `DELETE /playlists`, `/playlists/{playlistId}`, `…/items` | Removes or empties a playlist | playlist title |
| `GET /library/metadata/{ids}#refresh`, `GET /library/sections/{sectionId}/all#refresh` | Taken when a flag in `plugin.refreshFlags` is not plainly off (`async*`, `checkFiles`, `checkFileAvailability`, `refreshLocalMediaAgent`, `refreshAnalysis`): file checks, refresh, analysis or online lookup of every item read | item or section title |
| `GET /playQueues/{playQueueId}#own` | Taken when `own` is not plainly off: takes the play queue over from the device playing it | play queue id |
| `GET /library/metadata/{ids}/subtitles` | Plex downloads a subtitle from the `url` given | item title |
| `PUT /library/sections/{sectionId}/move`, `/edit`, `/prefs` | Admin-only: moves the library folders, changes its metadata or settings | section title |
| `PUT`, `PATCH /livetv/dvrs/{dvrId}`, `PUT …/lineups`, `…/prefs`, `…/devices/{deviceId}` | Admin-only DVR settings, lineups and tuners | DVR id (the spec gives no name field to look up) |
| `PUT /media/grabbers/devices/{deviceId}`, `…/prefs`, `…/channelmap` | Admin-only: enables, disables or reconfigures a tuner | device id |

plex.tv sharing, friends and home users are out of scope, so there is nothing to lock there. PMS has no restart endpoint in the spec.

Admin-only writes (the spec's `admin` scope) left as ordinary writes:

| Operation | Why not locked |
| --- | --- |
| `PUT /library/metadata/{ids}`, `/prefs`, `/match`, `/unmatch`, `/merge`, `/split`, `/refresh`, `/analyze`, `/matches`, `/addetect`, `/credits`, `/intro`, `/voiceActivity`, `/chapterThumbs`, `/index` | One item's metadata, match or detection; reversible (`split` undoes `merge`, `unmatch` undoes `match`) and the target names the items |
| `POST /library/sections/{sectionId}/refresh`, `POST /library/sections/refresh` | Scans for new files; the most common write |
| `PUT /library/collections/{collectionId}/items`, `…/items/{itemId}`, `…/move`, `POST`, `PUT /hubs/sections/{sectionId}/manage/*`, `PUT /media/subscriptions/{subscriptionId}/move` | Collection membership and order, home-screen hubs, recording order; reversible |
| `PUT /actions/removeFromContinueWatching` | Hides one item from Continue Watching |
| `PUT /updater/check`, `PUT /myplex/refreshReachability`, `POST /livetv/dvrs/{dvrId}/reloadGuide` | Checks for or downloads an update (`apply` is locked), rechecks remote access, reloads the guide |
| `POST /livetv/dvrs` | Creates a DVR from a tuner already added (adding a tuner is locked) |

**Targets** (`capabilities.targets`). Writes name what they act on, right after the method and path, ahead of the query: the library section, up to 10 items (`Show – Title (year) [type]`), the playlist, the session (`user playing title on player`), the settings a `PUT /:/prefs` changes, and the origin of a `url` Plex fetches. Model-written strings are escaped.

## Secrets

- Manifest `sensitiveKeys`: `token`, `X-Plex-Token`, `authToken`, `accessToken`, `authenticationToken`, `PlexOnlineToken`, `password`, `secret`. Core masks them in params and results (`/myplex/account`, `/servers`, `/devices`).
- `src/mask.ts` masks what key names can't show: a token in a URL query (`X-Plex-Token`, `token`, `accessToken`, `authToken`) anywhere in a result, and the `value` of a server setting whose `id` names a secret (`PlexOnlineToken`, `customCertificateKey`) in `GET /:/prefs`.
- `sensitiveParams: [/query/url]` on every operation, and `/query/uri` on `POST /media/grabbers/devices`: a URL can carry a token, so the approval and audit log show only its origin, as a target (`fetches …`, `connects to …`).
