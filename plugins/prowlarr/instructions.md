# Prowlarr

Prowlarr v1 REST API. Operation keys are `<VERB> <path>` with the full `/api/v1` prefix, as in `GET /api/v1/indexer/{id}`. Ids are integers from list calls: indexers from `GET /api/v1/indexer`, synced apps (Sonarr, Radarr, …) from `GET /api/v1/applications`. `GET /api/v1/history` takes `page` and `pageSize` and returns `{ records, totalRecords }`.

Long work is a command: `POST /api/v1/command` with `{ name }` returns its `id`; poll `GET /api/v1/command/{id}` until `status` is `completed` or `failed`.

Workflows:

- Indexer health: `GET /api/v1/indexer`, `GET /api/v1/indexerstatus`, `GET /api/v1/health`.
- Search: `GET /api/v1/search` with `query`, `type` (`search`, `tvsearch`, `movie`, …), `indexerIds` and `categories` (lists), `limit`.
- Test indexers: `POST /api/v1/indexer/testall`; one stored indexer: `POST /api/v1/indexer/test` with its body from `GET /api/v1/indexer/{id}` (locked).
- Activity: `GET /api/v1/history` (`indexerIds`, `eventType`), `GET /api/v1/indexerstats`.
- App sync: `GET /api/v1/applications` (`syncLevel`, tags), `GET /api/v1/appprofile`.

Download links and history URLs are masked, link guids cut; a release with a cut guid can't be grabbed by `POST /api/v1/search`, so say so.

Locked (typed confirmation): deletes, changing indexers, applications, proxies, download clients or notifications, application and stored-connection tests, bulk edits, sync and update commands, host settings, restart, backups. Filesystem, log files and the Newznab/download proxy are not available.
