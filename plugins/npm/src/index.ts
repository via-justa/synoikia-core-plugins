import { runPlugin } from '@synoikia/plugin-sdk';
import { createNpmPlugin } from './plugin.js';

runPlugin(createNpmPlugin());
