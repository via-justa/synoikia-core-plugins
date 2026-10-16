# Plex runbook

The plugin is tested against a fake PMS. This checklist confirms it against a real server before a release. It takes about 15 minutes.

**Before you start:** a test Plex Media Server with one movie library, one TV library, one playlist, and a client that can play. Get the owner's token (Plex Web → an item → ⋯ → Get Info → View XML; the URL ends with `X-Plex-Token=…`).

1. **Connect.** New endpoint → **Plex**, the server address (`http://<host>:32400`) and the token. **Test connection** reports the server version. A wrong token fails the test.
2. **Sync.** About 306 operations appear, grouped by tag (`Library`, `Hubs`, `Status`, …). The instance shows the pinned spec commit. No plex.tv operation (`/users/account.json`, `/friends`, `/shared_servers`) is present. With the spec source set to an unreachable URL, the sync fails and the old catalog stays.
3. **Reads.** With `Library`, `Content`, `Search` and `Status` at Read, ask for the libraries, recently added movies, a search, and what is playing: no prompt, and the results are JSON.
4. **Scrobble.** With `Timeline` at Ask, mark a movie watched (`PUT /:/scrobble`): an ordinary prompt; the movie shows as watched in Plex Web.
5. **Locks.** Ask to delete the playlist: the prompt names it and asks to type its title; a wrong value is refused (approve on a throwaway playlist). Ask to delete two items by `ids` `a,b` on a throwaway library: the prompt lists both and asks for `2 items` (also confirms that PMS accepts the encoded comma). Check `PUT /:/prefs`, `PUT /updater/apply` and `POST /status/sessions/terminate` show locked on the Access page; for terminate, start playback and check the prompt names the user, title and player (don't approve).
6. **Library admin.** Check `PUT /library/sections/{sectionId}/move` and `/edit` show locked on the Access page; ask to move a throwaway library's folder: the prompt names the library and asks to type its title (don't approve). Ask to add a subtitle from a URL (`GET /library/metadata/{ids}/subtitles`): locked, and the prompt shows only the URL's origin.
7. **Refresh flags.** `GET /library/metadata/{ids}` with `asyncRefreshAnalysis: 1` or `checkFiles: 1` asks for a typed confirmation; without the flag it reads. `GET /playQueues/{playQueueId}` with `own: 1` does too.
8. **Secrets.** Read `GET /:/prefs`: `PlexOnlineToken` shows as `[REDACTED]`. Read `GET /myplex/account`: `authToken` is `[REDACTED]`. Any URL in a result with `X-Plex-Token=` shows `[REDACTED]` as its value.
9. **Write-back guard.** Ask to set `PlexOnlineToken` to the `[REDACTED]` value read in step 8: the call fails with `INVALID_PARAMS` before any approval.
10. **Audit.** The audit log lists each call; no token appears.
