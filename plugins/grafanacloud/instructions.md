# Grafana Cloud

The grafana.com API, `https://grafana.com/api`. Operation keys are `<VERB> <path>` under `/api`, as in `GET /instances/{instanceId}`. Stacks are `instances`, addressed by slug or numeric id. Orgs are addressed by slug. Updates are `POST`, not `PUT`. Access policies and tokens are regional: send `query: { region }` (a stack's `regionSlug`) on every `/v1/accesspolicies` and `/v1/tokens` call.

Paging: `GET /instances` takes `page` and `pageSize`; `GET /v1/accesspolicies` and `GET /v1/tokens` take `pageSize` and `pageCursor` (from `metadata.pagination.nextPage`).

Workflows:

- Stacks in an org and their URLs: `GET /orgs/{orgSlug}/instances` → `slug`, `url`, `regionSlug`, `status`.
- Read access to a stack: `GET /v1/accesspolicies/config` (valid scopes) → `POST /v1/accesspolicies` with `{ name, scopes: ["metrics:read", "logs:read"], realms: [{ type: "stack", identifier: "<stack id>" }] }` → `POST /v1/tokens` with `{ name, accessPolicyId }`.
- Plugins on a stack: `GET /instances/{instanceId}/plugins`; details with `GET /plugins/{slug}`.
- Regions: `GET /stack-regions`, or the nearest with `GET /stack-regions/closest`.
- Stack health: `GET /instances/{instanceId}/readiness`; endpoints for metrics, logs and OTLP with `GET /instances/{instanceId}/connections`.

Locked (a person types a confirmation): stack create, update and delete, plugin installs and updates, stack service accounts and their tokens, org members and settings, access policy and token changes, and every delete.
