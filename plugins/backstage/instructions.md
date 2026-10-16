# Backstage

Each backend plugin has its API under `/api/<plugin>` (catalog, scaffolder, search, events, notifications). Keys are `<VERB> <full path>`, as in `GET /api/catalog/entities/by-name/{kind}/{namespace}/{name}`. Entities are named by ref `kind:namespace/name` (`component:default/petstore`) or by `metadata.uid`.

Catalog queries: `GET /api/catalog/entities/by-query` with `filter=kind=component,spec.owner=group:default/team-a` (repeat `filter` for OR), `fields=metadata.name,spec` to trim, and `limit`; pass `pageInfo.nextCursor` back as `cursor`.

Workflows:

- A team's components: `GET /api/catalog/entities/by-query`, `filter=kind=component,spec.owner=group:default/<team>`.
- Relations: `GET /api/catalog/entities/by-name/{kind}/{namespace}/{name}` (`relations[].targetRef`) → `POST /api/catalog/entities/by-refs`.
- Author a template: `GET /api/scaffolder/v2/actions` + `GET /api/scaffolder/v2/templating-extensions` → write the Template → `POST /api/catalog/validate-entity` → `POST /api/scaffolder/v2/dry-run` (`template`, `values`, `directoryContents: []`) → `POST /api/catalog/locations` → `POST /api/scaffolder/v2/tasks`.
- A task: `GET /api/scaffolder/v2/tasks/{taskId}` (`status`), log from `GET /api/scaffolder/v2/tasks/{taskId}/events?after=<id>`.

Dry-run is a write: its steps run with a Backstage token. Locked (a person types a confirmation): entity and location deletes, location register and update, task create, cancel and retry, notification and event-bus publishes.
