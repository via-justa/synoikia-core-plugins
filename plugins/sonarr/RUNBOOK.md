# Sonarr runbook

The plugin is tested against a fake Sonarr. This checklist confirms it against a real instance before a release. It takes about 15 minutes.

**Before you start:** a Sonarr v4 test instance with one series that has an episode file, one download client with a password, one indexer and one notification (a webhook to a test endpoint you control). Copy the API key from Settings → General → Security.

1. **Connect.** New endpoint → **Sonarr**, base URL and key. **Test connection** reports the version (e.g. `4.0.20.3014`). A wrong key fails the test.
2. **Sync.** About 224 operations appear, grouped by tag (`Series`, `Episode`, `Queue`, `Command`, …). The instance shows the spec ref (`v<version>`). `GET /api/v3/filesystem`, `GET` and `POST /api/v3/manualimport` and `GET /api/v3/log/file` are absent. With the spec source set to an unreachable URL, the sync fails and the old catalog stays.
3. **Reads.** With `Series`, `SeriesLookup`, `QualityProfile` and `RootFolder` at Read, ask for a series lookup and the root folders: no prompt.
4. **Add a series.** With `Series` at Ask, add a series from the lookup: a prompt shows `POST /api/v3/series`; approve, and it appears in Sonarr.
5. **Command.** With `Command` at Ask, start `SeriesSearch` for that series: an ordinary prompt; `GET /api/v3/command/{id}` reports `completed`. Ask for `RenameSeries`: the prompt is locked and asks to type `RenameSeries`.
6. **Locks.** Delete the series from step 4 with `deleteFiles: true`: the prompt names the series and its folder, says it deletes the files, and asks to type the title; a wrong value is refused. Ask to delete an episode file: the prompt names the series and file path. Check `POST /api/v3/seasonpass`, `PUT /api/v3/series/editor`, `PUT /api/v3/config/host/{id}`, `PUT /api/v3/config/mediamanagement/{id}`, `POST /api/v3/rootfolder` and `POST /api/v3/system/restart` show locked on the Access page (don't run them).
7. **Secrets.** Read `GET /api/v3/downloadclient` and `GET /api/v3/notification`: the password shows as `********`, every URL with a path only as its origin, and `GET /api/v3/config/host` shows `apiKey` as `[REDACTED]`. Ask to test the stored download client with its `id` and another host: the prompt is locked and shows that host.
8. **Write-back guard.** Ask to save the host settings with the `[REDACTED]` value read in step 7: the call fails with `INVALID_PARAMS` before any approval.
9. **Audit.** The audit log lists each call; no password, API key or webhook token appears.
