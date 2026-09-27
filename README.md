# synoikia-core-plugins

The core plugins for [Synoikia](https://github.com/via-justa/home-server-mcps), the self-hosted MCP control plane. Core plugins ship with Synoikia and are trusted like core itself (design §4.1).

## Layout

| Path                 | What                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `plugins/<id>`       | One package per plugin: `manifest.json`, `src/`, `test/`, bundled to `dist/index.js` with esbuild       |
| `synoikia/`          | Git submodule of the Synoikia repo, pinned to a commit. Supplies the plugin SDK and core's test harness |
| `tsconfig.base.json` | Shared compiler options; each plugin's `tsconfig.json` extends it                                       |
| `vitest.shared.ts`   | Shared Vitest config; each plugin's `vitest.config.ts` re-exports it                                    |

The pnpm workspace contains `plugins/*` plus the submodule's `packages/plugin-sdk` and `packages/core`, so plugins depend on them with `workspace:*`:

- `@synoikia/plugin-sdk`: the manifest schema, RPC contract and `runPlugin()` runtime that the bundle includes.
- `@synoikia/core` (dev only): `@synoikia/core/testing`, the plugin harness. It boots the real core on the built bundle, running as a permission-confined child as in production, so each plugin's end-to-end tests run here against its own fake upstream.

Tests and typechecks resolve both to their TypeScript sources through the source export condition, so the submodule never needs a full build. Only the SDK is compiled, because esbuild bundles its `dist`.

> Until the submodule points past the Synoikia rebrand, those packages are still named `@home-server-mcps/*` and the export condition is `hsm-source`. Both condition names are configured, so only the imports change.

## Development

Requires Node ≥ 22.12 and pnpm 10 (`corepack enable`).

```sh
git clone --recurse-submodules https://github.com/via-justa/synoikia-core-plugins.git
# or, in an existing clone:
git submodule update --init

pnpm install
pnpm test        # builds the SDK, then each plugin's bundle, then runs its unit and e2e tests
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build       # SDK + every plugin bundle
```

Work on one plugin with `pnpm --filter ./plugins/<id> test`.

## Adding a plugin

Create `plugins/<id>/` with:

- `manifest.json`: validated by the SDK's schema. `id` matches the directory name; `entry` is `dist/index.js`.
- `package.json`: named `@synoikia/plugin-<id>`, `private: true`, with these scripts:

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

The submodule is pinned, so a core change never reaches this repo by surprise. To take a newer core:

```sh
git -C synoikia fetch origin main
git -C synoikia checkout origin/main
pnpm install      # picks up core or SDK dependency changes into this repo's lockfile
pnpm test
git add synoikia pnpm-lock.yaml
```

A plugin change that needs a core change lands in Synoikia first; this repo then bumps the submodule in the same PR as the plugin change.

## CI

`.github/workflows/ci.yml` runs lint, format, typecheck and the tests of every plugin. Synoikia is private, so the checkout needs a `SYNOIKIA_READ_TOKEN` repository secret: a fine-grained personal access token with **Contents: read** on both `via-justa/home-server-mcps` and `via-justa/synoikia-core-plugins`.
