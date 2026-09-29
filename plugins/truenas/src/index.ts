import { runPlugin } from '@synoikia/plugin-sdk';
import { createTrueNasPlugin } from './plugin.js';

// Behavior follows home-server-mcps docs/reference/truenas-mcp-design.md, mapped onto the plugin hooks in
// docs/design/unified-mcp-server.md §3.3–§3.4.
runPlugin(createTrueNasPlugin());
