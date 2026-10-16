# Lidarr runbook

The plugin is tested against a fake Lidarr. This checklist confirms it against a real instance before a release. It takes about 15 minutes.

**Before you start:** a Lidarr v3 test instance with one artist that has track files, one download client with a password, one indexer and one notification (a webhook to a test endpoint you control). Copy the API key from Settings → General → Security.

1. **Connect.** New endpoint → **Lidarr**, base URL and key. **Test connection** reports the version (e.g. `3.1.6.5078`). A wrong key fails the test.
2. **Sync.** About 225 operations appear, grouped by tag (`Artist`, `Album`, `Queue`, `Command`, …). The instance shows the spec ref (`v<version>`). `GET /api/v1/filesystem`, `GET` and `POST /api/v1/manualimport` and `GET /api/v1/log/file` are absent. With the spec source set to an unreachable URL, the sync fails and the old catalog stays.
3. **Reads.** With `Artist`, `ArtistLookup`, `QualityProfile`, `MetadataProfile` and `RootFolder` at Read, ask for an artist lookup and the root folders: no prompt.
4. **Add an artist.** With `Artist` at Ask, add an artist from the lookup: a prompt shows `POST /api/v1/artist`; approve, and it appears in Lidarr.
5. **Command.** With `Command` at Ask, start `ArtistSearch` for that artist: an ordinary prompt; `GET /api/v1/command/{id}` reports `completed`. Ask for `RetagFiles`: the prompt is locked and asks to type `RetagFiles`.
6. **Locks.** Delete the artist from step 4 with `deleteFiles: true`: the prompt names the artist and its folder, says it deletes the files, and asks to type the artist name; a wrong value is refused. Ask to delete one track file: the prompt is locked and shows its path. Check `PUT /api/v1/config/host/{id}`, `PUT /api/v1/config/metadataprovider/{id}` and `POST /api/v1/system/restart` show locked on the Access page (don't run them).
7. **Secrets.** Read `GET /api/v1/downloadclient` and `GET /api/v1/notification`: the password shows as `********`, every URL with a path only as its origin, and `GET /api/v1/config/host` shows `apiKey` as `[REDACTED]`. Ask to test the stored download client with its `id` and another host: the prompt is locked and shows that host.
8. **Write-back guard.** Ask to save the host settings with the `[REDACTED]` value read in step 7: the call fails with `INVALID_PARAMS` before any approval.
9. **Audit.** The audit log lists each call; no password, API key or webhook token appears.
