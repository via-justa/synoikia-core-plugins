# Radarr

Radarr v3 REST API. Operation keys are `<VERB> <path>` with the full `/api/v3` prefix, as in `GET /api/v3/movie/{id}`. Ids are integers; a movie also has a TMDb `tmdbId`. Paged lists (`/api/v3/history`, `/api/v3/queue`, `/api/v3/wanted/missing`, `/api/v3/blocklist`) take `page` and `pageSize` and return `{ records, totalRecords }`.

Long work is a command: `POST /api/v3/command` with `{ name, ... }` returns its `id`; poll `GET /api/v3/command/{id}` until `status` is `completed` or `failed`.

Workflows:

- Add a movie: `GET /api/v3/movie/lookup` (`term`) → `GET /api/v3/qualityprofile` + `GET /api/v3/rootfolder` → `POST /api/v3/movie` with `tmdbId`, `qualityProfileId`, `rootFolderPath`, `monitored` and `addOptions.searchForMovie`.
- Downloads: `GET /api/v3/queue` (`includeMovie`), then `GET /api/v3/history`.
- Search missing: `GET /api/v3/wanted/missing` → `POST /api/v3/command` `MoviesSearch` or `MissingMoviesSearch`.
- Upcoming: `GET /api/v3/calendar` (`start`, `end`).
- Health: `GET /api/v3/system/status`, `GET /api/v3/health`, `GET /api/v3/diskspace`.

Download links are masked and link guids cut; a release with a masked guid can't be grabbed by `POST /api/v3/release`.

Locked (typed confirmation): deletes, bulk movie edits, deleting or moving files, file-changing commands, host and media management settings, new root folders, restart, backups, and creating or changing download clients, indexers, import lists and notifications. No filesystem browsing, manual-import scans or log downloads.
