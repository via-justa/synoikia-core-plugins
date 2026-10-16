# Radarr

Exposes a Radarr instance's v3 REST API (227 operations: movies, lookups, queue, history, calendar, wanted, commands, profiles, custom formats, download clients, indexers, import lists, notifications, settings and system) through Synoikia's `search` and `execute` tools. Radarr release builds don't serve their spec, so the catalog comes from `src/Radarr.Api.V3/openapi.json` in Radarr's repository at the tag of the installed version (`develop` if there is none). Design: [`docs/designs/radarr.md`](../../docs/designs/radarr.md).

The sandbox calls `radarr.request({ method, path, query, body })` with the full `/api/v3` path:

```js
const { id } = await radarr.request({
  method: 'POST',
  path: '/api/v3/command',
  body: { name: 'MoviesSearch', movieIds: [1] },
});
return await radarr.request({ path: `/api/v3/command/${id}` });
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes Radarr's API.

## Connection

A base URL, the API key from Settings → General → Security (sent as `X-Api-Key`), and optionally a mirror for the spec.

## Files

| File              | What                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `manifest.json`   | Binding, connection form, targets, `sensitiveKeys` and network hosts                                     |
| `plugin.yaml`     | Excluded routes, locks, split twins, confirmation literals, sensitive params and results, quick commands |
| `instructions.md` | Agent instructions (API shape, commands, common workflows); core adds it to the MCP server instructions  |
| `src/spec.ts`     | Servarr spec loader: 4-part version → release tag, fallback branch, mirror                               |
| `src/catalog.ts`  | Settings, split predicates, custom confirmation sources, catalog build                                   |
| `src/fields.ts`   | Provider `fields[]`: secret masking in results, destinations, refusing masked values in writes           |
| `src/targets.ts`  | Movies and provider connections a call acts on, shown to the approver                                    |
| `src/request.ts`  | Case-insensitive keys: refuses case duplicates, renames the keys the rules read                          |
| `src/locks.ts`    | Refuses a spec that lacks a locked operation                                                             |
| `test/`           | A fake Radarr serving the pinned v6.4.4.10685 spec, unit, golden and e2e tests                           |

## Locked operations

Every delete; deleting or moving movie files; bulk movie edits; commands that rename, move or delete files or change the application; host and media management settings (import script); new root folders; shutdown and restart; backup restore; creating or changing download clients, indexers, import lists and notifications; notification tests; provider tests that reuse stored credentials; release push. Reasons and literals are in the design note and `plugin.yaml`.
