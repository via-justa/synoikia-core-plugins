# Automation best practices
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
