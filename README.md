# synoikia-core-plugins

The core plugins for [Synoikia](https://github.com/via-justa/home-server-mcps), the self-hosted MCP control plane. Core plugins ship with Synoikia and are trusted like core itself (design §4.1).

## Layout

| Path                 | What                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `plugins/<id>`       | One package per plugin: `manifest.json`, `src/`, `test/`, bundled to `dist/index.js` with esbuild |
| `tsconfig.base.json` | Shared compiler options; each plugin's `tsconfig.json` extends it                                 |
| `vitest.shared.ts`   | Shared Vitest config; each plugin's `vitest.config.ts` re-exports it                              |

Plugins build against Synoikia's published npm packages, the same way a community plugin would:

- `@synoikia/plugin-sdk`: the manifest schema, RPC contract and `runPlugin()` runtime. The bundle includes it.
- `@synoikia/core` (dev only): its `@synoikia/core/testing` export is the plugin harness. It boots the real core on the built bundle, running as a permission-confined child as in production, so each plugin's end-to-end tests run against its own fake upstream.

## Development

Requires Node ≥ 22.12 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm test        # builds each plugin's bundle, then runs its unit and e2e tests
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build       # every plugin bundle
```

Work on one plugin with `pnpm --filter ./plugins/<id> test`.

## Adding a plugin

Create `plugins/<id>/` with:

- `manifest.json`: validated by the SDK's schema. `id` matches the directory name; `entry` is `dist/index.js`.
- `package.json`: named `@synoikia/plugin-<id>`, `private: true`, depending on `@synoikia/plugin-sdk` and, as a dev dependency, `@synoikia/core`, with these scripts:

  ```json
  {
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/index.js --log-level=warning --banner:js=\"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);\"",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "pnpm run build && vitest run"
  }
  ```

  The `createRequire` banner lets the ESM bundle `require()` Node built-ins for bundled CommonJS dependencies such as `ws`.

- `tsconfig.json` (extends `../../tsconfig.base.json`, includes `src` and `test`, `noEmit`), `tsconfig.build.json` and `vitest.config.ts` (`export { default } from '../../vitest.shared.ts';`).

The bundle must be self-contained: under the permission model the child can read nothing outside its own package directory, so every runtime dependency goes into `dist/index.js`. A release ships only `manifest.json`, `package.json` and `dist/`.

## Updating Synoikia

The SDK and harness versions are pinned by each plugin's `package.json` range and the lockfile. To take a newer release, bump the ranges and run `pnpm install`. A plugin change that needs a core change waits for the Synoikia release that carries it.

## CI

`.github/workflows/ci.yml` runs lint, format check, typecheck and every plugin's tests. It needs no secrets.
