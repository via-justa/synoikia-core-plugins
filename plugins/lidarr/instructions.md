# Lidarr

Lidarr v1 REST API. Operation keys are `<VERB> <path>` with the full `/api/v1` prefix, as in `GET /api/v1/artist/{id}`. Ids are integers. Paged lists (`/api/v1/history`, `/api/v1/queue`, `/api/v1/wanted/missing`, `/api/v1/blocklist`) take `page` and `pageSize` and return `{ records, totalRecords }`.

Long work is a command: `POST /api/v1/command` with `{ name, ... }` returns its `id`; poll `GET /api/v1/command/{id}` until `status` is `completed` or `failed`.

Workflows:

- Add an artist: `GET /api/v1/artist/lookup` (`term`) → `GET /api/v1/qualityprofile` + `GET /api/v1/metadataprofile` + `GET /api/v1/rootfolder` → `POST /api/v1/artist` with the hit, `qualityProfileId`, `metadataProfileId`, `rootFolderPath`, `monitored` and `addOptions.searchForMissingAlbums`.
- Albums: `GET /api/v1/album` (`artistId`) → command `AlbumSearch`.
- Search missing: `GET /api/v1/wanted/missing` → `POST /api/v1/command` `MissingAlbumSearch`.
- Downloads: `GET /api/v1/queue` (`includeArtist`), then `GET /api/v1/history`.
- Upcoming: `GET /api/v1/calendar` (`start`, `end`).

Download links are masked and link guids cut; a release with a masked guid can't be grabbed by `POST /api/v1/release`.

Locked (typed confirmation): deletes, moving files, bulk artist edits, file-changing commands, host, media and metadata settings, root folders, restart, backups, and editing download clients, indexers, import lists and notifications. No filesystem browsing, manual-import scans or log downloads.
