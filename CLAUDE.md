# synoikia-core-plugins

The TrueNAS, Seerr and Home Assistant plugins for [Synoikia](https://github.com/via-justa/synoikia-core), published as a signed plugin repository that every Synoikia install has pre-configured. Repository format, adding a plugin and releasing are covered in `README.md`.

**A plugin only describes its upstream API; core decides what is allowed.** Core's sandbox, permission gate, approvals, redaction and audit apply to every plugin. A plugin supplies the catalog, the classification (read, write, locked), targets, summaries, confirmation literals and `sensitiveKeys`. It never adds its own allow/deny switch, approval prompt or secret handling. If a plugin needs something core doesn't offer, that is a change in `via-justa/synoikia-core`, released first.

## Layout

| Path                            | What                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/<id>/manifest.json`    | Validated by the SDK schema: binding, connection form, `sensitiveKeys`, network hosts                                                         |
| `plugins/<id>/plugin.yaml`      | Policy as data: locks, split twins, classification overrides, `sensitiveParams`/`sensitiveResult`, confirm literals, plugin-specific settings |
| `plugins/<id>/src/`             | `index.ts` calls `runPlugin()`; `plugin.ts` uses `definePlugin` for discovery and the decisions that need logic                               |
| `plugins/<id>/guides/`          | Markdown guides bundled at build time (Home Assistant); their hash versions attestation keys, so Prettier skips them                          |
| `plugins/<id>/test/`            | Unit tests, a fake upstream, `golden.test.ts` and `e2e.test.ts` on core's harness                                                             |
| `plugins/<id>/RUNBOOK.md`       | Manual checklist against a real instance                                                                                                      |
| `docs/designs/<id>.md`          | The original per-server design. Where it disagrees with core's design, core wins                                                              |
| `.github/workflows/release.yml` | Packs, signs, indexes, verifies and publishes releases with `synoikia-plugin repo` (CI only)                                                  |

## Commands

Node 22.12+ (`.nvmrc` pins 22), pnpm 10.

```sh
pnpm new                                                         # add a plugin (see the add-plugin skill)
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test   # what CI runs
pnpm --filter ./plugins/<id> test                                # one plugin: check, build its bundle, then unit + e2e
pnpm check                                                       # manifests, plugin.yaml and versions
pnpm --filter ./plugins/<id> exec vitest run test/catalog.test.ts   # one file (run `build` first for e2e)
pnpm format                                                      # fix formatting
```

The e2e tests run the **built** `dist/index.js` on the real core (`startPluginHarness` from `@synoikia/core/testing`) as a permission-confined child against the fake upstream. A stale bundle means stale e2e results, so rebuild after changing `src/` or `plugin.yaml` (`synoikia-plugin build` validates and inlines it).

**Policy data goes in `plugin.yaml`, logic in `src/`.** Locks, splits, sensitive params and results, confirmation literals, guidance and upstream-specific lists are YAML that the SDK's `compileRules` applies; only decisions that need code (a TrueNAS path check, a Home Assistant target lookup) stay in TypeScript. Each plugin's `test/__golden__/` records what it tells core (descriptors, summaries, confirm literals, masking): a change there is a security change, so review the diff and update it only on purpose (`vitest run test/golden.test.ts -u`).

## Rules that break releases or installs

- **Self-contained bundle.** Under the Node permission model the plugin can read nothing outside its own package directory, so every runtime dependency and data file must be bundled into `dist/index.js`. `synoikia-plugin build` (from `@synoikia/create-plugin`) does it, with the `createRequire` banner bundled CommonJS such as `ws` needs.
- **Network hosts.** `manifest.json` `network.hosts` lists every host the plugin connects to; a new upstream URL, such as a spec mirror, goes there too. Admins review it before enabling the plugin, and an update that changes it installs disabled. Core doesn't enforce it (the plugin process can reach any host), so it must be accurate.
- **Secrets.** Every credential field is `writeOnly: true` in the connection schema, uses the `secret` widget, and is listed in `sensitiveKeys` along with any secret field the upstream returns. `synoikia-plugin check`, run by each plugin's `test` script, checks this.
- **Versions.** `version` in `manifest.json` and `package.json` must match. A version that is released can never change, so any change to a released plugin needs a new version. Bump only when asked; the `release-plugin` skill covers it.
- **SDK and core ranges.** Plugins depend on published `@synoikia/plugin-sdk`, `@synoikia/core` and `@synoikia/create-plugin` from npm, not on a local checkout. Updating means bumping the ranges and running `pnpm install`.

## Conventions

Strict TypeScript with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`: use `import type`, and `.js` extensions on relative imports. Unused variables are allowed only with a `_` prefix. Prettier formats everything, and a hook runs it after each edit. New behavior gets a unit test and, when it crosses the plugin boundary, an e2e case with the fake upstream extended to match.

## Security review

Before opening a PR that touches a plugin's `manifest.json`, `plugin.yaml`, `src/` or dependencies, `test/__golden__/`, or `.github/workflows/`, run the `security-reviewer` subagent (`.claude/agents/security-reviewer.md`) on the diff and address its findings. It checks classification, request building, approval summaries, secrets, network hosts and the release flow, and runs `pnpm audit` to triage known CVEs by whether the dependency is bundled into a plugin.

## Protected files

A PreToolUse hook (`.claude/hooks/guard-paths.mjs`) denies edits to `pnpm-lock.yaml` and `plugins/*/dist/`, and asks first for `minisign.pub`. Never touch the `MINISIGN_SECRET_KEY` flow in `.github/workflows/release.yml` unless asked.
