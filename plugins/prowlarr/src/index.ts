import { runPlugin } from '@synoikia/plugin-sdk';
import { createProwlarrPlugin } from './plugin.js';

runPlugin(createProwlarrPlugin());
