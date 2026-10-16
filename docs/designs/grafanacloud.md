# Grafana Cloud plugin: design

The grafana.com Cloud API (`https://grafana.com/api`): stacks, organizations and their members, Cloud access policies and tokens, stack regions, plugins installed on stacks, and service accounts in a stack's Grafana. This plugin exposes it through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies. A stack's own Grafana HTTP API (dashboards, data sources, alerting) is the separate `grafana` plugin.

## Catalog source

grafana.com publishes the API's OpenAPI 3.0.3 spec at `https://grafana.com/api/openapi.json`; grafana.com does not version it (`info.version` is `public`). A copy is kept in `grafana/grafana-com-public-clients` (`openapi.json`, used to generate their clients).

On every sync the plugin tries, in order and without credentials:

1. `https://grafana.com/api/openapi.json`
2. `https://raw.githubusercontent.com/grafana/grafana-com-public-clients/main/openapi.json`

A source that fails to download, is not JSON, has fewer than 45 operations, or lacks any key `plugin.yaml` locks is skipped; when none is usable the sync fails and names each failure. Both URLs are `plugin.spec.urls` in `plugin.yaml`. Known limitation: the SDK's `fetchSpec` follows redirects, so a source can redirect the download to another host. No credentials are sent with it, and the locked-key and size checks still apply to what it returns. The connection's optional `specUrl` (a mirror) replaces the list. `sourceRef` is the host the spec came from, `upstreamVersion` its `info.version`.

Operation keys are the spec's paths, relative to its server `/api` (`GET /instances/{instanceId}`). The model may pass the path with or without `/api`. The API base is `plugin.apiUrl`; the connection's optional `apiUrl` replaces it. Both overrides must be `https` (plain `http` is accepted only for a loopback host, for a local mirror or test double).

Tests pin the GitHub copy at commit `3d5e6ef` (2026-09-22), reformatted by Prettier: `plugins/grafanacloud/test/fixtures/grafana-com-openapi.json`. 55 operations, 54 in the catalog.

## Auth and organization

A Cloud access policy token (`glc_…`), sent as `Authorization: Bearer`. Its policy's scopes and realms bound what any call can do.

The connection also takes the organization slug (`org`, required, `^[a-z0-9][a-z0-9-]*$`). The connection test reads `GET /orgs/{org}`, which proves the token and the slug, then loads the spec. The slug is the default confirmation literal. It is not filled into calls: paths name the org (`/orgs/{slugOrId}`) and the model finds the slug in any stack record (`orgSlug`). Access policies and tokens are regional: every `/v1/accesspolicies` and `/v1/tokens` call carries `region` in its query, and lookups for those records reuse the call's region.

## Classification

GET reads; every other verb writes. `POST /v1/stacks/checkUrl` (is a stack URL free) is a reviewed read. No GET is flagged by the action heuristic.

Excluded: `GET /orgs/{slugOrId}/check-visibility`, a grafana.com UI check of whether the org's public page is visible.

## Locks

Every write in the pinned spec is locked with a typed confirmation, and `DELETE *`, `PUT *` and `PATCH *` lock one a newer spec adds. Literals come from the stored record (a lookup by the path id) or the path, never a body field the model writes, except creates, which confirm on the body field the summary shows first. A failed lookup falls back to the id.

| Area | Operations | Literal |
| --- | --- | --- |
| Stacks | `POST /instances`, `POST /v1/stacks` (billed) | body `slug`, else `name` |
| | `POST`/`DELETE /instances/{instanceId}`, `POST`/`DELETE /v1/stacks/{idOrSlug}` (update can turn delete protection off; delete is irreversible) | stack slug (lookup) |
| Stack plugins | install, update (`POST /instances/{instanceId}/plugins[/{pluginSlugOrId}]`: third-party code runs in the stack), uninstall | stack slug (lookup) |
| Stack service accounts | create (with any role); token create and delete; delete | stack slug, or account name (lookup) |
| Org members | add, role change, remove | org slug (lookup by slug or id), or member username (lookup) |
| Org settings | `POST /orgs/{slugOrId}/settings` (MFA, token expiry, invite domains) | org slug (lookup) |
| Access policies | create, update (scopes and realms are privileges), delete | body `name`; policy name (lookup with `region`) |
| Tokens | `POST /v1/tokens` (takes its policy's privileges), update (an expiry extends them), delete | policy name (lookup of `accessPolicyId`); token name (lookup with `region`) |
| Newer operations | `DELETE *`, `PUT *`, `PATCH *` | org slug |

## Request keys

grafana.com is Go: `encoding/json` binds body keys case-insensitively (the last match wins) and folds `ſ` to `s` and the Kelvin sign to `k`. A body `{"accessPolicyId": "readers", "AccessPolicyId": "admin"}` would show `readers` to the approver and grant `admin`. So `resolveOperation` refuses with `INVALID_PARAMS` any query or body that has, at any depth, two keys equal under case-folding, or a key that is not printable ASCII. A lone key in another case (`AccessPolicyID`) is renamed to the spelling the rules read: the summary fields' names and `plugin.canonicalKeys`. Summaries, literals and targets then read what grafana.com binds.

## Approval context

Summaries put body fields that grant or move something right after `Grafana Cloud VERB /path?query`, ahead of the truncated body, so padding cannot push them out: `realms`, `scopes`, `conditions`, `accessPolicyId`, `expiresAt`, `slug`, `name`, `org`, `region`, `url`, `plan`, `deleteProtection`, `plugin`, `plugins`, `version`, `username`, `role`, MFA and invite settings, `status`. Values are JSON with control, bidi and zero-width characters escaped. Notes say a stack delete loses all its data and cannot be undone, a stack create is billed, a plugin install runs third-party code, and org settings apply to the whole org.

Targets name the stored record a non-GET call acts on: the stack (`slug (name, url, region)`), the access policy with its scopes and realms (also for `POST /v1/tokens`, from the body's `accessPolicyId`), or the token (`name (access policy, expiry)`).

## Secrets

`sensitiveKeys`: `token`, `key`, `password`, `machineLearningLogsToken`, `client_secret`, `private_key`. `sensitiveResult`: `token` on `POST /v1/tokens`; `key` on stack service account token create; `machineLearningLogsToken` and `config` (the stack's custom Grafana configuration, free-form and able to hold credentials) on every stack record. No request body carries a secret.

## Agent instructions

`instructions.md`: the API shape (stacks are `instances` by slug or id, org slugs, `region` on access policies and tokens, `POST` for updates), paging, and workflows (an org's stacks and URLs, an access policy and token for a stack, a stack's plugins, regions, stack health). A unit test keeps every key it names in the catalog and the file under 1.5 KB.
