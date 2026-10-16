# Mealie

Exposes a Mealie instance's REST API (about 235 operations: recipes, meal plans, shopping lists, organizers, households, groups, admin) through Synoikia's `search` and `execute` tools. The catalog comes from the OpenAPI spec the instance serves at `/openapi.json`, so a Mealie upgrade needs no change here. Design: [`docs/designs/mealie.md`](../../docs/designs/mealie.md).

The sandbox calls `mealie.request({ method, path, query, body })` with the full path, `/api/` included:

```js
const page = await mealie.request({ path: '/api/recipes', query: { search: 'pasta', perPage: 10 } });
return await mealie.request({ path: `/api/recipes/${page.items[0].slug}` });
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes Mealie's API.

## Connection

A base URL and a long-lived API token (User Profile → API Tokens) of a dedicated user. Make that user an admin only if Synoikia should manage users, groups and backups.

## Files

| File              | What                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `manifest.json`   | Binding, connection form, `sensitiveKeys` and network hosts                                           |
| `plugin.yaml`     | Excluded plumbing, locked operations, confirmation literals, sensitive params and results             |
| `instructions.md` | Agent instructions (API shape, paging, common workflows); core adds it to the MCP server instructions |
| `src/plugin.ts`   | Spec discovery, version and connection probe                                                          |
| `src/auth.ts`     | The bearer header                                                                                     |
| `test/`           | A fake Mealie serving the pinned v3.28.0 spec, unit, golden and e2e tests                             |

## Locked operations

Admin user, group and household changes; AI providers (group and admin); webhook create and update; group and household preferences; backup restore and delete; maintenance cleanup; the admin test email; bulk recipe delete and export purge; API token creation and deletion; password change and reset; user and household permission updates; invitations. The list, with reasons and confirmation literals, is in the design note and `plugin.yaml`.
