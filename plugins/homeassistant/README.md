# Home Assistant plugin

Exposes a Home Assistant instance through the two MCP tools, `search` and `execute`, behind core's permission gate. It covers:

- every service on the instance (from `get_services`, so a new integration needs no change here);
- the reads and config objects that aren't services: states, history, logbook, registries, automations, scripts, scenes and dashboards.

Design: [`docs/reference/homeassistant-mcp-design.md`](https://github.com/via-justa/home-server-mcps/blob/main/docs/reference/homeassistant-mcp-design.md), mapped onto the plugin hooks in [`docs/design/unified-mcp-server.md`](https://github.com/via-justa/home-server-mcps/blob/main/docs/design/unified-mcp-server.md) §3.3–§3.4.

## Connection

| Field      | Meaning                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| Base URL   | `http://homeassistant.local:8123` (a path is kept, for a reverse proxy).                                   |
| Token      | A long-lived access token (_Profile → Security_) of an administrator. Stored encrypted; never shown again. |
| Verify TLS | Leave on. Turn off only for a self-signed certificate on a trusted network.                                |

Home Assistant tokens can't be scoped below "everything this user can do", so an admin account is the operating assumption. A call the account can't make comes back as `UPSTREAM_DENIED`, not a crash.

## Calling it

```js
// search: find operations, entities, and the guide an automation edit needs
return await registry.find({ kind: 'entity', text: 'kitchen' });

// execute: services take service data plus a target (entity_id / area_id / device_id / floor_id / label_id,
// at the top level or under `target`)
await ha.call('light.turn_on', { area_id: 'living_room', brightness: 120 });
return await ha.call('get_states', { domain: 'lock' });
```

The only other operations are the fixed commands in `src/catalog.ts`. There is no raw WebSocket passthrough: anything not in the catalog is refused.

## Classification

- **Every service is a write**, whatever its name. HA's metadata can't tell "turn on a light" from "unlock a door", so nothing is inferred as a read. Groups are service domains (`light`, `lock`, `cover`), and every group starts at Read. So after the first sync, states and config can be read, but **no service can be called** until you raise its domain.
- **Reads:** `get_states` (filter by `entity_id`, `domain`, `area`), `get_config`, `history/history_during_period`, `logbook/get_events`, the registries, `config/{automation,script,scene}/config/get`, `lovelace/config`, `lovelace/dashboards/list`.
- **Locked** (always a human, with a name typed back; never pre-approved):
  - `lock.unlock`, `lock.open` and `alarm_control_panel.alarm_disarm`: type the entity name(s);
  - `homeassistant.restart`/`stop`, and `hassio.host_reboot`/`host_shutdown`/`restore_*`: type the location name;
  - opening a **garage door or gate** (`cover.open_cover`, `toggle` or `set_cover_position` → `#garage`). This is decided by device class, not name;
  - the generic `homeassistant.turn_on`, `turn_off` and `toggle` on a lock, alarm panel, garage door or gate (`#protected`). These would otherwise open or unlock through an unlocked service;
  - `scene.apply` setting a lock, alarm panel, garage door or gate, or an entity the registry doesn't know (type their names), and `scene.turn_on` on a stored scene that includes one (type the scene's name). Both are `#protected` twins;
  - every config delete: automations, scripts and scenes (type the alias), and registry entries (type the name).
- **Not covered:** a script or automation that itself unlocks a door (scenes are covered, above). Running it (`script.turn_on`, `automation.trigger`) is an ordinary write in its own domain, so keep those domains at Ask.

## Targets and rules

Before a service call is approved or matched, its target is expanded to the concrete entities it covers:

- areas cover their entities and the entities of their devices; floors cover their areas; labels cover labelled entities, devices and areas;
- as in HA, only entities of the service's domain are included (`light.turn_on` on a room doesn't touch its thermostat);
- an unknown area, device, floor, label or entity fails the call rather than resolving to nothing;
- the approval prompt names the entities ("Turn on (light.turn_on) on Living Room Ceiling, Reading Lamp"), and the call acts on exactly those.

If the room's membership changes while the approval waits, core refuses the call and it has to be made again.

The manifest declares its targets as **entities**, selectable by **area** and **domain** (core's generic `targets` declaration), so rules pick areas, domains and entities from the synced registry. Every resolved target must be inside the selection, so a call that also touches one kitchen light asks, even under a living-room rule. The raw `target` is covered by that condition automatically. Other parameters (brightness, temperature) still need their own condition or "any value".

## Editing automations, scripts, scenes and dashboards

1. Read the object: `ha.call('config/automation/config/get', { id })` returns `{ config, config_hash }`.
2. Read the guide in `search`: `guides.get('config/automation/config/update')` returns best practices and a `best_practice_key`. Creating or updating an automation, script or scene without one is refused.
3. Send a small JSON Patch:

   ```js
   await ha.call('config/automation/config/update', {
     id: 'morning',
     config_hash,
     best_practice_key,
     patch: [
       { op: 'replace', path: '/alias', value: 'Sunrise lights' },
       { op: 'add', path: '/triggers/-', value: { trigger: 'time', at: '07:00' } },
     ],
   });
   ```

   Ops are `add`, `remove`, `replace` and `test` (RFC 6902); `-` appends.

The approval shows a field-level diff. If the object changed since it was read, the call fails with `CONFIG_CONFLICT` before anyone is asked; if it changes while the approval waits, it fails at write time. `…/create` takes a full config and never overwrites an existing object. `lovelace/config/save` works the same way against `lovelace/config`.

## Redaction

Besides core's global list: `access_token`, `token`, `webhook_id`, `entity_picture` (camera URLs carry tokens), `stream_source`, `still_image_url`, `api_key`, `password`, `code` (lock and alarm codes) and `pin`.

## Development

```sh
pnpm --filter @synoikia/plugin-homeassistant test    # builds, then unit tests, SDK conformance and end to end
pnpm --filter @synoikia/plugin-homeassistant build   # dist/index.js (self-contained bundle)
```

The end-to-end suite (`test/e2e.test.ts`) runs the real core on the built bundle through core's plugin harness (`@synoikia/core/testing`).

The fake server (`test/fake-ha.ts`) speaks the WebSocket API and the REST config endpoints on one port. The live checklist for a real instance is in [`RUNBOOK.md`](RUNBOOK.md).
