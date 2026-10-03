---
name: add-plugin
description: Scaffold a new Synoikia plugin under plugins/<id> with its manifest, package, configs, handlers, fake upstream and tests, laid out like the existing plugins. Use when asked to add, create or start a plugin for a new upstream service.
---

# Add a plugin

The new plugin follows the README's "Adding a plugin" section and the layout of the existing plugins. `plugins/seerr` is the smallest complete example (an HTTP API with an OpenAPI catalog). `plugins/truenas` and `plugins/homeassistant` cover WebSocket upstreams, a registry and targets.

## 1. Settle the basics first

- **`<id>`**: lowercase, the directory name, the manifest `id`, and usually the sandbox `binding.namespace`.
- **The catalog source**: introspection endpoint, OpenAPI spec, or a hand-written list. The catalog covers the whole API; core's access levels decide what is reachable, not the plugin.
- **Auth and secrets**: which connection fields are credentials, and which upstream responses carry secrets that must be redacted.
- **Destructive operations**: which ones are `locked` and which need `typedConfirmation`.

If a design exists, put it in `docs/designs/<id>.md` and add it to the table in `docs/README.md`.

## 2. Files

Copy these from `plugins/seerr`, renaming as you go:

| File                  | Notes                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`        | `name: @synoikia/plugin-<id>`, `private: true`, `version: 0.1.0`, `main: dist/index.js`. The same `build`, `typecheck` and `test` scripts; keep the `createRequire` banner. Same SDK and core ranges as the other plugins |
| `manifest.json`       | `id`, `name`, `version` (equal to package.json), `sdk` range, `entry: dist/index.js`, `binding`, `connection.schema` + `ui` + `help`, `sensitiveKeys`, `network.hosts`                                                    |
| `tsconfig.json`       | Unchanged copy (extends `../../tsconfig.base.json`, includes `src` and `test`, `noEmit`)                                                                                                                                  |
| `tsconfig.build.json` | Unchanged copy                                                                                                                                                                                                            |
| `vitest.config.ts`    | `export { default } from '../../vitest.shared.ts';`                                                                                                                                                                       |
| `src/index.ts`        | `runPlugin(create<Name>Plugin());`                                                                                                                                                                                        |
| `src/plugin.ts`       | `create<Name>Plugin(): PluginHandlers`. Required: `init`, `testConnection`, `getUpstreamVersion`, `syncCatalog`, `resolveOperation`, `summarize`, `invoke`                                                                |
| `src/client.ts`       | The upstream client. Throw `PluginError` with SDK `ErrorCodes`, and never put credentials in error messages                                                                                                               |
| `src/catalog.ts`      | Builds the catalog: operation keys, groups, read/write classification, `LOCKED` set                                                                                                                                       |
| `README.md`           | What it exposes, connection fields, locked operations                                                                                                                                                                     |
| `RUNBOOK.md`          | Live checklist against a real instance, like `plugins/seerr/RUNBOOK.md`                                                                                                                                                   |

Manifest rules (checked by `manifest.test.ts`): every credential field has `writeOnly: true` and the `secret` widget and is in `sensitiveKeys`, and `network.hosts` names every host the plugin calls, normally starting with `{{connection.baseUrl}}`. Bundle every runtime dependency; the child can't read `node_modules`.

## 3. Tests

- `test/manifest.test.ts`: validates with `parseManifest`, checks `isSdkCompatible`, and checks the credential rules above. Adapt Seerr's version.
- `test/catalog.test.ts`, `test/client.test.ts`, `test/plugin.test.ts`: unit tests per module.
- `test/fake-<id>.ts`: a small `node:http` (or `ws`) server that speaks just enough of the upstream protocol, records calls, and serves responses that contain secrets so redaction gets tested.
- `test/e2e.test.ts`: `startPluginHarness({ pluginDir, connection })` against the fake upstream, then check the catalog sync, a read at Read level, secret redaction, a write staying hidden until its group is raised, and a locked operation going through approval. Follow `plugins/seerr/test/e2e.test.ts`.

## 4. Wire up and verify

```sh
pnpm install                       # links the new workspace package and updates the lockfile
pnpm --filter ./plugins/<id> test  # build + unit + e2e
pnpm typecheck && pnpm lint && pnpm format:check
```

Add the plugin to the root `README.md` and to `docs/README.md` if it has a design. Leave the version at `0.1.0`: merging to `main` releases it, so say in the PR that it will publish.
