# Backstage plugin: design

Backstage (https://github.com/backstage/backstage) is a developer portal: a software catalog, a scaffolder that runs templates, search, notifications and an events bus, each a backend plugin with its own REST API under `/api/<pluginId>`. This plugin exposes those APIs through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

Every backend plugin built with `@backstage/backend-openapi-utils` serves its own OpenAPI 3.1 spec at `/api/<pluginId>/openapi.json` (`packages/backend-openapi-utils/src/stub.ts`, `OPENAPI_SPEC_ROUTE`). The router serves the plugin's `src/schema/openapi.yaml` through `openapi-merge` with every path prefixed by its mount path, so paths arrive as `/api/catalog/entities`. Upstream, `catalog`, `scaffolder`, `search`, `events` and `notifications` have specs; techdocs, kubernetes, permission, auth and proxy do not and are left out.

The connection lists the plugin IDs to load (default the five; each `[a-z0-9-]+`). On every sync the plugin fetches each spec with the connection's token. A plugin whose spec answers 404 (not installed) is skipped with a warning; when none loads, the sync and the connection test fail. `network.hosts` is only the backend URL.

**Merging.** `$ref`s are resolved within each spec (component names such as `Error` repeat across plugins), untagged operations are tagged with their plugin ID for grouping, and the paths are merged into one spec. A spec with a path outside its own `/api/<pluginId>` is refused, so one plugin's spec cannot describe, or unlock, another's routes. Each loaded plugin must also keep every key `plugin.yaml` locks under its path, so an upstream rename fails the sync instead of silently dropping a lock.

**Keys** are the full served paths (`GET /api/catalog/entities/by-name/{kind}/{namespace}/{name}`): unique across plugins, stable, and what the model passes to `backstage.request`.

**Version.** Backstage has no version endpoint; the plugin reports the first loaded spec's `info.version` (the catalog's, `1`).

Tests pin the five specs from tag `v1.55.3` (`plugins/<id>-backend/src/schema/openapi.yaml`, converted to JSON with the `/api/<id>` prefix as the router serves them) in `plugins/backstage/test/fixtures/`.

## Auth

A static external-access token (`backend.auth.externalAccess`, `type: static`, with a `subject`), sent as `Authorization: Bearer <token>`. `accessRestrictions` and the permission framework limit what it may do; core's gate applies on top.

## Classification

GET reads, every other verb writes, and anything the rules don't settle stays a write. These POSTs only read and are classified as reads with a reason, so they work at the Read level:

| Operation | Why it reads |
| --- | --- |
| `POST /api/catalog/entities/by-refs`, `/entities/by-query`, `/entity-facets`, `/locations/by-query` | Queries with a body |
| `POST /api/catalog/validate-entity` | Validates an entity without registering it |
| `POST /api/catalog/analyze-location` | Previews what registering a location would add |
| `POST /api/scaffolder/v2/autocomplete/{provider}/{resource}` | Lists repositories, branches or groups from an SCM |

`POST /api/scaffolder/v2/dry-run` is a plain write, so it needs an approval at Ask. Backstage skips every action without `supportsDryRun`, but it gives the steps it runs `secrets: { ...body.secrets, backstageToken: <caller's token> }` (`scaffolder-backend/src/service/router.ts`, `/v2/dry-run`), and `NunjucksWorkflowRunner` passes them to each step. A step such as `fetch:template` can render `${{ secrets.backstageToken }}` into a file that comes back base64 in `directoryContents`. The plan classified dry-run as a read; this is stricter.

`POST /api/catalog/refresh` refreshes one entity and is a plain write. Notification read state and settings are plain writes.

Excluded: the spec routes, notifications' legacy duplicates (`GET`/`POST /api/notifications/`, `POST /api/notifications/update`, `GET /api/notifications/{id}`), and the events bus subscription plumbing (`PUT …/subscriptions/{id}` and its long-poll `GET …/events`, which would consume events meant for another subscriber).

## Template authoring

The served specs cover the authoring loop, all at Read except the last three: list actions (`GET /api/scaffolder/v2/actions`) and templating extensions → write the Template entity → `POST /api/catalog/validate-entity` → `POST /api/scaffolder/v2/dry-run` (approval) → register its location (locked) → `Scaffold` (locked). The loop is in `instructions.md`, and short `guidance` on the validate and dry-run operations. It is not a bundled guide: core serves guides only for attestation-required operations (`guides.get`), and attestation on these operations would add a required key to every call for no security gain.

## Locks

Each is locked with a typed confirmation. Literals come from the stored object. A create has nothing stored, so it confirms on the body field the approver sees in the summary:

| Operation | Why | Literal |
| --- | --- | --- |
| `DELETE /api/catalog/entities/by-uid/{uid}` | Removes the entity (it returns only if a location still emits it) | entity name (lookup) |
| `POST /api/catalog/locations` | Registers an external source the catalog ingests and keeps refreshing | the body's `target` |
| `PUT /api/catalog/locations/{id}` | Points a location at another source | stored location target (lookup) |
| `DELETE /api/catalog/locations/{id}` | Unregisters a location and orphans its entities | stored location target (lookup) |
| `POST /api/scaffolder/v2/tasks` | Runs a template for real: publishes repositories, opens PRs, registers entities | the body's `templateRef` |
| `POST /api/scaffolder/v2/tasks/{taskId}/cancel`, `/retry` | Stops a run midway, or reruns its steps | the task's template name (lookup) |
| `POST /api/notifications/notifications` | Sends to other users; `broadcast` reaches everyone | instance name (`Backstage`) |
| `POST /api/events/bus/v1/events` | Every subscriber of the topic acts on it | instance name (`Backstage`) |

A `DELETE *` rule locks any delete a newer spec adds until it is reviewed.

**Targets** (`capabilities.targets`) put what a call acts on in the approval text: an entity delete names the stored `kind:namespace/name`; a location update or delete names the stored `type:target`; a task cancel or retry names the task's template ref and status; a scaffold names the template the body's `templateRef` resolves to in the catalog, with its title, and no target when the catalog has none. A location register names the body's `type:target` right after the operation, before the body. Notification and event bodies (recipients, topic) show in the summary itself.

## Secrets

- Manifest `sensitiveKeys`: `token`, `secrets`, `authorizationToken`, `backstageToken`, `apiKey`, `api_key`, `password`, `secret`.
- `sensitiveParams`: `/body/secrets` on dry-run, scaffold and retry; `/body/authorizationToken` on refresh; `/body/token` on autocomplete.
- `sensitiveResult`: `secrets` (deep) on task reads. Backstage strips task secrets from results; this keeps them masked if a version stops doing so.
