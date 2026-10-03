# Script best practices
- A script is a reusable action sequence; put the "when" in an automation that calls it.
- Declare fields with a name, description and selector so callers (and the UI) know the inputs.
- Choose the mode (single, restart, queued, parallel) for how concurrent calls should behave.
- Use continue_on_error only for truly optional steps, and wait_for_trigger with a timeout.
- The config id is the script's object id: script.<id> is the resulting entity.
