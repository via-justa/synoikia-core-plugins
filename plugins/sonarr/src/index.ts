import { runPlugin } from '@synoikia/plugin-sdk';
import { createSonarrPlugin } from './plugin.js';

runPlugin(createSonarrPlugin());
