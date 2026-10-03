import { pluginFiles } from '@synoikia/create-plugin/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // plugin.yaml and guides load as the bundle sees them (synoikia-plugin build inlines them).
  plugins: [pluginFiles()],
  // The plugin harness (@synoikia/core/testing) runs isolated-vm, which requires --no-node-snapshot on Node >= 20.
  test: { include: ['test/**/*.test.ts'], execArgv: ['--no-node-snapshot'] },
});
