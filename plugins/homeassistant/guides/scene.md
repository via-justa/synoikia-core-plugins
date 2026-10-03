# Scene best practices
- A scene stores target states; include only the attributes you want restored (state, brightness,
  color), not transient ones.
- Scenes don't support conditions or delays; use a script for sequences.
- Prefer creating a scene from the entities' desired states over copying the full current state.
