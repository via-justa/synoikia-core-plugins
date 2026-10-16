# Backstage

Exposes a Backstage backend's REST APIs (41 operations: the software catalog, the scaffolder, search, notifications and the events bus) through Synoikia's `search` and `execute` tools. The catalog comes from the OpenAPI spec each backend plugin serves at `/api/<plugin>/openapi.json`, merged, so a Backstage upgrade needs no change here. Design: [`docs/designs/backstage.md`](../../docs/designs/backstage.md).

The sandbox calls `backstage.request({ method, path, query, body })` with the full path:

```js
const page = await backstage.request({
  path: '/api/catalog/entities/by-query',
  query: { filter: 'kind=component,spec.owner=group:default/team-a', limit: 50 },
});
return page.items.map((e) => e.metadata.name);
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes Backstage's APIs.

## Connection

The backend URL, a static external-access token (sent as a Bearer token), and the backend plugins to load (default all five; one that is not installed is skipped).

## Files

| File              | What                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `manifest.json`   | Binding, connection form, `sensitiveKeys` and network hosts                                            |
| `plugin.yaml`     | Excluded routes, read POSTs, locked operations, confirmation literals, sensitive params and results    |
| `instructions.md` | Agent instructions (API shape, paging, common workflows); core adds it to the MCP server instructions  |
| `src/plugin.ts`   | Discovery, version and the binding                                                                     |
| `src/spec.ts`     | Loads each plugin's spec (skipping missing ones) and merges them, each confined to its `/api/<plugin>` |
| `src/targets.ts`  | The stored entity, location, task or template an approval names                                        |
| `src/locks.ts`    | Refuses a spec that lacks a locked operation                                                           |
| `test/`           | A fake Backstage serving the pinned v1.55.3 specs, unit, golden and e2e tests                          |

## Locked operations

Entity delete; location register, update and delete; scaffolder task create, cancel and retry; notification send; event-bus publish; any delete. Reasons and literals are in the design note and `plugin.yaml`.
