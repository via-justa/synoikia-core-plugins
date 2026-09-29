# TrueNAS plugin

Exposes a TrueNAS SCALE system's whole JSON-RPC API through the two MCP tools, `search` and `execute`, behind core's permission gate. The catalog comes from the live system (`core.get_methods`), so a TrueNAS upgrade needs no change here. Design: [`docs/reference/truenas-mcp-design.md`](https://github.com/via-justa/home-server-mcps/blob/main/docs/reference/truenas-mcp-design.md), mapped onto the plugin hooks in [`docs/design/unified-mcp-server.md`](https://github.com/via-justa/home-server-mcps/blob/main/docs/design/unified-mcp-server.md) §3.3–§3.4.

## Requirements

- **TrueNAS 25.04 or newer.** The plugin speaks the JSON-RPC 2.0 API at `wss://<host>/api/current`. The older `/websocket` protocol (24.10 and earlier) is not supported.
- **An API key.** In TrueNAS: _Credentials → API Keys → Add_. `FULL_ADMIN` is the accepted operating assumption. With a narrower role the plugin still works for what the role allows, and every call it can't make comes back as `UPSTREAM_DENIED` ("TrueNAS denied … insufficient permission"), not a crash.

## Connection

| Field      | Meaning                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL   | `https://truenas.internal.lan` (a path is kept, for a reverse proxy: `https://proxy.lan/truenas`). `http://` works but sends the key unencrypted. |
| API key    | Stored encrypted; never shown again.                                                                                                              |
| Verify TLS | Leave on. Turn off only for TrueNAS's default self-signed certificate on a trusted network.                                                       |

## Calling it

```js
// search: find methods and their parameters
return catalog.find({ text: 'dataset' });

// execute: params are positional, exactly as TrueNAS takes them
const pools = await truenas.call('pool.query', []);
return await truenas.call('pool.dataset.create', { name: 'tank/media/tv' });
```

Job methods (`app.upgrade`, `pool.scrub.run`, …) are waited for within the script's time budget. If the budget runs out first, the call fails with a message saying the job may still complete on TrueNAS.

## Classification

Every method is classified when the catalog syncs. Admins can override a classification, except on locked methods.

- **Locked** (always a human, with the name typed back; never pre-approved): `system.reboot`, `system.shutdown`, `config.reset`, `pool.export`, `disk.wipe`, `pool.dataset.delete`, `pool.dataset.change_key`, `user.delete`, `user.set_password`, and ACL/owner changes at a pool's root (`filesystem.setacl#pool-root`, `filesystem.chown#pool-root`: the call targets `/mnt/<pool>` itself, a path outside `/mnt`, or a path with `.`/`..` segments; only a plain path inside a pool gets the ordinary key). The typed name is the dataset, disk, pool or user being destroyed, or the system's hostname for reboot, shutdown and config reset.
- **Read** by name: `.query`, `.get_instance`, `.config`, `.status`, `.info`, `.choices` / `*_choices`, and `list…`, `get…`, `search…`.
- **Write** by name: `.create`, `.update`, `.delete`, `set_…`, and run/start/stop/restart/install/upgrade/reboot/shutdown/wipe/attach/detach/export/remove/replace.
- **Anything else is a write** (fail closed), shown with the reason `default:ambiguous` so an admin can reclassify it.

Not in the catalog at all: login/session methods, and every `core.*` method except `core.get_jobs`, `core.get_methods`, `core.ping` and `core.job_abort`. Methods such as `core.bulk` and `core.download` call other methods, so exposing them would bypass the locked list.

Access groups are namespaces (`pool.dataset`, `app`, `sharing.smb`). New groups start at Read.

## Pre-approval rules

Two match profiles are offered:

- `pool.dataset.create`: **name prefix** on `/0/name`, for example `tank/media` (it matches at a path boundary, so not `tank/media-private`).
- `app.upgrade`: **app in**, a pick from the installed apps (`/0`).

Rules are strict: any other option in the call (a `quota`, say) must be allowed explicitly with "any value", or the call falls back to asking a human.

## Redaction

Besides core's global list (passwords, tokens, secrets, …), results are redacted under `apiKey`, `bindpw`, `privatekey`, `monpwd` (UPS), `community` (SNMP) and the SSH host keys (`host_rsa_key`, `host_ecdsa_key`, `host_ed25519_key`; the matching `_pub` keys are hidden too). Keytab contents (`file` in `kerberos.keytab.*` results) are masked by the plugin itself, since `file` is too common a key name to redact everywhere.

## Development

```sh
pnpm --filter @synoikia/plugin-truenas test    # builds, then unit tests, SDK conformance and end to end
pnpm --filter @synoikia/plugin-truenas build   # dist/index.js (self-contained bundle)
```

The end-to-end suite (`test/e2e.test.ts`) runs the real core on the built bundle through core's plugin harness (`@synoikia/core/testing`).

The fake server (`test/fake-truenas.ts`) speaks the same JSON-RPC over WebSocket with a slice of a real `core.get_methods`. The live checklist for a real system is in [`RUNBOOK.md`](RUNBOOK.md).
