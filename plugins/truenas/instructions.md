# TrueNAS

TrueNAS 25.04+ JSON-RPC API. Operation keys are method names, as in `pool.dataset.query`. Call `truenas.call(method, ...params)`: each positional param is its own argument, as in `truenas.call('pool.dataset.delete', 'tank/apps', { recursive: true })`. Pools, users and API keys have integer ids; a dataset's or app's id is its name (`tank/media`); paths are under `/mnt/<pool>/`.

Query methods take `filters, options` as two arguments: filters like `[["name", "=", "tank"]]`, options `{ limit, offset, order_by, select }`. Job methods (`pool.scrub.run`, `app.upgrade`) are awaited; one outliving the script keeps running: see `core.get_jobs`.

Workflows:

- Storage: `pool.query` → `pool.dataset.query` → `pool.dataset.create` (`name: "<pool>/<path>"`).
- Share a folder: `pool.dataset.create` → `sharing.smb.create` (`path`, `name`) → `sharing.smb.query`.
- Apps: `app.query` → `app.upgrade` (app name).
- Health: `system.info`, `disk.query`, `pool.scrub.run`.
- Permissions: `filesystem.listdir` → `filesystem.setacl` or `filesystem.chown` inside a dataset.

Locked include: reboot, shutdown, config reset, pool export, disk wipe, `pool.dataset.delete`, dataset key changes, `pool.dataset.export_key`, user delete and passwords, `user.setup_local_administrator`, `auth.generate_token`, app delete, every `api_key.*` method, and ACL or owner changes at a pool root, outside `/mnt`, with `.`/`..` segments or with no `path` (`filesystem.setacl#pool-root`). Session and most `core.*` methods are excluded.
