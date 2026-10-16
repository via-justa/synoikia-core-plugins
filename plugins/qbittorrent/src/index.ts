import { runPlugin } from '@synoikia/plugin-sdk';
import { createQbittorrentPlugin } from './plugin.js';

runPlugin(createQbittorrentPlugin());
