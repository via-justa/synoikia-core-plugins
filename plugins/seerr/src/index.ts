import { runPlugin } from '@synoikia/plugin-sdk';
import { createSeerrPlugin } from './plugin.js';

// Behavior follows home-server-mcps docs/reference/seerr-mcp-design.md, mapped onto the plugin hooks in
// docs/design/unified-mcp-server.md §3.3–§3.4.
runPlugin(createSeerrPlugin());
