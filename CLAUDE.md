# synoikia-core-plugins

The TrueNAS, Seerr and Home Assistant plugins for [Synoikia](https://github.com/via-justa/synoikia-core), published as a signed plugin repository that every Synoikia install has pre-configured. Repository format, adding a plugin and releasing are covered in `README.md`.

**A plugin only describes its upstream API; core decides what is allowed.** Core's sandbox, permission gate, approvals, redaction and audit apply to every plugin. A plugin supplies the catalog, the classification (read, write, locked), targets, summaries and `sensitiveKeys`. It never adds its own allow/deny switch, approval prompt or secret handling. If a plugin needs something core doesn't offer, that is a change in `via-justa/synoikia-core`, released first.

## Layout

| Path                         | What                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `plugins/<id>/manifest.json` | Validated by the SDK schema: binding, connection form, `sensitiveKeys`, network hosts |
| `plugins/<id>/src/`          | `index.ts` calls `runPlugin()`; `plugin.ts` holds the `PluginHandlers`                |
| `plugins/<id>/test/`         | Unit tests, a `fake-<upstream>.ts` server, and `e2e.test.ts` on core's harness        |
| `plugins/<id>/RUNBOOK.md`    | Manual checklist against a real instance                                              |
| `docs/designs/<id>.md`       | The original per-server design. Where it disagrees with core's design, core wins      |
| `scripts/build-repo.mjs`     | Packs, signs, indexes, verifies and publishes releases (CI only)                      |

## Commands

Node 22.12+ (`.nvmrc` pins 22), pnpm 10.

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test   # what CI runs
pnpm --filter ./plugins/<id> test                                # one plugin: builds its bundle, then unit + e2e
pnpm --filter ./plugins/<id> exec vitest run test/catalog.test.ts   # one file (run `build` first for e2e)
pnpm format                                                      # fix formatting
```

The e2e tests run the **built** `dist/index.js` on the real core (`startPluginHarness` from `@synoikia/core/testing`) as a permission-confined child against the fake upstream. A stale bundle means stale e2e results, so rebuild after changing `src/`.

## Rules that break releases or installs

- **Self-contained bundle.** Under the Node permission model the plugin can read nothing outside its own package directory, so every runtime dependency must be bundled into `dist/index.js` by esbuild. Keep the `createRequire` banner in the build script; bundled CommonJS such as `ws` needs it.
- **Network hosts.** The plugin can reach only the hosts in `manifest.json` `network.hosts`. A new upstream URL, such as a spec mirror, goes there too.
- **Secrets.** Every credential field is `writeOnly: true` in the connection schema, uses the `secret` widget, and is listed in `sensitiveKeys` along with any secret field the upstream returns. Each plugin's `manifest.test.ts` checks this.
- **Versions.** `version` in `manifest.json` and `package.json` must match. A version that is released can never change, so any change to a released plugin needs a new version. Bump only when asked; the `release-plugin` skill covers it.
- **SDK and core ranges.** Plugins depend on published `@synoikia/plugin-sdk` and `@synoikia/core` from npm, not on a local checkout. Updating means bumping the ranges and running `pnpm install`.

## Conventions

Strict TypeScript with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`: use `import type`, and `.js` extensions on relative imports. Unused variables are allowed only with a `_` prefix. Prettier formats everything, and a hook runs it after each edit. New behavior gets a unit test and, when it crosses the plugin boundary, an e2e case with the fake upstream extended to match.

## Protected files

A PreToolUse hook (`.claude/hooks/guard-paths.mjs`) denies edits to `pnpm-lock.yaml` and `plugins/*/dist/`, and asks first for `minisign.pub`. Never touch the `MINISIGN_SECRET_KEY` flow in `.github/workflows/release.yml` unless asked.
