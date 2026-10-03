---
name: add-plugin
description: Scaffold a new Synoikia plugin under plugins/<id> with `pnpm new`, then fill in its plugin.yaml rules, discovery and tests, laid out like the existing plugins. Use when asked to add, create or start a plugin for a new upstream service.
---

# Add a plugin

Background: Synoikia's plugin authoring guide (`https://github.com/via-justa/synoikia-core/blob/main/docs/plugin-authoring.md`). `plugins/seerr` is the OpenAPI example, `plugins/truenas` an introspection catalog over JSON-RPC, and `plugins/homeassistant` a WebSocket upstream with a registry, targets and declared commands.

## 1. Settle the basics

- **`<id>`**: lowercase, the directory name and manifest `id`; the sandbox namespace defaults to it in camelCase.
- **Archetype**: `openapi-rest` (the upstream serves an OpenAPI spec), `static-rest` (REST without a spec; operations declared in `plugin.yaml`), `websocket-rpc` (JSON-RPC over WebSocket), or `blank` (introspection endpoints, anything else).
- **Auth**: `bearer`, `api-key` (with its header), `basic` or `none`.
- **Destructive operations**: which ones are `locked`, and the literal an approver types for each.
- **Secrets**: which connection fields are credentials, and which fields the upstream returns hold secrets.

If a design exists, put it in `docs/designs/<id>.md` and add it to the table in `docs/README.md`.

## 2. Scaffold

```sh
pnpm new --id <id> --name "<Name>" --archetype <archetype> --auth <auth> --yes
```

This writes `plugins/<id>/` (`manifest.json`, `plugin.yaml`, `src/`, a fake upstream, conformance and e2e contract tests, README and RUNBOOK) and runs `pnpm install`. The generated plugin passes its tests as is.

## 3. Describe the upstream

- `manifest.json`: connection fields and help, `sensitiveKeys` (add every secret field the upstream returns), `network.hosts` (every host the plugin calls).
- `plugin.yaml`: `rules` for locks, splits, classification overrides, `sensitiveParams`, `sensitiveResult`, `confirm` literals, summary notes and guidance; `exclude`/`include` for plumbing the model has no business calling; `operations` for declared operations; `plugin:` for upstream-specific lists. A rule's `classification` never unlocks, and anything unclassified is a write.
- `src/plugin.ts`: only what needs logic, such as a `splitWhen` predicate, a custom confirm source, or discovery.

## 4. Tests

- Extend the fake upstream (`startFakeHttp` from `@synoikia/core/testing` for HTTP) to answer what the plugin calls, including responses that hold secrets.
- Keep `checkPluginContract` in `test/e2e.test.ts` passing, and add e2e cases for each lock and each secret.
- Add a `test/golden.test.ts` like the other plugins once the catalog settles, so later changes to what the plugin tells core show up as a reviewed diff.

```sh
pnpm --filter ./plugins/<id> test
pnpm typecheck && pnpm lint && pnpm format:check
```

Add the plugin to the root `README.md`. Leave the version at `0.1.0`: merging to `main` releases it, so say in the PR that it will publish. Run the `security-reviewer` subagent on the diff before opening the PR.
