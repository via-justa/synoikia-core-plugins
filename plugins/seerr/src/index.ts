import { runPlugin } from '@synoikia/plugin-sdk';
import { createSeerrPlugin } from './plugin.js';

// Behavior follows home-server-mcps docs/reference/seerr-mcp-design.md, mapped onto the plugin hooks in
// Synoikia design §3.3–§3.4 (docs/design/03-plugin-model.md).
runPlugin(createSeerrPlugin());
