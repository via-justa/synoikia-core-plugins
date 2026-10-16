# Lidarr plugin: design

Lidarr (https://github.com/Lidarr/Lidarr) manages a music library: artists and albums from MusicBrainz, searches indexers, sends releases to download clients, and imports, renames, retags and moves the files. This plugin exposes its v1 REST API through Synoikia's `search` and `execute` tools. It follows the [Radarr design](radarr.md) (Servarr code base); this note lists only what differs. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

As Radarr: `Startup.cs` mounts Swagger only `if (BuildInfo.IsDebug)`, so the spec comes from `src/Lidarr.Api.V1/openapi.json` at the tag `v<4-part version>` reported by `GET /api/v1/system/status`, else `develop`, from `specBaseUrl` (default `https://raw.githubusercontent.com/Lidarr/Lidarr`). Keys are the spec's paths, `/api/v1` included. Tests pin tag `v3.1.6.5078` (`test/fixtures/lidarr-openapi.json`, responses reduced to their descriptions, unreferenced schemas dropped).

`src/spec.ts`, `src/locks.ts`, `src/fields.ts`, `src/request.ts` and `src/auth.ts` are Radarr's, unchanged.

## Excluded

Radarr's list with the `/api/v1` prefix, plus `POST /api/v1/manualimport`: it re-reads the paths the caller names and returns their tags, which probes the host filesystem as the excluded GET does. `GET /api/v1/log/file*` also covers the update logs, and `GET /api/v1/mediacover/*` both the artist and the album covers.

## Locks

Radarr's locks for host settings, shutdown and restart, backups, providers, notification tests, `#stored` provider tests and actions, release push and `DELETE *`, with these Lidarr ones:

| Operation | Why | Literal |
| --- | --- | --- |
| `DELETE /api/v1/artist/{id}` (+ `#delete-files`) | Removes the artist; the twin, taken when `deleteFiles` is not plainly false, also deletes its files | artist name |
| `PUT /api/v1/artist/{id}#move-files` | `moveFiles` moves the artist folder on disk; the plain PUT stays a write | artist name |
| `PUT`, `DELETE /api/v1/artist/editor` (+ `#delete-files`) | Bulk edits, moves (`rootFolderPath` + `moveFiles`) and deletes | `<n> artists` |
| `DELETE /api/v1/album/{id}` (+ `#delete-files`) | Removes the album; the twin also deletes its files | album title |
| `DELETE /api/v1/trackfile/{id}`, `DELETE /api/v1/trackfile/bulk` | Always deletes the file from disk (to the recycle bin if set) | file path; `<n> track files` |
| `PUT /api/v1/config/metadataprovider/{id}` | Sets the metadata server Lidarr trusts and whether it rewrites the tags in audio files | instance name |
| `PUT /api/v1/config/mediamanagement/{id}` | `useScriptImport` and `scriptImportPath` run any program on each import; also file permissions, owner group and the recycle bin. The target shows the script first; a field the body leaves out or sends as null (or an empty path) comes from the stored settings | instance name |
| `POST /api/v1/rootfolder`, `PUT /api/v1/rootfolder/{id}` | A root folder at `/` makes Lidarr list every folder under it as unmapped and scan it. The PUT's "cannot edit path" check compares the body with itself, so it doesn't stop a path change | body `path` |
| `POST /api/v1/command#heavy` | Any command not in `plugin.quickCommands`: `RefreshArtist`, `RefreshAlbum`, `BulkRefreshArtist` (with `writeAudioTags: sync` and rescan `always`, a refresh rescans and rewrites the tags in the artist's files, as `RetagArtist` does), `RetagFiles`, `RetagArtist`, `RenameFiles`, `RenameArtist`, `MoveArtist`, `BulkMoveArtist`, `RescanFolders` (takes any folder and adds artists), `ManualImport`, `DownloadedAlbumsScan`, `ApplicationUpdateCheck` (installs an update when started by hand), `InstallPlugin`, `ResetApiKey`, … and future ones | the command name, else instance name |

Quick commands: `AlbumSearch`, `ArtistSearch`, `MissingAlbumSearch`, `CutoffUnmetAlbumSearch`, `RefreshMonitoredDownloads`, `RssSync`, `ImportListSync`, `CheckHealth`, `Housekeeping`, `Backup`.

`PUT /api/v1/album/{id}`, `PUT /api/v1/album/monitor`, `POST /api/v1/albumstudio` and `PUT /api/v1/trackfile/editor` change monitoring or stored quality only, so they stay writes.

**Targets.** Artist calls show `<name> at <folder>` (plus `→ <new folder>` on a PUT), the artist editor up to 10 artists and the new root folder, album calls `<title> by <artist>`, track file deletes each file's path (up to 10). Provider and release-push targets are Radarr's.

## Request keys and secrets

As Radarr. `plugin.canonicalKeys` adds `artistIds`, `trackFileIds`, `addImportListExclusion`, `useScriptImport` and `scriptImportPath`. Import list fields such as Spotify's `accessToken` and `refreshToken` are hidden by the secret-name rule in `src/fields.ts`.
