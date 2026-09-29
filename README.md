# synoikia-core-plugins

The plugins for [Synoikia](https://github.com/via-justa/synoikia-core), the self-hosted MCP control plane, published as a **signed plugin repository**. Synoikia comes with this repository pre-configured and its key pinned, so its plugins can be installed from the Plugins page.

## Plugin repository

|                       |                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Index                 | `https://github.com/via-justa/synoikia-core-plugins/releases/download/index/index.json`                                        |
| Public key (minisign) | `RWSDbQe7ylyyieEU0Yh/bxR53m+N/0VrVMru5WCzv1/Yvt5td92t/21e` (key id `89B25CCABB076D83`, also in [`minisign.pub`](minisign.pub)) |

If you removed it, add it back on Synoikia's Plugins → Repositories page as a **signed** repository with that URL, and confirm the public key above. Every install is checked against it: the tarball's sha256 and its minisign signature.

Each plugin version is a GitHub release, `<id>-v<version>`, holding `<id>-<version>.tgz` (`manifest.json`, `package.json` and the `dist/` bundle) and its `.minisig`. `index.json` on the `index` release lists every released version. Released versions are never changed or removed.

## Layout

| Path                     | What                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `plugins/<id>`           | One package per plugin: `manifest.json`, `src/`, `test/`, bundled to `dist/index.js` with esbuild |
| `scripts/build-repo.mjs` | Packs, indexes, verifies and publishes plugin releases (see [Releasing](#releasing))              |
| `docs/`                  | The original per-plugin designs                                                                   |
| `tsconfig.base.json`     | Shared compiler options; each plugin's `tsconfig.json` extends it                                 |
| `vitest.shared.ts`       | Shared Vitest config; each plugin's `vitest.config.ts` re-exports it                              |

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

## Releasing

To release a plugin, bump `version` in both its `manifest.json` and `package.json` (they must match) and merge to `main`. The Release workflow (`.github/workflows/release.yml`) then:

1. runs every plugin's tests;
2. packs each plugin whose version isn't in the published index yet, as a deterministic flat tarball;
3. signs each tarball with the `MINISIGN_SECRET_KEY` secret and checks it against `minisign.pub`;
4. merges the new versions into the index;
5. installs each new version with Synoikia's own repository service (`verifyPluginRepository` from `@synoikia/core/testing`), with `minisign.pub` pinned, then starts it as a permission-confined child, as Synoikia runs it, and requires it to answer;
6. only then creates the `<id>-v<version>` releases and replaces `index.json` on the `index` release.

A version that is already released is skipped, so re-running the workflow is safe. To ship a fix, bump the version again. A plugin can require a minimum Synoikia version with `"synoikia": { "minCoreVersion": "0.3.0" }` in its `package.json`; otherwise its manifest's `sdk` range decides which Synoikia versions can install it.

**The signing key.** `MINISIGN_SECRET_KEY` holds the password-less minisign secret key file (both lines). Changing the key makes every Synoikia install mark this repository `key_changed` and block installs until its admin confirms the new key. So a new key is for a compromised key only: publish the new `minisign.pub` here, and bump Synoikia's pinned key in `packages/core/src/plugins/default-repo.ts`.

## CI

`.github/workflows/ci.yml` runs lint, format check, typecheck and every plugin's tests. It needs no secrets.
