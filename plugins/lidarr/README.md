# Lidarr

Exposes a Lidarr instance's v1 REST API (225 operations: artists, albums, tracks, track files, lookups, queue, history, calendar, wanted, commands, quality and metadata profiles, custom formats, download clients, indexers, import lists, notifications, settings and system) through Synoikia's `search` and `execute` tools. Lidarr release builds don't serve their spec, so the catalog comes from `src/Lidarr.Api.V1/openapi.json` in Lidarr's repository at the tag of the installed version (`develop` if there is none). Design: [`docs/designs/lidarr.md`](../../docs/designs/lidarr.md).

The sandbox calls `lidarr.request({ method, path, query, body })` with the full `/api/v1` path:

```js
const { id } = await lidarr.request({
  method: 'POST',
  path: '/api/v1/command',
  body: { name: 'AlbumSearch', albumIds: [1] },
});
return await lidarr.request({ path: `/api/v1/command/${id}` });
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes Lidarr's API.

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
| `src/targets.ts`  | Artists, albums, track files and provider connections a call acts on, shown to the approver              |
| `src/request.ts`  | Case-insensitive keys: refuses case duplicates, renames the keys the rules read                          |
| `src/locks.ts`    | Refuses a spec that lacks a locked operation                                                             |
| `test/`           | A fake Lidarr serving the pinned v3.1.6.5078 spec, unit, golden and e2e tests                            |

## Locked operations

Every delete (track file deletes remove the file from disk); deleting artist or album files, moving artist folders; bulk artist edits; commands that rename, retag, move or delete files or change the application; host, media-management and metadata-provider settings; adding or changing root folders; shutdown and restart; backup restore; creating or changing download clients, indexers, import lists and notifications; notification tests; provider tests that reuse stored credentials; release push. Reasons and literals are in the design note and `plugin.yaml`.
