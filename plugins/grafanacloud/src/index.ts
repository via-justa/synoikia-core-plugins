import { runPlugin } from '@synoikia/plugin-sdk';
import { createGrafanaCloudPlugin } from './plugin.js';

runPlugin(createGrafanaCloudPlugin());
