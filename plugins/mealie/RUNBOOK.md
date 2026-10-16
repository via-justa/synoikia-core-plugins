# Mealie runbook

The plugin is tested against a fake Mealie. This checklist confirms it against a real instance before a release. It takes about 15 minutes.

**Before you start:** create a dedicated Mealie user in a test group and household, make it an admin (for steps 5–6), sign in as it and generate an API token. Have a throwaway recipe and a throwaway second user.

1. **Connect.** New endpoint → **Mealie**, base URL and token. **Test connection** reports the Mealie version (e.g. `v3.28.0`). A wrong token fails the test.
2. **Sync.** About 235 operations appear, grouped by the API tags (`recipe__crud`, `households__shopping_lists`, …). `POST /api/auth/token`, `GET /api/media/…` and the `…/stream` endpoints are absent.
3. **Reads.** With `recipe__crud` at Read, ask the client to find a recipe by name: expect `GET /api/recipes` with `search`, then `GET /api/recipes/{slug}`, no prompt.
4. **A write.** With `recipe__crud` at Ask, import a recipe from a URL: expect a prompt showing `POST /api/recipes/create/url {"url":…}`; approve, and the recipe exists in Mealie.
5. **Secrets.** `GET /api/admin/about` shows `dbUrl` as `[REDACTED]` (Postgres installs). Creating an API token (`POST /api/users/api-tokens`, locked) returns `token` as `[REDACTED]`; delete that token in Mealie afterwards.
6. **Locks.** Delete the throwaway user with `DELETE /api/admin/users/{item_id}`: the approval asks to type its username, a wrong value is refused, the right one deletes it. Check `POST /api/admin/backups/{file_name}/restore` shows locked on the Access page (don't run it).
7. **Denied.** With a non-admin user's token, an admin read such as `GET /api/admin/users` reports `UPSTREAM_DENIED`.
8. **Audit.** The audit log lists each call; the password and token values from steps 5–6 appear nowhere.
