# Mealie plugin: design

Mealie (https://github.com/mealie-recipes/mealie) is a self-hosted recipe manager with meal plans and shopping lists. This plugin exposes its whole REST API through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

Mealie is a FastAPI app, so every instance serves its own OpenAPI 3.1 spec at `<baseUrl>/openapi.json` (FastAPI's default; Mealie's `API_DOCS` setting only toggles the `/docs` page). The plugin fetches it on every sync with the connection's token, so the catalog always matches the installed version and needs no spec mirror: `network.hosts` is only the instance. The version comes from `GET /api/app/about` (`version`).

Operation keys are the spec's own paths, `/api/` prefix included (`GET /api/recipes/{slug}`). The model passes the same path to `mealie.request({ method, path, query, body })`. A spec with fewer than 150 operations, or one missing any operation `plugin.yaml` locks by exact key (`src/locked-keys.ts`), is refused, so a truncated, wrong or renamed document never replaces a synced catalog or drops a lock.

Tests use a spec pinned from Mealie v3.28.0 (`plugins/mealie/test/fixtures/mealie-openapi.json`), generated from the tagged source with `app.openapi()`. Response schemas and unreferenced components are trimmed; paths, parameters and request bodies are as served. A test asserts every locked key exists in it, so an upstream rename fails CI instead of silently unlocking.

## Auth

A long-lived API token (User Profile → API Tokens), sent as `Authorization: Bearer`. It acts with that user's rights: a non-admin user's token simply gets 401/403 from the admin endpoints, which core reports as `UPSTREAM_DENIED`. `GET /api/app/about` is public, so the connection test also calls `GET /api/users/self` to prove the token.

## Classification

GET reads, every other verb writes, and anything the rules don't settle stays a write. The one GET the action heuristic flags, `GET /api/app/about/startup-info` ("start" in its summary), was reviewed and is a read.

Excluded (the model has no business calling them, or they carry raw files and backups): sign-in, OIDC, token refresh and logout (`/api/auth/*`), sign-up and forgot-password, media and file downloads (`/api/media/*`, `/api/utils/download`, backup and export download tokens), shared-recipe views by token, admin debug, multipart uploads (images, assets, zip and data migrations, backup upload, AI-from-image) and streaming (`…/stream`) endpoints.

## Locks

Each is locked with a typed confirmation. The literal is what the operation affects:

| Operations | Why | Literal |
| --- | --- | --- |
| Admin users: create, update, delete, unlock, password-reset token | Account and admin rights; a reset token takes over an account | username (lookup), email, or the group name |
| Admin groups and households: create, update, delete; admin AI providers | Deleting one drops its recipes, plans and members | group or household name (lookup) |
| `POST /api/admin/backups/{file_name}/restore`, `DELETE …/{file_name}` | Restore replaces every group, user and recipe | the backup file name |
| `POST /api/admin/maintenance/clean/*` | Deletes files instance-wide | group name |
| `POST /api/admin/email` | Sends mail from the instance to any address | the address |
| `POST /api/recipes/bulk-actions/delete`, `DELETE …/export/purge` | Bulk, irreversible | group name |
| `POST /api/users/api-tokens`, `DELETE /api/users/api-tokens/{token_id}` | Mints or revokes a credential (possibly this connection's) | token name, or the connection's user |
| `PUT /api/users/password`, `POST /api/users/reset-password` | Credential change | username, or email |
| `PUT /api/users/{item_id}`, `PUT /api/households/permissions` | User details and permissions | the stored username (lookup), never the body's |
| Group AI providers: create, update, delete | `baseUrl` and headers decide where the stored key and recipes go | group name |
| `POST /api/households/webhooks`, `PUT …/webhooks/{item_id}` | A webhook posts household data to its `url` | group name |
| `PUT /api/groups/preferences`, `PUT /api/households/preferences` | Privacy flags make recipes public without sign-in | group name |
| `POST /api/households/invitations`, `…/invitations/email` | Grants someone a way to join | group name, or the invitee's email |
| Every other `DELETE` (`DELETE *`), and one a newer spec adds | Irreversible: a recipe, food, unit, label, cookbook, meal plan, shopping list or item, organizer, webhook, notifier, comment, share link | the stored name or title (lookup), else the path id or slug; a bulk shopping-item delete, the group name |

A single recipe delete is locked too: the catch-all follows the convention that every plugin in this repository locks all deletes.

Literals never come from a body field the model writes about the target. Core redacts params whose names look secret (`token_id`) before the plugin summarizes them, so no literal is read from such a param.

## Secrets

- Manifest `sensitiveKeys`: `token`, `password`, `apiKey`, `api_key`, `access_token`, `secret`, `dbUrl` (a Postgres URL with its password, in `GET /api/admin/about`) and `appriseUrl` (notifier URLs carry service credentials).
- `sensitiveResult`: `token` on token creation, password-reset tokens and invitations; `dbUrl` on admin about; `url` (deep) on webhooks and on the groups and households that embed them; `requestHeaders`/`requestParams` (deep) on AI providers.
- `sensitiveParams`: passwords and reset tokens, the invitation token, AI provider `apiKey`/headers/params, notifier `appriseUrl`. A webhook `url` and an AI provider `baseUrl` stay visible in approvals, so the approver sees the destination; webhook URLs are masked in results.

Mealie's SMTP settings are environment variables only; the API exposes no email settings, just the test send above.
