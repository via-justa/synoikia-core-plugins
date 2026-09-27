# Home Assistant MCP Server — Design Document

## 1. Purpose & Scope

Replace ad hoc, one-tool-per-endpoint coverage of Home Assistant (today: a 65-tool curated server, `mcp__Managed_MCPs__ha_ha_*`) with a **search/execute (Code Mode) server** that exposes the full surface of a Home Assistant instance — every service call across every domain (~1,000+ services), plus the config-entry-flow surfaces that don't map onto services (automations, scripts, scenes, dashboards, helpers, labels, categories, groups, areas/floors, devices/entities) — through a fixed, small tool surface, while adding a **permission gate**: reads execute automatically; every service call, config write, or state-changing action requires explicit human approval before it reaches Home Assistant.

Goals, in priority order:
1. **Security first** — physical-safety- and property-relevant actions (unlocking doors, disarming alarms, restarting/stopping HA itself, restoring a backup, deleting automations/config) never execute without a human approving that specific call, with its specific parameters and target entities.
2. **Self-hosted** — a single local process/container with network access to the HA instance over its WebSocket API. No external SaaS dependency.
3. **Lightweight** — fixed ~1–3K token tool-definition footprint regardless of the number of services/entities on the instance (vs. ~45–60K+ today for the curated 65-tool server, which grows further with every domain/integration added).
4. **Low-maintenance, automated currency** — stays in sync with whatever domains/services/entities are actually installed on the connected instance, using HA's own live introspection rather than a manually maintained tool list.

Non-goals: this is not a general-purpose Home Assistant admin UI. Three ergonomics properties of the existing 65-tool server are addressed explicitly rather than silently dropped: **surgical partial-edits with optimistic locking are carried forward** (decided — see 2.8), because full-object replacement on every automation/script/scene edit would be both token-wasteful and unsafe against concurrent editors; **the `BestPracticeKey` attestation mechanic is carried forward** (decided — see 3.6), as an independent precondition gate that sits alongside, not instead of, the human approval flow (3.3). There is deliberately **no raw `ws_command` escape hatch** (decided — see 2.2): every reachable non-service command must be a catalogued, classified, enablement-gated row, same as everything else in this design, rather than a single high-privilege passthrough.

---

## 2. Architecture

### 2.1 Pattern: Search + Execute (Code Mode)

Two MCP tools only:

- **`search(code)`** — runs sandboxed, read-only code against the current operation catalog (2.2) and its classification metadata (2.3). Returns only the matched services/commands/schemas/examples needed for the task, plus (for entity-scoped operations) a way to resolve entity/area/domain selectors without dumping the full state tree into context. The full catalog and the full entity registry never enter the model's context window.
- **`execute(code)`** — runs sandboxed code that calls a bound `ha.call(operation, params)` function (wrapping the authenticated WebSocket client). Can compose multiple calls, filter, and return a minimal focused result. Every call this code makes passes through the permission gate (Section 3) before it reaches Home Assistant.

### 2.2 Operation catalog source: live introspection, not a static file

Like TrueNAS and unlike Seerr, Home Assistant exposes rich live introspection over its own WebSocket API — no external spec to fetch or pin. Two distinct kinds of operation feed the catalog, and both come from the live instance:

- **Services** — `get_services` returns the full current `domain.service` set (e.g. `light.turn_on`, `lock.unlock`, `backup.create`), each with its field schema (targets, optional/required params) straight from the instance. This is the primary source of truth for the great majority of write operations, and it already covers essentially every domain a user could add via an integration — a new integration's services show up automatically on the next sync, no code change here.
- **Config-entry-flow commands** — a smaller, fixed set of WebSocket commands that manage objects with no corresponding service: `config/automation/config` (create/update/delete), `config/script/config`, `config/scene/config`, `lovelace/config` (dashboards), `config/entity_registry/*` (helpers, labels, categories), `config/area_registry/*` / `config/floor_registry/*`, `config/device_registry/*`. These are not discoverable via `get_services` (they aren't services), so they're seeded into the catalog from a small hardcoded list of known WS command names at import time — mirroring how TrueNAS's `locked` tier is seeded, but here the whole command exists outside the introspected set, not just its classification.
- Read-side introspection (`get_states`, `get_config`, `history/history_during_period`, `logbook/get_events`, etc.) is likewise a fixed, small set of known WS commands, seeded the same way as the config-entry-flow commands, since HA doesn't expose "the list of readable WS commands" as its own introspection endpoint.

On startup, and on a refresh interval (Section 5), call `get_services` against the connected instance and diff it into the `operations` table (2.6): each row carries the operation name (`domain.service` for a service, or the fixed WS-command name for the rest), a timestamp, and the HA `core_config`/version string it was captured against. An operation missing from the latest sync (e.g. an integration was removed) is marked `stale` rather than deleted, so classification/pre-approval history against it isn't lost if it's re-added later. If the live instance is unreachable at startup, serve from the last-synced DB rows and log a warning; refuse to start with **no** prior sync recorded and **no** live connection.

Result: installing a new HACS integration or a new first-party integration requires zero code changes here — the next refresh picks up its new services automatically, and any genuinely new service lands in the Admin Portal flagged for classification review (2.6) rather than requiring anyone to hand-edit a tool list.

**Decided: no raw `ws_command` escape hatch.** The current 65-tool server exposes a `ws_command` tool that accepts any WebSocket command name and payload as a fallback for whatever its curated tools don't cover. This design deliberately does not replicate that. Every non-service command reachable through `execute` — every config-entry-flow command in the list above, every read-side command — must be an individually catalogued, classified, and enablement-gated `operations` row, exactly like a service call. A future HA release adding a genuinely new, not-yet-catalogued WS command requires a code change here to add it (extending the fixed seed list in 2.3), rather than being reachable immediately through a passthrough. This keeps the "nothing is reachable unless it's in the catalog" invariant total — a single `ws_command` row would otherwise be one giant, hard-to-scope exception to classification and enablement, since its own params (not the operation identity) determine what it actually does.

### 2.3 Operation classification (drives the permission gate)

Classification here is **more binary than either TrueNAS or Seerr**, because HA services are already split cleanly at the domain/command level:

1. **Explicit override, locked or admin-set** — a `classification_source` of `locked` marks operations that are physical-safety- or system-integrity-critical regardless of the naming pattern below, seeded by the sync job's hardcoded list at import time and **not editable via the Admin UI/API at all** (2.6, 2.7): `lock.unlock`, `lock.open`, `alarm_control_panel.disarm`, `cover.open_cover` on garage-door-classed covers (flagged by device class, not name — see the seed-list note in 3.4), `homeassistant.restart`, `homeassistant.stop`, `backup.restore`, `backup.remove`, `config/*` delete commands (`config/automation/config` with method `delete`, etc.), `supervisor.*` (if Supervisor is present) restart/reboot/shutdown/os_update. A `classification_source` of `override` marks an admin's manual reclassification of an otherwise-inferred operation, made through the portal.
2. **Command-shape default**, the default the importer assigns to anything not `locked`:
   - Every WS command in the fixed read-side set (`get_states`, `get_config`, `history/*`, `logbook/*`, `config/*_registry/list`, `config/*/config` **get** variants, `get_services` itself) → `read`.
   - Every `call_service` operation (i.e. every `domain.service` from `get_services`) → `write`, with no exceptions inferred from naming — HA's own service metadata doesn't reliably distinguish "turns a light on" from "unlocks a door" the way TrueNAS's verb conventions do, so no service is auto-classified `read` no matter how harmless it looks. This is a deliberate, stricter default than TrueNAS/Seerr's naming heuristics: **every `call_service` operation is `write` unless explicitly reclassified**, never inferred `read`.
   - Every `config/*/config` **set/create/update** command, `lovelace/config/save`, and registry `create`/`update`/`remove` commands → `write`.
3. **Default-deny on ambiguity** — a WS command the sync job doesn't recognize at all (neither a known service nor a known fixed command) is surfaced in the Admin Portal as needing explicit classification, not silently defaulted to `read`. This matters more here than for TrueNAS/Seerr because the fixed-command list (unlike `get_services`) is hand-maintained and could miss a real command that a future HA release adds.
4. The resolved classification (source: `locked`/`override`/`command-shape-default`) is stored per operation and surfaced in `search` results and the Admin Portal's Operations table, exactly as in the other two designs.

**Enablement is a separate gate from classification**, identical in mechanism to TrueNAS/Seerr (2.3 in both). Every operation row carries an `enabled` boolean, seeded automatically at import time:

- `read` operations → `enabled: true` by default.
- `write` and `locked` operations → `enabled: false` by default — including, notably, every single `call_service` operation at first sync. This means at initial deployment `search`/`execute` expose the full read surface (all entity states, history, config) but **zero services are callable** until an admin turns individual ones on in the Operations page — the same "start read-only" posture as the other two servers, just with a much larger initial write set (every domain.service) sitting disabled.
- A disabled operation called anyway throws a structured `OperationDisabled` error at call-time, logged as `rejected: disabled` — same enforcement point as classification (3.1).

### 2.4 The HA-specific wrinkle: entity/area/domain-scoped targets

Unlike a TrueNAS method call or a Seerr REST call, most HA service calls are **targeted** — `light.turn_on` needs an `entity_id`/`area_id`/`device_id` target, not just a set of scalar params. This has two consequences that don't exist in the other two designs:

- **`search` needs a target-resolution path.** A model composing `execute` code needs to resolve "the kitchen lights" to entity IDs without HA's full entity registry (which can run into the thousands of entities on a large instance) ever being loaded into context. `search(code)` runs against a cached, DB-backed mirror of the entity/area/device registries (synced on the same cadence as the operation catalog, Section 5) so sandboxed code can filter/query it directly — `search` returns only the matched entity IDs and their relevant attributes, not the registry.
- **Pre-approval `match` constraints need entity/area/domain selectors, not just param matching.** A TrueNAS pre-approval rule matches on a param like a dataset name prefix; a Seerr rule matches on a request body field. An HA rule needs to answer "auto-approve `light.turn_on`, but only for entities in the `living_room` area" or "auto-approve `climate.set_temperature`, but only for `climate.thermostat_main`, never any other climate entity." This is an adapter-level extension to the `match` constraint schema (2.7), not a change to the shared gate logic itself — the gate still just evaluates "does this call's resolved params satisfy the rule's structured match," it's only the *shape* of what's matchable that's HA-specific.

#### `match` selector's picker UI (Decided: structured, dedicated pickers)

A distinct control per selector kind, all backed by the registry mirror, none allowing a free-typed ID — consistent with how every other pickable reference in this design works (operations are always list-picked, never typed):

- A **segmented "Match by" control** (Area / Entity / Domain) selects the primary selector kind for the rule — the mock shows this as the pattern's entry point, e.g. "Match by: Area" selected, with the other two kinds available as separate tabs.
- The selected kind's picker renders below it — for Area, a checkbox list of synced areas (each showing its live entity count, e.g. "Living Room · 6 entities"), backed by `GET /admin/registry` and refreshing as the registry mirror syncs (5).
- **Narrowing, not combining tabs**: rather than requiring the operator to reconcile how multiple top-level pickers combine (the open cons this resolves), a single **optional "also match by entity" search** sits below the primary picker, letting the rule narrow further (e.g. "this area, but only these specific fixtures within it") without switching kinds. Domain is a separate, always-visible optional dropdown beneath both, since it applies orthogonally to either an area or an entity selection. All set fields combine with AND, evaluated against every resolved target (3.5) — unchanged from the general rule.
- Mocked in the published canvas (Option A artboard) — the reference for how the Pre-Approval Rules form (2.7) should look when built.

### 2.5 Runtime components

```
┌───────────────────────────────────────────────┐
│ MCP Server                                     │
│                                                 │
│   search(code)          execute(code)          │  ← the only 2 MCP tools
│        │                     │                 │
│        └──────────┬──────────┘                 │
│                    ▼                            │
│           Sandbox runner                        │
│      (isolated-vm; untrusted model-authored     │
│       code, no ambient access)                  │
│                    │                            │
│        ┌───────────┴───────────┐                │
│        ▼                       ▼                │
│  Operation catalog cache   Permission gate       │
│  + entity/area/device      (classify → approve   │
│    registry mirror          or auto-run)         │
│  (+ classification)             │                │
│                                  ▼                │
│                          HA WebSocket client      │
│                        (holds long-lived token)   │
└───────────────────────────────┬─────────────────┘
                                 ▼
              Home Assistant instance (WebSocket API)
```

### 2.6 Implementation Stack (Decided)

Same stack as the TrueNAS and Seerr servers, carried over without re-litigating: **Node/TypeScript on FastMCP, with `isolated-vm` as the sandbox runtime.**

- **[FastMCP](https://github.com/punkpeye/fastmcp)** (TypeScript) as the MCP server framework — `elicit()`/`session.requestElicitation()` for the approval flow (3.3), session lifecycle tracking for the debounced session-start refresh (Section 5), Zod-validated schemas for the two `search`/`execute` tools, custom HTTP routes for `/healthz` and `POST /admin/refresh`.
- **`isolated-vm`** as the code sandbox for both `search` and `execute`, with only the `ha.call` binding (and a read-only registry-query binding for `search`) injected in — no ambient `require`/`fetch`/`process`/filesystem access.

### 2.7 Admin Portal & Configuration API (replaces config files)

Same design as the TrueNAS and Seerr servers' Section 2.6 — SQLite-backed, Vue frontend, single basic-auth credential via env vars, no config files, no RBAC. This section only calls out where the HA adaptation differs.

**Pages/views** (Vue components — functional spec, not a full component spec):

| Page | Purpose | Difference from TrueNAS/Seerr |
|---|---|---|
| **Connection** | HA base URL + long-lived access token entry, "Test connection" action, live status, "Sync now" button, last-sync timestamp | Same shape; token is a long-lived HA access token rather than an API key/cookie |
| **Operations** | Searchable/filterable table of every synced operation: name, classification, source, **Enabled toggle**, last-seen. "New" badge on first-seen operations | Filterable additionally by domain (`light.*`, `lock.*`, …), since the operation count here (~1,000+ services) is an order of magnitude larger than TrueNAS/Seerr — a flat table alone isn't browsable |
| **Pre-Approval Rules** | List + create/edit form: operation (picker), **match constraints including entity/area/domain selectors** (2.4), rate limit, expiry, reason, enabled toggle | The `match` editor needs entity/area/domain pickers backed by the registry mirror (2.4), not just scalar-field inputs — this is the one page with a materially different form shape from the other two servers. Built as a "Match by" segmented control (Area/Entity/Domain) plus an optional entity-narrowing search, per the decided design in 2.4 |
| **Pending Approvals** | Inbox of paused write calls — full params including resolved target entity names (not just raw entity IDs), matched operation, classification reason, Approve/Deny | Approval summaries should render friendly names ("Unlock Front Door" not `lock.unlock` on `lock.front_door`) — HA already has this metadata in the entity registry mirror, so the summary generator should use it rather than showing raw IDs |
| **Audit Log** | Every `search`/`execute` call: operation, target entities, classification, decision, decider, timestamp | Same shape, with target entities as a filterable column |

**Admin API** — same routes and same enforcement pattern as the other two servers (`GET/PUT /admin/connection`, `POST /admin/sync`, `GET/PATCH /admin/operations`, CRUD on `/admin/pre-approval-rules`, `/admin/pending-approvals`, `/admin/audit-log`), all with the same `locked`-row 409 protections. One addition: `GET /admin/registry` — a read-only, paginated/searchable endpoint over the entity/area/device registry mirror, backing the Pre-Approval Rules page's target pickers and the Pending Approvals page's friendly-name rendering.

**Database**: SQLite, same pattern as the other two servers. Table shapes:

```
operations(id, name, kind, classification, classification_source, enabled, locked, attestation_required, first_seen_at, last_seen_at, stale)
  -- kind: 'service' | 'ws_command' — distinguishes a domain.service row from a fixed config/read command row
  -- attestation_required: independent of classification/enabled — gates on a best_practice_key instead (3.6)
best_practice_guides(id, operation_id FK, version, content, key, published_at)
  -- key: the current best_practice_key for that operation's guidance version; search() returns it alongside the guide text
registry_entities(id, entity_id, area_id, device_id, domain, friendly_name, last_synced_at)
registry_areas(id, area_id, name, floor_id)
registry_devices(id, device_id, area_id, name, manufacturer, model)
pre_approval_rules(id, operation_id FK, match TEXT, rate_limit, window_seconds, expires_at, reason, enabled, created_by, created_at)
  -- match JSON can include entity_id / area_id / domain selectors in addition to scalar param constraints (2.4)
pre_approval_hits(id, rule_id FK, occurred_at)
pending_approvals(id, operation_id FK, params TEXT, resolved_targets TEXT, expected_config_hash, requested_at, status, decided_by, decided_at)
approval_log(id, operation_id FK, params TEXT, resolved_targets TEXT, classification, decision, decided_by, decided_at, source, config_hash_conflict BOOLEAN)
connection(id, base_url, credential_encrypted, last_synced_at, last_sync_status)
```

`match`, `params`, and `resolved_targets` are `TEXT` columns holding JSON (SQLite has no native JSON/JSONB type). `credential_encrypted` uses application-level encryption exactly as in the other two designs — the plaintext long-lived token is never queryable back out through the Admin API once saved. `expected_config_hash`/`config_hash_conflict` back the optimistic-locking behavior in 2.8.

Hard requirement, not a configurable default: **reads execute immediately; every service call and every config-write command blocks on human approval before touching Home Assistant — unless it matches an operator-defined pre-approval rule (3.5), in which case it auto-executes and is logged as such.**

### 2.8 Config-entry-flow writes: surgical edits with optimistic locking (Decided)

The current 65-tool server edits automations/scripts/scenes via `python_transform` — a targeted, model-authored transform applied to the existing object server-side — combined with `config_hash` optimistic locking, rather than requiring the model to read the whole object, reconstruct it, and submit it back in full. **This design carries that forward for the config-entry-flow `CallBinding` specifically** (automations, scripts, scenes, dashboards, and the registry objects in 2.2's config-entry-flow list) — it does not extend to service calls, which have no "existing object" to transform in the first place.

- **Read path**: `search`/a dedicated read call returns the current object *and* its `config_hash` (a content hash computed server-side at read time — not model-supplied).
- **Write path**: `execute` code submits a transform (a small, constrained description of the change — e.g. "add this trigger," "set this field," structured rather than arbitrary code, to keep the transform itself auditable in the approval prompt) plus the `config_hash` it read. The `CallBinding` adapter applies the transform to the *current* server-side object at write time.
- **Optimistic-locking check, at write time, before the approval flow**: if the object's live `config_hash` no longer matches the one the transform was computed against (someone else — another session, or a direct HA UI edit — changed it in between), the call is rejected with a structured `ConfigConflict` error *before* an approval request is even created, not silently applied over the intervening change. The model/operator has to re-read and resubmit.
- **Approval prompt shows a real diff**: because the transform is applied server-side against the known current object, the approval request (3.3) can render an actual before/after diff of the affected fields — a materially better review surface than a full-object approval, where a reviewer has to spot a one-field change buried in a large re-submitted object.
- **Classification/enablement/approval flow is otherwise unchanged** (3.1) — the transform-plus-hash mechanism only changes what `params` looks like for these operations and adds the one extra `ConfigConflict` failure mode; it does not bypass or shortcut enablement, classification, or the approval gate itself, and a `locked` config-entry-flow operation (e.g. an automation delete) is exactly as non-pre-approvable as before.

---

## 3. Permission Model: Approved Read / Required Approval for Write & Delete

### 3.1 Flow

1. Model calls `execute(code)`.
2. The sandbox's *only* path to HA is the injected `ha.call(operation, params)` binding — no raw network access. Each call is intercepted at call-time.
3. **Attestation check, first** (3.6): if the operation is `attestation_required` and `params` lacks a valid, current `best_practice_key`, the binding throws `AttestationRequired` immediately. Logged as `rejected: attestation_required`. Only operations flagged `attestation_required` (automation/script/scene create/update, at minimum) go through this step at all — everything else skips straight to step 4.
4. **Enablement check** (2.3): if the operation's `enabled` flag is `false`, the binding throws `OperationDisabled` immediately. Logged as `rejected: disabled`.
5. If enabled: **resolve targets** — for a `call_service` call, expand any `area_id`/`device_id` target in the params into the concrete `entity_id`s it covers (via the registry mirror, 2.4), so both the approval prompt and any `match` evaluation operate on concrete entities, never an unresolved area reference that could silently cover more than the approver realizes.
6. Look up classification:
   - `read` → executes immediately inline.
   - `write`/`locked` → check `pre_approval_rules` (3.5, 2.7) for a matching, unexpired, rate-limit-available rule, evaluated against the **resolved** entity targets from step 5.
     - **Matched** → executes immediately, logged `auto-approved (pre-approval: <rule id>)`.
     - **No match** → paused; an approval request is created (3.3) and the sandbox blocks on it.
7. Approved (or pre-approved) → the real call runs, execution resumes.
8. Denied or timed out → the binding throws `PermissionDenied` back into the sandboxed code; logged either way.

`search` results are filtered to `enabled` operations only by default, same as the other two designs, with an `includeDisabled` opt-in flag.

### 3.2 Why call-time interception, not static pre-analysis

Same reasoning as TrueNAS and Seerr: `execute` runs arbitrary generated code, so the `ha.call` binding is the sole egress and the sole enforcement point, checked on every invocation regardless of how the surrounding code is structured. An optional cheap static pre-scan can reject submissions that try to reach outside the sandbox as defense-in-depth, but it is not the security boundary.

### 3.3 Approval mechanism

- Each pending call generates an approval request containing: operation name, resolved target entities with friendly names (2.7), full params, classification source/reason, and a human-readable summary (e.g. "This will unlock **Front Door**" or "This will set **Living Room Thermostat** to 78°F").
- **Primary delivery: MCP elicitation**, identical mechanism to the other two servers (3.3 in both) — `elicitation/create` back over the live MCP connection.
- **Fallback delivery: notification channel (headless/unattended runs only)** — same deferred-to-later-iteration status as the other two servers (Section 10 there; not reopened here).
- Path selection, timeout (15 min default), and auto-deny-on-timeout behavior are identical to the other two designs.
- Approvals are **single-use, scoped to the exact resolved targets and params presented** — approving "unlock Front Door" never pre-authorizes unlocking any other lock, even one added to the same area later.
- Persisted to `pending_approvals`/`approval_log` (2.7), including the resolved target list so an auditor can see exactly which entities a since-changed area assignment would have covered at decision time.

### 3.4 Extra confirmation for irreversible / high-blast-radius operations

Seeded as `locked` (2.3.1), requiring typed confirmation beyond the normal approval: `lock.unlock`, `lock.open`, `alarm_control_panel.disarm`, garage-door-classed `cover.open_cover` (matched by device class `garage`/`gate`, not by entity naming — naming isn't reliable and a false negative here is a physical-security miss), `homeassistant.restart`, `homeassistant.stop`, `backup.restore`, `backup.remove`, config-entry `delete`/`remove` commands (automation/script/scene deletion), and — if the HA Supervisor is present — `supervisor.*` restart/reboot/shutdown/os_update. The approval prompt must include the resolved friendly name(s) of the affected entity and require it be echoed back before proceeding, mirroring the other two designs' typed-confirmation pattern (their 3.4).

### 3.5 Pre-Approved Actions (Operator-Configured Auto-Allow)

Same opt-in mechanism as TrueNAS/Seerr's Section 3.5 — an explicit, narrow rule set, never a default. The HA-specific addition is the `match` shape (2.4): a rule can constrain by scalar param **and/or** by entity/area/domain selector, evaluated against the *resolved* targets (3.1 step 4), so "auto-approve `light.turn_on` in the `living_room` area" cannot be satisfied by a call that also targets an entity outside that area — the rule matches only if every resolved target satisfies the constraint, not if any one does.

**Example rules** (illustrative, not seeded):

| Operation | Match | Rate limit | Reason |
|---|---|---|---|
| `light.turn_on` / `light.turn_off` | area: `living_room`, `kitchen` | 60/hour | Routine lighting control in common areas; bedrooms/exterior stay manual. |
| `climate.set_temperature` | entity: `climate.thermostat_main`; range: 65–78°F | 10/hour | Bounded thermostat adjustments on the one shared unit; other climate entities (e.g. a wine fridge) stay manual regardless of range. |

Same hard boundary as the other two designs: any `locked` operation is never referenceable by a pre-approval rule, enforced server-side with a 409, independent of what the picker offers.

### 3.6 Best-practice attestation before certain writes (Decided: replicate as a gate precondition)

The current 65-tool server forces a `search`-equivalent read of best-practice guidance — via a `BestPracticeKey` the model must obtain and pass — before certain writes (at minimum, automation creation; possibly script/scene creation too, in the current tool set). This is a **forcing function distinct from the approval flow**: 3.3's human approval reviews the *specific call*, but doesn't guarantee the model consulted guidance before *constructing* it — a bad automation trigger can still be well-formed and get approved by a human who isn't themselves an HA expert. **Decided: this mechanic is carried forward.**

- Every relevant `operations` row (automation/script/scene create/update, at minimum — seeded like the `locked` list, 2.3.1, and reviewable/extendable through the same Admin Portal Operations page as an `attestation_required` boolean, independent of both `classification` and `enabled`) requires a `best_practice_key` in its `execute` params.
- The key is obtained from a corresponding `search` call in the same session — `search`, when it returns guidance for an attestation-required operation, returns a key scoped to that guidance's current version alongside it.
- **New step, before enablement (3.1 gets a step 0)**: the `ha.call` binding checks, for any attestation-required operation, that a valid and current `best_practice_key` is present in `params` *before* the enablement check even runs. Missing, stale (guidance has since been revised), or forged → rejected immediately with a structured `AttestationRequired` error, logged as `rejected: attestation_required`, no approval request created.
- **Workflow**: model attempts `execute` on an attestation-required operation without a key → rejected, told to `search` for guidance first → model calls `search`, receives the guidance plus a `best_practice_key` → resubmits `execute` with the key → proceeds through the normal enablement → classification → approval flow (3.1) from there. The attestation gate and the human-approval gate are independent and both must pass; neither substitutes for the other.
- This is genuinely new scope beyond what the TrueNAS/Seerr gates needed (a new precondition step, a new table/flag, a new error type, a new "which operations need this" classification to maintain), accepted deliberately to preserve the current server's demonstrated quality/safety property rather than let it regress silently.

---

## 4. Security

- **Sandbox**: model-authored code runs in `isolated-vm` — never `eval`/`vm.runInContext` in the main process, never a shared long-lived interpreter reused across requests.
- **No credentials inside the sandbox**: the sandbox sees only the bound `ha.call` function and the read-only registry-query binding — never the long-lived access token. The token lives only in the outer server process.
- **HA token scope**: a long-lived access token from an owner-level HA account is the accepted operating assumption for this deployment, matching the `FULL_ADMIN`/full-admin-account assumption in the TrueNAS and Seerr designs — the server doesn't attempt to run with a narrower scope by design (HA's own long-lived tokens aren't scopeable below "this user's full access" anyway), but every `ha.call` is wrapped so a permission-denied response surfaces as a clean, structured error, never a crash.
- **Resource limits**: hard timeout (default 10s) and memory cap per `search`/`execute` call.
- **Rate limiting**: cap `execute` calls per minute, especially service calls — a runaway loop calling `light.turn_on`/`off` in a cycle is a real failure mode with a physical side effect (visible flicker, relay wear), not just an API-quota concern.
- **Audit log**: every `search`/`execute` call, including denied/timed-out approvals, logged with operation, resolved targets, params (secrets redacted), classification, decision, result status. Append-only, never exposed back to the model, readable only via the Admin Portal's Audit Log page.
- **Redaction**: fields matching a documented sensitive-field list are redacted before being returned to the model, written to logs, or rendered in the portal — HA-specific cases include camera/stream access tokens embedded in some entity attributes and any `webhook_id`s that double as bearer secrets for inbound automation triggers.
- **No runtime privilege escalation**: `operations.classification`, `operations.enabled`, `operations.attestation_required`, and `pre_approval_rules` are editable only through the Admin Portal/API — never by the running MCP server process, never by model-generated code. The sandbox has no DB access at all.
- **Attestation cannot be forged or replayed stale**: a `best_practice_key` is checked against the *current* `best_practice_guides` row for that operation at call-time (3.6) — a key from a superseded guidance version is rejected the same as a missing one, so revising guidance takes effect immediately for the next attempted write rather than only for guides fetched after the revision.
- **Pre-approval cannot widen past the hard boundary**: `locked` operations are non-referenceable by any rule, enforced at the Admin API layer.
- **Credential storage**: the long-lived token is stored application-level-encrypted in the `connection` table, decryptable only by the MCP server process — never returned in plaintext once saved; re-entry required to rotate.
- **Portal auth is a separate boundary from MCP transport auth**, same split as the other two designs.
- **Network exposure**: bind to localhost or an internal network by default; require TLS and MCP-transport auth if exposed further — don't rely on HA's own auth or the portal's auth as the only gate for the MCP endpoint itself.
- **Admin API hardening**: CSRF protection on state-changing routes, session/JWT expiry, rate limiting on login and `/admin/connection/test`.

---

## 5. Maintenance & Auto-Update

- **Catalog + registry refresh — primary trigger: session start (debounced)**, identical mechanism to the other two designs: check last-sync age on the `connection` row, refresh via `get_services` (operations) and the entity/area/device registry commands (2.7) if stale, debounced against concurrent session starts.
- **Version-triggered refresh**: the `connection` row records the HA core version last synced against (from `get_config`); at each session start, compare against the live instance's current version regardless of sync age, forcing an immediate refresh on mismatch — catches an HA core upgrade or a newly-installed integration without waiting on the debounce window.
- **Catalog refresh — backstop: low-frequency cron**, same as the other two designs (default: daily), plus manual trigger via `POST /admin/sync`.
- **Mid-session staleness**: same known limitation and same recommended mitigation (periodic re-check within long-lived sessions) as TrueNAS/Seerr — relevant here in a slightly sharper way, since the registry mirror going stale mid-session risks a `match` rule evaluating against an area assignment that's since changed (e.g. an entity moved out of `living_room` after the rule was written but before the mirror re-syncs).
- **Classification drift**: a newly discovered service is inserted with `classification_source: command-shape-default` and `first_seen_at` set to now, surfaced as a "New" badge — and because every new service defaults `write`+`enabled: false` (2.3), it's inert until an admin reviews it, so there's no window where a newly-added integration's services are silently callable.
- **Dependency hygiene**: pin dependencies; run CI against a test/staging HA instance before deploying; enable Dependabot/Renovate for the sandbox runtime and MCP SDK.
- **Health check**: `/healthz` reports last sync age, last successful HA connection, pending-approval count, sandbox runtime status, DB connectivity, registry mirror staleness.

---

## 6. Documentation

- **README.md**: setup (creating a long-lived HA access token, DB schema migration, setting the portal's basic-auth credential), how search/execute works, how to answer a pending approval, how pre-approval rules and their entity/area `match` constraints work, connection troubleshooting.
- **In-portal help text**: the Operations page explains `locked`/`override`/`command-shape-default` inline, and specifically why every `call_service` operation defaults `write` regardless of how harmless the service name looks; the Pre-Approval Rules form explains the entity/area/domain `match` selectors and their all-targets-must-match evaluation rule (3.5) inline.
- **On-demand operation docs inside `search` results**: `get_services` already returns field-level descriptions per service straight from the integration's own definition — surface this directly through `search` rather than re-authoring it, the same approach as Seerr's OpenAPI `summary`/`description` reuse.
- **Change history**: the Admin Portal's Audit Log, filterable to configuration changes (reclassifications, rule create/edit/delete), same as the other two designs — no YAML/git history to substitute for.
- **Runbook**: what to do when HA is unreachable, an approval is stuck pending, the sandbox is killing calls on timeout, a new HA release renames/removes a service an operator relies on, the registry mirror is stale mid-session, a config-entry-flow write hits a `ConfigConflict` (2.8) and needs a re-read/resubmit, or the Admin Portal's DB is unreachable (fail open on reads of the last-synced classification, fail closed on anything it can't classify with confidence — same posture as the other two designs).
- **Config-entry-flow transform format**: the constrained transform vocabulary (2.8) — what shapes of change ("set field," "add trigger," "remove condition," etc.) are supported — needs its own reference doc distinct from the operation-schema docs above, since it describes the *shape of an edit*, not the shape of an object.

---

## 7. Development Phase (TDD)

Same test-first, phase-ordered approach as the TrueNAS and Seerr designs (their Section 7) — each phase's tests are written before its implementation and must pass, plus every earlier phase's tests as regression, before moving on.

1. **Operation classification (2.3)** — pure functions, no network/DB/sandbox. Tests first: every `call_service` operation classifies `write` with no naming-based read inference, ever; fixed read-side WS commands classify `read`; a `locked` classification always wins; `override` wins over command-shape-default but never over `locked`; an unrecognized WS command is flagged for review, never silently defaulted to `read`. Implement.
2. **Enablement gate** — tests first: `read` operations default `enabled: true`; every `write`/`locked` operation, including every synced service, defaults `enabled: false`; a disabled-operation call is rejected (`OperationDisabled`) before classification is consulted. Implement.
3. **Catalog + registry sync (2.2, 2.4)** — tests against a mocked `get_services`/registry response: correct upsert into `operations`/`registry_entities`/`registry_areas`/`registry_devices`; `stale` marking for operations/entities absent from a sync; refuse-to-start with no prior sync and no live connection. Implement against a fake HA client; the real WebSocket client is wired later.
4. **Target resolution (2.4, 3.1 step 4)** — tests first: an `area_id` target expands to the correct concrete `entity_id`s from the registry mirror; a `device_id` target expands correctly; a call with a mix of direct `entity_id` and `area_id` targets resolves to the correct deduplicated set; resolution against a stale/missing area fails closed (rejected, not silently resolved to zero entities and allowed through). Implement.
5. **Sandbox binding (2.6, 4)** — tests first: sandboxed code's only egress is the injected `ha.call` binding plus the read-only registry query; `require`/`fetch`/`process`/filesystem access is contained; a thrown `PermissionDenied`/`OperationDisabled` propagates as a catchable error, not a crash. Implement the `isolated-vm` wiring.
6. **Config-entry-flow transform + optimistic locking (2.8)** — pure-function tests first, no network/sandbox: a transform applied against a known object and `config_hash` produces the expected result; a transform submitted against a stale `config_hash` is rejected with `ConfigConflict` before any approval request is created; the diff rendered for the approval prompt correctly reflects only the changed fields. Implement the transform engine and hash comparison against a fake object store; wiring to the real HA config-entry-flow commands happens later.
7. **Attestation gate (3.6)** — tests first, no network/sandbox: a call to an `attestation_required` operation with no `best_practice_key` is rejected with `AttestationRequired` before the enablement check even runs; a key matching the current guidance version passes; a key from a superseded version is rejected identically to a missing one; a non-`attestation_required` operation skips the check entirely regardless of whether a key is present. Implement against a fake `best_practice_guides` store.
9. **Approval flow (3.1, 3.3)** — tests first against a fake elicitation transport: a `read` call auto-executes; a write call with no matching rule pauses on resolved targets and creates a pending approval; a config-entry-flow write's approval prompt includes the transform diff (2.8); approve/deny branch correctly; unanswered requests auto-deny on timeout; an approval is single-use and scoped to its exact resolved targets/transform. Implement.
10. **Pre-approval rules incl. entity/area match (3.5)** — tests first: a rule with an area selector matches only when every resolved target is within that area; a rule with an entity selector matches only that exact entity; a rule at its rate limit falls back to normal approval; an expired rule is treated as no rule; a `locked` operation can never be referenced by a rule. Implement.
11. **Admin API (2.7)** — contract tests: `GET /admin/connection` never returns the plaintext token; `PATCH /admin/operations/:id` rejects a classification change on a `locked` row (409) but accepts an `enabled` toggle; `POST/PATCH /admin/pre-approval-rules` rejects a `locked` operation (409) and validates the entity/area `match` shape; `GET /admin/registry` supports search/pagination; any admin route without basic-auth returns 401. Implement.
12. **Admin Portal UI (Vue, 2.7)** — component/interaction tests for each page: the Operations page's domain filter and Enabled/classification toggles act independently; a `locked` row's classification control is disabled while Enabled isn't; the Pre-Approval Rules form's entity/area pickers are backed by `/admin/registry` and reject a `locked` operation; the Pending Approvals page renders friendly names and transform diffs, not raw entity IDs or full re-submitted objects, and its Approve/Deny buttons call the right endpoints.
13. **`search`/`execute` MCP tools (2.1)** — integration tests: `search` returns only `enabled` operations by default and resolves entity/area queries against the registry mirror without ever returning the full registry; `execute` runs the full call-time flow (attestation → enablement → target resolution → classification → approval-or-pre-approval) end-to-end against the fake elicitation transport and fake HA client, including the config-hash conflict path for config-entry-flow writes.
14. **Maintenance jobs (5)** — tests first, against a mocked clock/scheduler: session-start debounce and its lock behave correctly under concurrent starts; an HA core version mismatch forces an immediate refresh; the cron backstop fires on schedule; mid-session staleness re-checks happen on the configured interval.

Only after all of the above pass against mocks does a real/staging HA instance enter the picture, for the integration tests in Section 9 — confirmation the mocked contracts matched reality, not where a bug is found for the first time. CI blocks merging any change that leaves a phase's tests red; coverage is checked specifically on the classification/target-resolution/enablement/approval-flow code (2.3–3.5, the security-critical path) rather than as one aggregate percentage.

---

## 8. Deployment

- Single container for the MCP server itself; the Admin Portal (UI + Admin API) runs as a module within the Vue frontend or as its own small service, reading/writing the same SQLite file — same shape as the other two designs.
- The MCP server process needs read access to `operations`/`registry_*`/`pre_approval_rules`/`connection` (decrypting the token) and write access to `pending_approvals`/`approval_log`/`pre_approval_hits`. The Admin Portal needs full read/write on all of it, gated by its own basic-auth restriction. Separation enforced at the process/API level, same as TrueNAS/Seerr, since SQLite has no per-role DB credentials.
- Intentionally light footprint: no message queue required for v1; the notification-channel question is deferred exactly as in the other two designs (their Section 10), not reopened here.

---

## 9. Testing

- Unit tests for the classification engine: confirm every `call_service` operation classifies `write` regardless of the service name, that fixed read-side WS commands classify `read`, and that `locked` always beats `override` always beats `command-shape-default`.
- Integration test against a real or staging HA instance: confirm sync via `get_services` and the registry commands upserts correctly; confirm a read call (`get_states`) executes with no approval; confirm a service call (`light.turn_on` on a disposable test entity) blocks pending approval and correctly branches on approve/deny (both via elicitation and via the Admin Portal); confirm a `locked` call (e.g. `lock.unlock` on a test lock entity, if available in the staging environment) requires typed confirmation.
- **Target-resolution tests**: an area-targeted call resolves to exactly the entities registered in that area at call time; a call mixing direct entity IDs and an area target dedupes correctly; resolution against a since-deleted area fails closed rather than silently resolving to nothing.
- **Config-hash / optimistic-locking tests (2.8)**: a transform submitted with the current `config_hash` applies cleanly; a transform submitted with a stale hash (object changed since read, including via a direct HA UI edit in the staging instance) is rejected with `ConfigConflict` before an approval request exists; the approval prompt's rendered diff matches the actual before/after fields for a representative transform (add trigger, change a field, remove a condition).
- **Attestation tests (3.6)**: creating an automation without a `best_practice_key` is rejected with `AttestationRequired` before an approval request is created; a valid current key lets the call proceed to the normal flow; revising the guidance content invalidates outstanding keys from the prior version immediately (a session holding a now-stale key is rejected on its next attempt, not silently grandfathered); a non-attestation-required write (e.g. `light.turn_on`) succeeds with no key present at all.
- Sandbox-escape tests: attempt `require`, `fetch`, `process.env` access, prototype pollution, and infinite loops; confirm all are contained or killed.
- Approval-timeout test: confirm default-deny on timeout, never default-allow.
- **Pre-approval tests, including entity/area match**: a rule with an area selector matches only when *every* resolved target is inside that area (a call touching one entity outside it falls through to normal approval, not partially auto-approved); a rule at its rate limit falls back to requiring approval; an expired rule is treated as no rule.
- **Enablement tests**: every freshly-synced service defaults `enabled: false`; freshly-synced read commands default `enabled: true`; a disabled-operation call throws `OperationDisabled` before classification is consulted; toggling a service enabled makes it immediately callable and immediately visible in `search` without a restart.
- **Admin API tests**: `PATCH /admin/operations/:id` and `POST/PATCH /admin/pre-approval-rules` both reject (409) any attempt to touch classification or reference a `locked` operation; `GET /admin/registry` search/pagination returns correct results against a large (1,000+ entity) fixture; any admin route without basic-auth returns 401; `GET /admin/connection` never returns the plaintext token.

---

Every decision carried over from the TrueNAS and Seerr designs — stack, database, portal auth/frontend, elicitation-primary approval with notification channel deferred, enablement-toggle-first read-only default, empty `pre_approval_rules` at initial deploy — applies here unchanged and isn't reopened. All four HA-specific questions raised while writing this doc are now settled and reflected throughout: no raw `ws_command` escape hatch (2.2), surgical config-entry-flow edits with optimistic locking (2.8), replicating the `BestPracticeKey` best-practice attestation mechanic as an independent gate precondition (3.6), and the Pre-Approval Rules `match` selector's picker UI as structured, dedicated pickers — a "Match by" segmented control plus an optional entity-narrowing search (2.4), mocked in the published canvas.
