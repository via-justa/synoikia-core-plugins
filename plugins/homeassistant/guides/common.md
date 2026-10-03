- Read before you write: use config/<type>/config/get for an existing object, and edit it with a
  small JSON Patch against the returned config_hash instead of resending the whole config.
- Refer to entities by entity_id (look them up with registry.find or get_states), never by
  friendly name. Prefer areas or labels as targets when the user means "all the lights in …".
- Give the object an alias and a description that say what it does and why.
- Don't store secrets in the config; use !secret in YAML or a helper instead.
