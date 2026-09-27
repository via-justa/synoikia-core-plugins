import { defineConfig } from 'vitest/config';

// Resolve the SDK and core to their TypeScript sources (the source export condition) so tests don't depend
// on a build of the submodule. "hsm-source" is the pre-rebrand name; drop it once the submodule is past
// the rename. The rest mirrors Vite's default server conditions.
const conditions = ['synoikia-source', 'hsm-source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  // Core's harness runs isolated-vm, which requires --no-node-snapshot on Node >= 20.
  test: { include: ['test/**/*.test.ts'], execArgv: ['--no-node-snapshot'] },
});
