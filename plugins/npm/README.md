# Nginx Proxy Manager

Exposes a Nginx Proxy Manager instance's REST API (about 60 operations: proxy, redirection and 404 hosts, streams, certificates, access lists, users, settings, logs) through Synoikia's `search` and `execute` tools. The catalog comes from the OpenAPI spec the instance serves at `/api/schema`, so an upgrade needs no change here. Design: [`docs/designs/npm.md`](../../docs/designs/npm.md).

The sandbox calls `npm.request({ method, path, query, body })` with the path under `/api`:

```js
const hosts = await npm.request({ path: '/nginx/proxy-hosts', query: { expand: 'certificate' } });
return hosts.map((h) => [h.domain_names[0], h.certificate?.expires_on]);
```

Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes the API.

## Connection

A base URL (the admin UI, port 81 by default), and the email and password of a dedicated user without two-factor authentication. The plugin signs in and renews the session token itself.

## Files

| File              | What                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `manifest.json`   | Binding, connection form, `sensitiveKeys` and network hosts                                   |
| `plugin.yaml`     | Excluded plumbing, locked operations, the `#advanced` split, confirmation literals, secrets   |
| `instructions.md` | Agent instructions (API shape, common workflows); core adds it to the MCP server instructions |
| `src/plugin.ts`   | Spec discovery, version, probe, the `advanced_config` split and destinations in summaries     |
| `src/auth.ts`     | Sign-in with email and password, JWT renewal                                                  |
| `test/`           | A fake Nginx Proxy Manager serving the pinned v2.16.0 spec, unit, golden and e2e tests        |

## Locked operations

Proxy, redirection and stream creates and updates; 404 hosts with `advanced_config`; disabling any host, and enabling a proxy, redirection or stream host; every delete; access-list updates; all user, password, permission and 2FA changes; settings. The list, with reasons and confirmation literals, is in the design note and `plugin.yaml`.
