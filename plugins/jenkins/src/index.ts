import { runPlugin } from '@synoikia/plugin-sdk';
import { createJenkinsPlugin } from './plugin.js';

runPlugin(createJenkinsPlugin());
