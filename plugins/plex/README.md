# Plex

Exposes a Plex Media Server's HTTP API (303 operations: libraries, items, search, hubs, sessions and history, playlists, play queues, collections, scrobbling, preferences, butler, updater, Live TV and DVR) through Synoikia's `search` and `execute` tools. PMS doesn't serve a spec, so the catalog comes from the community spec [`LukeHagar/plex-api-spec`](https://github.com/LukeHagar/plex-api-spec) at a commit pinned in `plugin.yaml`, cut to the operations the server itself answers. plex.tv account and sharing APIs are out of scope. Design: [`docs/designs/plex.md`](../../docs/designs/plex.md).

The sandbox calls `plex.request({ method, path, query, body })`; arguments go in `query`:

```js
const libs = await plex.request({ path: '/library/sections/all' });
const key = libs.MediaContainer.Directory[0].key;
return await plex.request({
  path: `/library/sections/${key}/recentlyAdded`,
  query: { 'X-Plex-Container-Size': 10 },
});
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes Plex's API.

## Connection

The server's own address (usually port 32400), an `X-Plex-Token`, and optionally a mirror for the spec.

## Files

| File              | What                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `manifest.json`   | Binding, connection form, targets, `sensitiveKeys` and network hosts                                      |
| `plugin.yaml`     | Excluded routes, locks, the `#refresh` twin, reviewed GETs, confirmation literals, the pinned spec commit |
| `instructions.md` | Agent instructions (API shape, paging, common workflows); core adds it to the MCP server instructions     |
| `src/spec.ts`     | Spec loader at the pinned commit; drops plex.tv and cloud operations                                      |
| `src/catalog.ts`  | Settings, split predicate, custom confirmation sources, catalog build with `:` paths                      |
| `src/request.ts`  | Query keys: refuses case duplicates, a token and masked values; renames the keys the rules read           |
| `src/mask.ts`     | Tokens in result URLs and secret server settings                                                          |
| `src/targets.ts`  | Sections, items, playlists, sessions, settings and URL origins a call acts on, shown to the approver      |
| `src/locks.ts`    | Refuses a spec that lacks a locked operation                                                              |
| `test/`           | A fake PMS serving the pinned spec, unit, golden and e2e tests                                            |

## Locked operations

Every delete; emptying trash, analyzing, unmatching and optimizing libraries; cleaning bundles; adding or changing libraries and bulk edits; deleting items (and their files); anything that makes Plex fetch a URL or connect to a device; library, DVR and tuner settings; server settings; updates; butler tasks; ending a session; playlist deletes; reads with refresh or file-check flags; taking over a play queue. Reasons and literals are in the design note and `plugin.yaml`.
