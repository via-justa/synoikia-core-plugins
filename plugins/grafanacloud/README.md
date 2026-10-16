# Grafana Cloud

Exposes the grafana.com Cloud API (54 operations: stacks, organizations and members, Cloud access policies and tokens, stack regions, plugins on stacks, and service accounts in a stack's Grafana) through Synoikia's `search` and `execute` tools. The catalog comes from the spec grafana.com publishes at `/api/openapi.json`, with the copy in `grafana/grafana-com-public-clients` on GitHub as the fallback. A stack's own Grafana API is the `grafana` plugin. Design: [`docs/designs/grafanacloud.md`](../../docs/designs/grafanacloud.md).

The sandbox calls `grafanacloud.request({ method, path, query, body })` with a path under `/api` (the prefix is optional):

```js
const { items } = await grafanacloud.request({ path: '/orgs/my-company/instances' });
return items.map((s) => ({ slug: s.slug, url: s.url, region: s.regionSlug }));
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes the grafana.com API.

## Connection

The organization slug and a Cloud access policy token (sent as `Authorization: Bearer`). The policy's scopes and realms bound what any call can do. Two advanced fields replace the API URL and the spec source, for a mirror.

## Files

| File              | What                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `manifest.json`   | Binding, connection form, `sensitiveKeys` and network hosts                                           |
| `plugin.yaml`     | Locked operations, confirmation literals, summary notes, sensitive results, spec URLs                 |
| `instructions.md` | Agent instructions (API shape, paging, common workflows); core adds it to the MCP server instructions |
| `src/plugin.ts`   | Connection, regional lookups and the binding                                                          |
| `src/spec.ts`     | Fetches the spec from each source in turn, falling back on any failure                                |
| `src/request.ts`  | Refuses keys Go would bind to one field (case variants, non-ASCII); one spelling for the rest         |
| `src/summary.ts`  | Privilege and destination fields ahead of the body in approvals                                       |
| `src/targets.ts`  | Names the stack, access policy (scopes and realms) or token an approval acts on                       |
| `src/locks.ts`    | Refuses a spec that lacks a locked operation                                                          |
| `src/auth.ts`     | The Bearer header                                                                                     |
| `test/`           | A fake grafana.com serving the pinned spec, unit, golden and e2e tests                                |

## Locked operations

Every write: stack create, update and delete; plugin install, update and uninstall; stack service accounts and their tokens; org members and settings; access policy and token create, update and delete; and every delete, PUT or PATCH a newer spec adds. Reasons and literals are in the design note and `plugin.yaml`.
