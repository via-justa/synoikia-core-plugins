# Profilarr

Profilarr v2 links curated configuration databases (git repositories of quality profiles and custom formats) and syncs them into Radarr and Sonarr. Operation keys are `<VERB> <path>` under `/api/v1`, written without the prefix, as in `GET /databases/{id}`. Databases, arr instances and jobs have integer `id`s from their list calls; backups are addressed by `filename` (`backup-*.tar.gz`); announcements by ULID `id`. Lists return plain arrays, with no paging.

Long work is a job: `POST /databases/{id}/sync` and `POST /backups` return `202 { jobId }`; poll `GET /jobs/{id}` until `status` is `success` or `failed` (`result` has the output or error).

Workflows:

- Overview: `GET /status` (version, databases, arr sync state, jobs, backups), or `GET /health` for a quick check.
- Arr instances: `GET /arr`.
- Pull a database: `GET /databases` → `POST /databases/{id}/sync` → `GET /jobs/{id}`.
- Back up: `POST /backups` → `GET /jobs/{id}` → `GET /backups`; schedule and retention in `GET /backups/settings`.
- News: `GET /announcements` → `GET /announcements/{id}`.

The API has no endpoints for editing profiles or custom formats. Locked (a person types a confirmation): database link, sync, update and unlink, backup delete and backup settings.
