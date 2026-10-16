# Sonarr

Sonarr v4 REST API. Operation keys are `<VERB> <path>` with the full `/api/v3` prefix, as in `GET /api/v3/series/{id}`. Ids are integers; a series also has a TVDB `tvdbId`. Episodes belong to a series (`seriesId`). Paged lists (`/api/v3/history`, `/api/v3/queue`, `/api/v3/wanted/missing`) take `page` and `pageSize` and return `{ records, totalRecords }`.

Long work is a command: `POST /api/v3/command` with `{ name, ... }` returns its `id`; poll `GET /api/v3/command/{id}` until `status` is `completed` or `failed`.

Workflows:

- Add a series: `GET /api/v3/series/lookup` (`term`) → `GET /api/v3/qualityprofile` + `GET /api/v3/rootfolder` → `POST /api/v3/series` with `tvdbId`, `title`, `qualityProfileId`, `rootFolderPath`, `monitored`, `seasonFolder` and `addOptions`.
- Search missing: `GET /api/v3/episode` (`seriesId`) → `POST /api/v3/command` `SeriesSearch` (`seriesId`) or `EpisodeSearch` (`episodeIds`).
- Downloads: `GET /api/v3/queue` (`includeSeries`), then `GET /api/v3/history`.
- Upcoming: `GET /api/v3/calendar` (`start`, `end`).

Download links are masked and link guids cut; a release with a masked guid can't be grabbed by `POST /api/v3/release`.

Locked: deletes, bulk series edits and season pass, deleting or moving files, file-changing commands, host and media management settings, new root folders, restart, backups, and download client, indexer, import list and notification changes. No filesystem browsing, manual-import scans or log downloads.
