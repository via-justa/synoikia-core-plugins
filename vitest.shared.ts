import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The plugin harness (@synoikia/core/testing) runs isolated-vm, which requires --no-node-snapshot on Node >= 20.
  test: { include: ['test/**/*.test.ts'], execArgv: ['--no-node-snapshot'] },
});
