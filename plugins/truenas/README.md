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

Every method is classified when the catalog syncs, from what TrueNAS declares; admins can't change it. The locked list wins. Then the roles a method requires (from `core.get_methods`), which can only make a method stricter or settle an unclear name: a method that declares only write roles is a write, and one a read-only role may call (`READONLY_ADMIN` or any `*_READ` role, such as `POOL_READ`) is a read unless its name says write. Methods that declare no roles go by their names:

- **Locked** (always a human, with the name typed back; never pre-approved): `system.reboot`, `system.shutdown`, `config.reset`, `pool.export`, `disk.wipe`, `pool.dataset.delete`, `pool.dataset.change_key`, `user.delete`, `user.set_password`, `app.delete`, `audit.config`, `auth.generate_token`, `docker.delete_backup`, `interface.network_config_to_be_removed`, `user.has_local_administrator_set_up`, `user.renew_2fa_secret`, `user.setup_local_administrator`, every `api_key.*` method, and ACL/owner changes at a pool's root (`filesystem.setacl#pool-root`, `filesystem.chown#pool-root`: the call targets `/mnt/<pool>` itself, a path outside `/mnt`, or a path with `.`/`..` segments; only a plain path inside a pool gets the ordinary key). The typed name is the dataset, disk, pool, app, backup, API key or user being acted on (for a new API key, the user it acts as), or the system's hostname for the rest (reboot, shutdown, config reset, token generation and the like).
- **Read** by name: `.query`, `.get_instance`, `.config`, `.status`, `.info`, `.choices` / `*_choices`, and `list…`, `get…`, `search…`.
- **Write** by name: `.create`, `.update`, `.delete`, `set_…`, and run/start/stop/restart/install/upgrade/reboot/shutdown/wipe/attach/detach/export/remove/replace.
- **Anything else is a write** (fail closed), shown with the reason `default:ambiguous`.

Not in the catalog at all: login/session methods, and every `core.*` method except `core.get_jobs`, `core.get_methods`, `core.ping` and `core.job_abort`. Methods such as `core.bulk` and `core.download` call other methods, so exposing them would bypass the locked list.

Access groups are namespaces (`pool.dataset`, `app`, `sharing.smb`). New groups start at Read.

## Pre-approval rules

Two match profiles are offered:

- `pool.dataset.create`: **name prefix** on `/0/name`, for example `tank/media` (it matches at a path boundary, so not `tank/media-private`).
- `app.upgrade`: **app in**, a pick from the installed apps (`/0`).

Rules are strict: any other option in the call (a `quota`, say) must be allowed explicitly with "any value", or the call falls back to asking a human.

## Redaction

Besides core's global list (passwords, tokens, secrets, …), results are redacted under `apiKey`, `bindpw`, `privatekey`, `monpwd` (UPS), `community` (SNMP) and the SSH host keys (`host_rsa_key`, `host_ecdsa_key`, `host_ed25519_key`; the matching `_pub` keys are hidden too). The plugin masks secrets core can't recognize by key name: keytab contents (`file` in `kerberos.keytab.*` results), API and encryption keys (`key` in `api_key.*`, `pool.dataset.*` and `pool.create` results), and results that are a secret string themselves (`auth.generate_token`, `auth.generate_onetime_password`, `pool.dataset.export_key`, `user.provisioning_uri`). Job records from `core.get_jobs` are masked by the job's own method, so a result can't be read back later. Encryption keys passed as parameters (`encryption_options.key`, `datasets[].key`) are kept out of approval summaries and job records; keeping them out of the audit log needs core's `sensitiveParams`, like the local administrator password below. The password `user.setup_local_administrator` takes as its second argument is left out of the approval summary; keeping it out of the approval record and audit log as well needs a core release with `sensitiveParams`.

## Development

```sh
pnpm --filter @synoikia/plugin-truenas test    # builds, then unit tests, SDK conformance and end to end
pnpm --filter @synoikia/plugin-truenas build   # dist/index.js (self-contained bundle)
```

The end-to-end suite (`test/e2e.test.ts`) runs the real core on the built bundle through core's plugin harness (`@synoikia/core/testing`).

The fake server (`test/fake-truenas.ts`) speaks the same JSON-RPC over WebSocket with a slice of a real `core.get_methods`. The live checklist for a real system is in [`RUNBOOK.md`](RUNBOOK.md).
