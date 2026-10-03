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

| Path                 | What                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `plugins/<id>`       | One package per plugin: `manifest.json`, `plugin.yaml`, `src/`, `test/`, bundled to `dist/index.js` |
| `docs/`              | The original per-plugin designs                                                                     |
| `tsconfig.base.json` | Shared compiler options; each plugin's `tsconfig.json` extends it                                   |
| `vitest.shared.ts`   | Shared Vitest config; each plugin's `vitest.config.ts` re-exports it                                |

Plugins build against Synoikia's published npm packages, the same way a community plugin would:

- `@synoikia/plugin-sdk`: the manifest schema, RPC contract and `runPlugin()` runtime. The bundle includes it.
- `@synoikia/create-plugin` (dev only): `synoikia-plugin new`, `build`, `check` and the `repo` release steps.
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

```sh
pnpm new          # asks for an id, a name, an archetype (openapi-rest, static-rest, websocket-rpc, blank) and auth
```

`pnpm new` (`synoikia-plugin new`, also non-interactive with `--id --name --archetype --auth --yes`) writes `plugins/<id>/` with a manifest that already follows the secret rules, a `plugin.yaml`, `src/`, a fake upstream, and conformance and e2e contract tests that pass as generated. Then:

- describe the upstream's operations in `plugin.yaml`: locks, split twins, classification overrides, `sensitiveParams`, `sensitiveResult`, confirmation literals (reference: [Synoikia's plugin authoring guide](https://github.com/via-justa/synoikia-core/blob/main/docs/plugin-authoring.md));
- keep code in `src/` for what needs logic: discovery, a split predicate, a custom confirmation source;
- extend the fake upstream and tests.

Each plugin's `test` script runs `synoikia-plugin check` (manifest, `plugin.yaml`, versions), `synoikia-plugin build` (the self-contained bundle, `plugin.yaml` validated and inlined), then its unit and e2e tests. Under the permission model the child can read nothing outside its own package directory, so everything it needs is in `dist/index.js`. A release ships only `manifest.json`, `package.json` and `dist/`.

`test/golden.test.ts` records what each plugin tells core: every catalog descriptor, and the approval summary and confirmation literal of every locked operation. A change there changes classification, locks, redaction or approvals; review the diff and update it on purpose (`vitest run test/golden.test.ts -u`).

## Updating Synoikia

The SDK and harness versions are pinned by each plugin's `package.json` range and the lockfile. To take a newer release, bump the ranges and run `pnpm install`. A plugin change that needs a core change waits for the Synoikia release that carries it.

## Releasing

To release a plugin, bump `version` in both its `manifest.json` and `package.json` (they must match) and merge to `main`. The Release workflow (`.github/workflows/release.yml`) then:

1. runs every plugin's tests;
2. packs each plugin whose version isn't in the published index yet, as a deterministic flat tarball (`synoikia-plugin repo pack`);
3. signs each tarball with the `MINISIGN_SECRET_KEY` secret and checks it against `minisign.pub`;
4. merges the new versions into the index (`repo index`);
5. installs each new version with Synoikia's own repository service (`verifyPluginRepository` from `@synoikia/core/testing`), with `minisign.pub` pinned, then starts it as a permission-confined child, as Synoikia runs it, and requires it to answer (`repo verify`);
6. only then creates the `<id>-v<version>` releases and replaces `index.json` on the `index` release (`repo publish`). An existing tag is reused only if its tarball is byte-identical.

A version that is already released is skipped, so re-running the workflow is safe. To ship a fix, bump the version again. A plugin can require a minimum Synoikia version with `"synoikia": { "minCoreVersion": "0.3.0" }` in its `package.json`; otherwise its manifest's `sdk` range decides which Synoikia versions can install it.

**The signing key.** `MINISIGN_SECRET_KEY` holds the password-less minisign secret key file (both lines). Changing the key makes every Synoikia install mark this repository `key_changed` and block installs until its admin confirms the new key. So a new key is for a compromised key only: publish the new `minisign.pub` here, and bump Synoikia's pinned key in `packages/core/src/plugins/default-repo.ts`.

## CI

`.github/workflows/ci.yml` runs lint, format check, typecheck and every plugin's tests. It needs no secrets.
