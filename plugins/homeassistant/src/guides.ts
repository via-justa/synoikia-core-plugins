import { createHash } from 'node:crypto';

/**
 * Best-practice guides behind the attestation gate (HA §3.6): `guides.get(key)` returns one of these
 * with a `best_practice_key`, which create/update calls must present. The version is a hash of the
 * content, so editing a guide invalidates keys issued for the old text.
 */

const COMMON = `
- Read before you write: use config/<type>/config/get for an existing object, and edit it with a
  small JSON Patch against the returned config_hash instead of resending the whole config.
- Refer to entities by entity_id (look them up with registry.find or get_states), never by
  friendly name. Prefer areas or labels as targets when the user means "all the lights in …".
- Give the object an alias and a description that say what it does and why.
- Don't store secrets in the config; use !secret in YAML or a helper instead.
`;

const AUTOMATION = `# Automation best practices
- Trigger on the event that matters (state, numeric_state, time, sun, event); never poll with a
  time_pattern trigger when a state trigger would do.
- Use "for:" on state triggers to ride out flapping sensors, and conditions to express "only when".
- Pick the mode deliberately: single (default) drops overlapping runs, restart suits motion lights,
  queued/parallel suit notifications. Set max for queued/parallel.
- Give every trigger an id when actions branch on which one fired (choose + trigger condition).
- Guard physical actions (locks, covers, heating) with conditions on presence, time or state, and
  prefer notifying over acting for anything security-related.
- Keep actions idempotent: turning on a light that is on is fine; toggling is not.
- Use the automation's own id for the config id (a stable unique string).
${COMMON}`;

const SCRIPT = `# Script best practices
- A script is a reusable action sequence; put the "when" in an automation that calls it.
- Declare fields with a name, description and selector so callers (and the UI) know the inputs.
- Choose the mode (single, restart, queued, parallel) for how concurrent calls should behave.
- Use continue_on_error only for truly optional steps, and wait_for_trigger with a timeout.
- The config id is the script's object id: script.<id> is the resulting entity.
${COMMON}`;

const SCENE = `# Scene best practices
- A scene stores target states; include only the attributes you want restored (state, brightness,
  color), not transient ones.
- Scenes don't support conditions or delays; use a script for sequences.
- Prefer creating a scene from the entities' desired states over copying the full current state.
${COMMON}`;

const GUIDES: Record<string, string> = {
  automation: AUTOMATION.trim(),
  script: SCRIPT.trim(),
  scene: SCENE.trim(),
};

/** The guide for an attestation-required operation key, or undefined. */
export function guideFor(key: string): { version: string; content: string } | undefined {
  const type = /^config\/(automation|script|scene)\/config\/(create|update)$/.exec(key)?.[1];
  const content = type ? GUIDES[type] : undefined;
  if (!content) return undefined;
  return { version: createHash('sha256').update(content).digest('hex').slice(0, 12), content };
}
