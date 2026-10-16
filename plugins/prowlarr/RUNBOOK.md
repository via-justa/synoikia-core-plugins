# Prowlarr runbook

The plugin is tested against a fake Prowlarr. This checklist confirms it against a real instance before a release. It takes about 15 minutes.

**Before you start:** a Prowlarr v2 test instance with one Newznab indexer, one Cardigann (private tracker) indexer with a user name and password, one application (a Sonarr or Radarr test instance), one download client with a password, and one notification (a webhook to a test endpoint you control). Copy the API key from Settings → General → Security.

1. **Connect.** New endpoint → **Prowlarr**, base URL and key. **Test connection** reports the version (e.g. `2.6.5.5623`). A wrong key fails the test.
2. **Sync.** About 118 operations appear, grouped by tag (`Indexer`, `Search`, `Application`, …). The instance shows the spec ref (`v<version>`). `GET /api/v1/filesystem`, `GET /api/v1/log/file` and `GET /api/v1/indexer/{id}/newznab` are absent. With the spec source set to an unreachable URL, the sync fails and the old catalog stays.
3. **Reads.** With `Indexer`, `IndexerStatus`, `IndexerStats` and `Search` at Read, ask for the indexers and their health, then search for a title across them: no prompt. In the results, `downloadUrl` and `magnetUrl` show `[REDACTED]`, and a guid that is a link shows only its origin.
4. **Command.** With `Command` at Ask, start `CheckHealth`: an ordinary prompt; `GET /api/v1/command/{id}` reports `completed`. Ask for `ApplicationIndexerSync`: the prompt is locked and asks to type `ApplicationIndexerSync`.
5. **Locks.** Ask to test the application with its `id`: the prompt is locked, names the application and its hosts, and asks to type its name; a wrong value is refused. Check `POST /api/v1/applications`, `PUT /api/v1/indexer/{id}`, `PUT /api/v1/indexer/bulk`, `PUT /api/v1/config/host/{id}` and `POST /api/v1/system/restart` show locked on the Access page (don't run them).
6. **Secrets.** Read `GET /api/v1/indexer`, `GET /api/v1/applications` and `GET /api/v1/downloadclient`: API keys and passwords show as `********`; the Cardigann password, cookie and passkey as `[REDACTED]`. `GET /api/v1/history` shows `data.url` as `[REDACTED]`, and `GET /api/v1/config/host` shows `apiKey` as `[REDACTED]`.
7. **Write-back guard.** Ask to save the Cardigann indexer with the `[REDACTED]` password read in step 6: the call fails with `INVALID_PARAMS` before any approval.
8. **Audit.** The audit log lists each call; no password, API key, cookie, passkey or webhook token appears.
