import { runPlugin } from '@synoikia/plugin-sdk';
import { createTrueNasPlugin } from './plugin.js';

// Behavior follows home-server-mcps docs/reference/truenas-mcp-design.md, mapped onto the plugin hooks in
// Synoikia design §3.3–§3.4 (docs/design/03-plugin-model.md).
runPlugin(createTrueNasPlugin());
