---
name: release-plugin
description: Prepare a plugin release by bumping its version in manifest.json and package.json together, and optionally its minimum Synoikia version. Use when asked to release, publish, ship or bump the version of a plugin.
---

# Release a plugin

A release is a version bump merged to `main`. The Release workflow (`.github/workflows/release.yml`) then packs, signs, verifies and publishes every plugin whose manifest version isn't in the published index yet. Nothing is published from a branch, and nothing here needs the signing key.

## Steps

1. **Pick the version** with semver against the last release (`git log --oneline -- plugins/<id>` shows what changed):
   - patch: fixes, catalog corrections, wording;
   - minor: new operations, connection fields or capabilities, compatible with existing instances;
   - major: a change that breaks existing instances, such as a renamed operation key, a removed connection field or a changed binding.

   Released versions are immutable, so never reuse one. If the published index already has the version, `build-repo.mjs` skips the plugin and nothing is released.

2. **Bump both files to the same version.** `build-repo.mjs` fails the release if they differ.
   - `plugins/<id>/manifest.json` → `version`
   - `plugins/<id>/package.json` → `version`

3. **Minimum Synoikia version.** Only when the change needs a core feature that older Synoikia releases lack, add it to `package.json`:

   ```json
   "synoikia": { "minCoreVersion": "0.3.0" }
   ```

   Otherwise the manifest's `sdk` range decides which Synoikia versions can install it. If the plugin now needs a newer SDK, bump the `sdk` range in `manifest.json` and the `@synoikia/plugin-sdk` and `@synoikia/core` ranges in `package.json` together, then run `pnpm install`.

4. **Verify** that what will be packed builds and passes:

   ```sh
   pnpm --filter ./plugins/<id> test
   pnpm typecheck && pnpm lint && pnpm format:check
   ```

5. In the PR description, name the plugin, the version, the user-visible changes and any `minCoreVersion`. Merging it publishes the release.

Never touch `minisign.pub`, the `MINISIGN_SECRET_KEY` steps in the workflow, or the `index` release.
