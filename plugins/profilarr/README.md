# Profilarr

Exposes a Profilarr v2 instance's REST API (17 operations: arr instances, configuration databases and their sync, jobs, backups, announcements, health and status) through Synoikia's `search` and `execute` tools. The catalog comes from the OpenAPI spec the instance serves at `/api/v1/openapi.json`, so a Profilarr upgrade needs no change here. Design: [`docs/designs/profilarr.md`](../../docs/designs/profilarr.md).

The sandbox calls `profilarr.request({ method, path, query, body })` with a path under `/api/v1` (the prefix is optional):

```js
const { jobId } = await profilarr.request({ method: 'POST', path: '/databases/1/sync' });
return await profilarr.request({ path: `/jobs/${jobId}` });
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes Profilarr's API. Profilarr's API has no endpoints for editing quality profiles or custom formats.

## Connection

A base URL and the API key from Settings → Security (sent as `X-Api-Key`).

## Files

| File              | What                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `manifest.json`   | Binding, connection form, `sensitiveKeys` and network hosts                                         |
| `plugin.yaml`     | Excluded routes, locked operations, confirmation literals, sensitive params and results             |
| `instructions.md` | Agent instructions (API shape, jobs, common workflows); core adds it to the MCP server instructions |
| `src/plugin.ts`   | Spec discovery and version                                                                          |
| `src/locks.ts`    | Refuses a spec that lacks a locked operation                                                        |
| `src/auth.ts`     | The `X-Api-Key` header                                                                              |
| `test/`           | A fake Profilarr serving the pinned v2.2.0 spec, unit, golden and e2e tests                         |

## Locked operations

Database link, sync (pushes profiles into Radarr/Sonarr when auto-pull is on), update and unlink; any delete; backup delete; backup settings. Reasons and literals are in the design note and `plugin.yaml`.
