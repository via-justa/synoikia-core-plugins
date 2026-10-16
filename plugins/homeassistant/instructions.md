# Home Assistant

Home Assistant WebSocket API. Operation keys are services, `<domain>.<service>` as in `light.turn_on`, plus fixed commands such as `get_states`. Call `ha.call(key, params)`. Entity ids are `<domain>.<object_id>`; areas, floors, labels and devices have registry ids. Find them with `registry.find` in `search`.

A service takes its data plus a target (`entity_id`, `area_id`, `device_id`, `floor_id`, `label_id`, top level or under `target`); areas, floors and labels expand to the entities of the service's domain. `get_states` filters by `entity_id`, `domain` or `area`. History and logbook take `entity_ids` and ISO 8601 `start_time`/`end_time`.

Workflows:

- Control: `registry.find` → `get_states` → a service (`light.turn_off`, `cover.close_cover`).
- History: `history/history_during_period`, `logbook/get_events`.
- Edit an automation: `config/automation/config/get` (gives `config_hash`) → `guides.get('config/automation/config/update')` in `search` (gives `best_practice_key`) → `config/automation/config/update` with a JSON Patch. Scripts and scenes work alike; `create` takes a full config.
- Dashboards: `lovelace/dashboards/list` → `lovelace/config` → `lovelace/config/save` (JSON Patch).
- Registries: `config/area_registry/list`, `config/entity_registry/list`.

Locked: `lock.unlock` and lock open, alarm disarm, restart, stop, host reboot, shutdown and restores, opening a garage door or gate, scenes or toggles touching a lock, alarm or garage, and config or registry deletes.
