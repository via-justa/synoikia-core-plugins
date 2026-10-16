# Profilarr runbook

The plugin is tested against a fake Profilarr. This checklist confirms it against a real instance before a release. It takes about 10 minutes.

**Before you start:** a Profilarr v2 test instance with one linked database (the default Dictionarry one is fine) and one Radarr or Sonarr instance. Generate an API key in Settings → Security.

1. **Connect.** New endpoint → **Profilarr**, base URL and key. **Test connection** reports the version (e.g. `2.2.0`). A wrong key fails the test.
2. **Sync.** 17 operations appear, grouped by tag (`Arr`, `Databases`, `Backups`, …). `GET /openapi.json`, `GET /backups/{filename}` and `POST /backups/upload` are absent.
3. **Reads.** With `System` and `Arr` at Read, ask for the status and the arr instances: `GET /status`, `GET /arr`, no prompt. No `api_key` value appears.
4. **A write and a job.** With `Backups` at Ask, create a backup: a prompt shows `POST /backups`; approve, then `GET /jobs/{id}` reports `success` and `GET /backups` lists the file.
5. **Locks.** `POST /databases/{id}/sync` shows the database name and repository and asks to type the name; a wrong value is refused, the right one enqueues the sync. Delete the backup from step 4 with `DELETE /backups/{filename}`, typing its file name. Check `DELETE /databases/{id}` and `PATCH /backups/settings` show locked on the Access page (don't run them).
6. **Secrets.** Link a private test database with a GitHub token (`POST /databases`, locked: type `Profilarr`): the prompt shows the repository URL but `personal_access_token` as `[REDACTED]`. Unlink it in the UI afterwards.
7. **Audit.** The audit log lists each call; the token from step 6 appears nowhere.
