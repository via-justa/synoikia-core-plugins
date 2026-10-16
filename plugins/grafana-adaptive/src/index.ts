import { runPlugin } from '@synoikia/plugin-sdk';
import { createGrafanaAdaptivePlugin } from './plugin.js';

runPlugin(createGrafanaAdaptivePlugin());
