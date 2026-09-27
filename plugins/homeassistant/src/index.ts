import { runPlugin } from '@synoikia/plugin-sdk';
import { createHomeAssistantPlugin } from './plugin.js';

// Behavior follows home-server-mcps docs/reference/homeassistant-mcp-design.md, mapped onto the plugin hooks in
// docs/design/unified-mcp-server.md §3.3–§3.4.
runPlugin(createHomeAssistantPlugin());
