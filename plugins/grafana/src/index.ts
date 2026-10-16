import { runPlugin } from '@synoikia/plugin-sdk';
import { createGrafanaPlugin } from './plugin.js';

runPlugin(createGrafanaPlugin());
