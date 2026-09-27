# Seerr MCP Server — Design Document

## 1. Purpose & Scope

Replace the current hand-curated, 6-tool Seerr MCP server (which covers only search/request/media-details/service-config, roughly 10–15 of Seerr's ~130 operations) with a **search/execute (Code Mode) server** that exposes the *entire* Seerr REST API — settings, users, notifications, requests, watchlist/blocklist, discover sliders, jobs, everything in `seerr-api.yml` — through a fixed, small tool surface, while adding a **permission gate**: reads execute automatically; every write, update, or delete requires explicit human approval before it reaches Seerr.

Goals, in priority order:
1. **Security first** — actions with real-world or account-level consequences (creating media requests that trigger downloads, deleting users, changing notification/integration credentials, modifying Radarr/Sonarr instance config, approving/declining requests on others' behalf) never execute without a human approving that specific call, with its specific parameters.
2. **Self-hosted** — a single local process/container with network access to the Seerr instance. No external SaaS dependency.
3. **Lightweight** — fixed ~1–2K token tool-definition footprint regardless of API surface (vs. ~1K today for the narrow 6-tool design, but that design only covers ~10% of the API — the new design covers 100% for roughly the same token cost).
4. **Low-maintenance, automated currency** — stays in sync with Seerr's API automatically, since Seerr (unlike TrueNAS) has no runtime introspection endpoint and the source of truth is the versioned `seerr-api.yml` OpenAPI spec in the Seerr repo.

Non-goals: this is not a general Seerr admin UI replacement, and it doesn't attempt to encode Seerr's own UI-level guardrails (quota logic, permission bitmasks) beyond what the permission gate below enforces independently.

---

## 2. Architecture

### 2.1 Pattern: Search + Execute (Code Mode)

Two MCP tools only:

- **`search(code)`** — runs sandboxed, read-only code against the cached OpenAPI document (2.2) and its classification metadata (2.3). Returns only the matched paths/schemas/examples needed for the task. The full spec never enters the model's context window.
- **`execute(code)`** — runs sandboxed code that calls a bound `seerr.request({ method, path, query, body })` function (wrapping the authenticated HTTP client, cookie or `X-Api-Key` auth). Can compose multiple calls, paginate, filter, and return a minimal focused result. Every call this code makes passes through the permission gate (Section 3) before it reaches Seerr.

### 2.2 Spec source: pinned + auto-refreshed from the Seerr repo

Unlike TrueNAS, Seerr has no live introspection endpoint — the source of truth is `seerr-api.yml`, versioned in the `seerr-team/seerr` GitHub repo.

- On startup, and on a refresh interval (see Section 5), fetch `seerr-api.yml` from the **release tag matching the connected Seerr instance's reported version** (`GET /api/v1/status` returns `version`/`commitTag`) where possible; fall back to the `develop` branch copy if no matching tag exists (common for self-hosted/nightly builds), and log which source was used.
- **Upsert the parsed result into the `operations` table** (2.6) — not a disk-cached YAML file. Each row (one per method+path) carries a timestamp and the git ref it came from; an operation missing from the latest fetch is marked `stale` rather than deleted, so classification/pre-approval history isn't lost if a fetch is briefly incomplete.
- If the fetch fails, serve from the last-synced DB rows and log a warning; refuse to start with **no** prior sync recorded and **no** successful fetch.
- Validate the fetched YAML parses as valid OpenAPI 3.0 before upserting — never write a corrupt/partial fetch's operations into the live table.

This keeps the server in sync with upstream Seerr automatically — a new Seerr release with new/changed endpoints is picked up on the next scheduled fetch with zero code changes here, and lands in the Admin Portal flagged for classification review (2.6) rather than requiring anyone to hand-edit a file.

### 2.3 Operation classification (drives the permission gate)

OpenAPI already gives a strong, mechanical signal here that TrueNAS's RPC methods don't: **HTTP method**. Classify per operation. This logic is unchanged from the file-based design — what changes is *where it's stored and edited*: classification lives on each row of the DB-backed `operations` table (2.6), populated automatically by the sync job and editable only through the Admin Portal/API, never as hand-typed YAML. An admin can only classify an operation the importer actually found in the fetched spec, selected from a picker — never a freehand path string, which is exactly what would let a typo (`/setttings/radarr` or a wrong `{param}` slug) silently fail to match the intended rule.

1. **Explicit override, locked or admin-set** — a `classification_source` of `locked` marks operations that need different treatment than the HTTP-verb default regardless of verb, seeded by the sync job's hardcoded list at import time and **not editable via the Admin UI/API at all** (2.6, 2.7): `DELETE /user/{userId}`, `DELETE /settings/radarr/{radarrId}`, `DELETE /settings/sonarr/{sonarrId}`, `POST /settings/initialize`, `POST /settings/main/regenerate` (rotates the API key — breaks any other integration using the old one), `POST /settings/jellyfin/sync` / `POST /settings/plex/sync` with `start:true` (long-running full library scan), `DELETE /settings/discover/{sliderId}`, `GET /settings/discover/reset` (despite being a GET, this is destructive — Seerr modeled a reset action as a GET; the explicit override exists specifically to catch mismatches like this one). A `classification_source` of `override` marks an admin's manual reclassification of an otherwise verb-default operation, made through the portal.
2. **HTTP-verb default**, the default the importer assigns to anything not `locked`:
   - `GET` → `read` (auto-execute).
   - `POST`, `PUT`, `PATCH`, `DELETE` → `write` (requires approval).
3. **Default-deny on ambiguity** — any operation the spec doesn't cleanly map must be surfaced in the Admin Portal as needing explicit classification rather than silently defaulting to `read`; the sync job should fail loudly (flag, not silently default) if it encounters an unrecognized HTTP method or an unparseable path.
4. The resolved classification (source: `locked`/`override`/`verb-default`, tag e.g. `settings`/`request`/`users`) is stored per operation and surfaced in `search` results — and in the Admin Portal's Operations table so an admin can review/override the verb-default ones.

**Enablement is a separate gate from classification.** Classification (above) decides *whether a call needs approval*; enablement decides *whether an operation is reachable through `search`/`execute` at all*. Every operation row also carries an `enabled` boolean, seeded automatically by the sync job from its classification at import time:

- `read` (`GET`) operations → `enabled: true` by default. Routine lookups (`GET /request`, `GET /media/{id}`, etc.) — safe to expose without a separate curation step.
- `write` and `locked` operations → `enabled: false` by default. A newly-synced write operation (e.g. `POST /request`, `DELETE /request/{id}`) is invisible to `search`/`execute` until an admin explicitly turns it on in the Operations page — at which point it's reachable, but still gated by the normal approval flow (3.1) exactly like any other write.

This is the mechanism behind the "start read-only" posture: at initial deployment, nothing needs to go into `pre_approval_rules` for the server to only expose reads — it already does, because no write operation is enabled yet. Turning on individual write operations (`POST /request`, `POST /settings/notifications/{agent}/test`, …) as they're actually needed is a distinct, later decision from whether calls to those operations still require a human (that's what `pre_approval_rules`, 3.5, is for). A disabled operation that's called anyway (e.g. from stale cached knowledge in a long-running sandboxed script) is rejected at call-time with a clear `OperationDisabled` error, same enforcement point as the classification gate (3.1) — never silently ignored.

The Operations page (2.6) carries this as its own toggle, independent of the classification dropdown; `locked` operations are never toggleable to enabled by anyone other than an admin explicitly opting in per-row (there's no "enable all writes" bulk action by design).

Note the specific Seerr risk this catches that a naive verb-based rule alone would miss: **`GET /settings/discover/reset`** and similarly-shaped "GET as action" endpoints — since it's `locked` rather than plain `read`, it also defaults to `enabled: false` like any other write, not exposed just because its verb is `GET`. Section 9 (testing) requires a full pass over the fetched spec on every sync specifically checking for `GET` operations whose `summary`/`description` contains action verbs (reset, regenerate, sync, flush, run, cancel, invoke) so new instances of this pattern in future Seerr releases are flagged in the Admin Portal for explicit classification rather than silently auto-executed or silently enabled.

### 2.4 Runtime components

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
│  OpenAPI spec cache      Permission gate         │
│  (+ classification)      (classify → approve     │
│                            or auto-run)          │
│                                │                 │
│                                ▼                 │
│                         Seerr HTTP client        │
│                    (holds cookie / X-Api-Key)    │
└───────────────────────────────┬─────────────────┘
                                 ▼
                   Seerr instance (REST API, /api/v1)
```

### 2.5 Implementation Stack (Decided)

This server is built in **Node/TypeScript on FastMCP, with `isolated-vm` as the sandbox runtime**. This is a decision, not an open question — build against this stack rather than re-evaluating alternatives (Python/subprocess, Go/goja — see prior discussion) unless a concrete blocker surfaces during implementation, in which case flag it back rather than switching silently.

- **[FastMCP](https://github.com/punkpeye/fastmcp)** (TypeScript) as the MCP server framework. It provides, out of the box: `elicit()` on the tool context / `session.requestElicitation()` for the in-session approval flow (Section 3.3), automatic session lifecycle tracking (used to trigger the debounced session-start refresh in Section 5), Zod-validated tool schemas for the two `search`/`execute` tools, and custom HTTP routes (via Hono) for the `/healthz` and `POST /admin/refresh` endpoints (Sections 5, 9) without standing up a second HTTP server. It's a thin wrapper over the official `@modelcontextprotocol/sdk` — no protocol-level compatibility risk, purely boilerplate removal.
- **`isolated-vm`** as the code sandbox for both `search` and `execute`. Runs model-authored code in a genuinely separate V8 isolate (not `vm`/`vm2`, which are not security boundaries), with only the `seerr.request` binding injected in and no ambient `require`/`fetch`/`process`/filesystem access — matches the Section 4 sandbox requirements directly.

### 2.6 Admin Portal & Configuration API (replaces config files)

**All configuration — connection credentials, operation classification, pre-approval rules, and approvals — is managed through a web admin portal and its backing REST API, stored in our own SQLite database, not through YAML files.** This mirrors the TrueNAS MCP server's design exactly (same rationale: we already run a frontend and a DB for this, so a file-based config would be a second, disconnected configuration surface) — read that document's Section 2.6 for the full reasoning; this section adapts it to Seerr's OpenAPI/HTTP-verb model.

The UI shape again borrows from Cloudflare's MCP server portal (Cloudflare One → Access controls → MCP Portals) and its WriteGuard write-permission work: a connection/server view with live status, an operations table with per-row classification and edit actions, a default-approve-required-unless-curated posture for writes, and a hard non-approvable tier for the riskiest actions.

**Why this also solves the mistyping problem directly**: every operation an admin can classify or write a pre-approval rule against comes from the `operations` table (2.3), populated *only* by the sync job parsing the fetched `seerr-api.yml`. There is no free-text method+path field anywhere in the admin UI or API — an admin picks from an auto-populated, searchable list (e.g. "`POST /request`", not a typed string that could drift from the real path or miss a `{param}` slug), so a typo simply can't produce a rule that silently fails to match the intended operation.

**Pages/views** (built as Vue components — this is a functional spec, not a full component spec):

| Page | Purpose | Maps to Cloudflare portal concept |
|---|---|---|
| **Connection** | Seerr URL + API key (or dedicated service-account credential, per 3.4's operational note) entry, "Test connection" action, live status (Ready / Error / Unreachable), "Sync now" button, last-sync timestamp + resolved spec source (matching release tag vs. `develop` fallback) | Server add/edit + Ready/Error/Waiting status + "Authenticate server" |
| **Operations** | Searchable/filterable table of every synced operation: method+path, classification (`read`/`write`/`locked`), source, **Enabled toggle** (on by default for `read`/`GET`, off by default for `write`/`locked` — 2.3), tag (settings/request/users/…), last-seen. "New" badge on operations first seen in the latest sync, with extra visual flagging for any `GET` the "GET as action" heuristic (2.3) has flagged. Classification dropdown editable per row *except* `locked` rows (disabled with a lock icon and tooltip); the Enabled toggle is a separate control on every row, including `locked` ones — locking an operation prevents it ever being pre-approved or reclassified, but doesn't by itself prevent an admin from choosing to expose it (still gated by the full approval/typed-confirmation flow once enabled) | Tools panel with per-tool toggles/aliases; `default_disabled` + explicit-enable pattern |
| **Pre-Approval Rules** | List + create/edit form: operation (picker, not free text), match constraints (structured fields — e.g. a boolean toggle for `is4k`, a media-type selector — not a hand-written JSON blob where avoidable), rate limit, expiry date picker, required reason field, enabled toggle, last-triggered timestamp | Closest Cloudflare analog: allowlist pattern (`default_disabled` + `updated_tools`), generalized with match/rate-limit/expiry |
| **Pending Approvals** | Inbox of paused write calls awaiting a decision — full request body/query, matched operation, classification reason, Approve/Deny buttons. First-party alternative to an external Slack/ntfy channel (3.3) for headless runs, using the existing app's own notification system rather than a new integration | Logs / request history view |
| **Audit Log** | Every `search`/`execute` call: method+path, classification, decision (`human-approved`/`auto-approved: <rule>`/`denied`/`timed-out`), decider, timestamp. Filterable, exportable | Per-tool request logs (status, duration) |

**Admin API** (REST, backing the UI — exact routing/framework left to whichever stack we settle on):

- `GET/PUT /admin/connection` — credential is **write-only**: `PUT` accepts it, `GET` returns a masked form or nothing, never the plaintext back. `POST /admin/connection/test` validates without saving.
- `POST /admin/sync` — trigger an immediate spec sync (same operation the session-start/cron triggers from Section 5 call internally).
- `GET /admin/operations`, `PATCH /admin/operations/:id` — list/filter; `PATCH` accepts `classification_source: override` and/or `enabled: true|false` as independent fields on the same row. **Server-side rejects any attempt to change the classification of a `locked` row with a 409**, regardless of what the UI shows. The `enabled` field has no such restriction: even a `locked` operation can be toggled enabled by an admin (2.3) — locking only protects classification and pre-approval eligibility, not visibility.
- `GET/POST/PATCH/DELETE /admin/pre-approval-rules` — CRUD. `POST`/`PATCH` **validates against the `locked` operation set and rejects with a 409** if the referenced operation is non-approvable. This replaces the file-based design's "refuse to start the server" check with an instant "refuse to save the rule" — caught in the UI at edit time, not discovered at next deploy.
- `GET /admin/pending-approvals`, `POST /admin/pending-approvals/:id/approve|deny` — backs the Pending Approvals page; also what a portal-side notification link (email/push) points at.
- `GET /admin/audit-log` — filterable read of the audit trail (Section 4).

**Portal authentication** — separate from both the Seerr credential and the MCP transport auth: a single basic-auth restriction (one shared credential, or a small credential we manage ourselves) gates the whole portal. No role split and no maker-checker — this is a personal, single-operator setup, so the added process of a second approver reviewing every classification/rule change isn't warranted. If that ever changes, this is the place to revisit it, but it's not part of the initial design.

**Database**: SQLite, stored as a single file alongside the server (or wherever we run the frontend from). Table shapes:

```
operations(id, method, path, tag, classification, classification_source, enabled, locked, first_seen_at, last_seen_at, stale)
pre_approval_rules(id, operation_id FK, match TEXT, rate_limit, window_seconds, expires_at, reason, enabled, created_by, created_at)
pre_approval_hits(id, rule_id FK, occurred_at)              -- rolling counter for rate-limit enforcement
pending_approvals(id, operation_id FK, params TEXT, requested_at, status, decided_by, decided_at)
approval_log(id, operation_id FK, params TEXT, classification, decision, decided_by, decided_at, source)  -- source: human | pre_approval_rule:<id> | timeout | denied
connection(id, base_url, credential_encrypted, last_synced_at, last_sync_status, resolved_spec_ref)
```

`match` and `params` are stored as `TEXT` columns holding JSON-encoded content (SQLite has no native JSON/JSONB column type — JSON is just text with `json_*()` helper functions available at query time if needed). `credential_encrypted` uses application-level encryption (a master key held outside the SQLite file itself — an env var or a small local secrets file, not a DB row) — the plaintext Seerr credential is never queryable back out through the Admin API once saved, only usable server-side by the MCP process itself. Given 3.4's operational note about `POST /settings/main/regenerate` invalidating this server's own key, the Connection page should also surface a clear warning if the credential in use is the same key visible/rotatable elsewhere in the Seerr admin UI, if that's detectable — otherwise document the dedicated-service-account recommendation prominently in the Connection page's help text.

---

## 3. Permission Model: Approved Read / Required Approval for Write & Delete

Hard requirement, not a configurable default: **`GET` reads execute immediately; every `POST`/`PUT`/`PATCH`/`DELETE` (and any explicitly flagged "GET as action" endpoint) blocks on human approval before touching Seerr — unless it matches an operator-defined pre-approval rule (3.5), in which case it auto-executes and is logged as such.**

### 3.1 Flow

1. Model calls `execute(code)`.
2. The sandbox's *only* path to Seerr is the injected `seerr.request({ method, path, query, body })` binding — no raw network access. Each call through this binding is intercepted at call-time, matched against the OpenAPI operation it resolves to, and classified (2.3).
3. **Enablement check, first** (2.3): if the resolved operation's `enabled` flag is `false`, the binding throws a structured `OperationDisabled` error immediately — no classification lookup, no approval flow, the call never gets that far. Logged as `rejected: disabled`.
4. If enabled: `read` → executes immediately inline, result flows back into the running sandboxed code.
5. `write`/`destructive` → check `pre_approval_rules` (3.5, 2.6) for a matching, unexpired, rate-limit-available rule.
   - **Matched** → executes immediately, logged as `auto-approved (pre-approval: <rule id>)`, no approval request created.
   - **No match** → paused. An approval request is created (3.3) and the sandbox blocks on it. Default: the whole `execute` invocation blocks on that pending call rather than letting surrounding reads race ahead.
6. Approved (or pre-approved) → the real call runs, execution resumes.
7. Denied or timed out → the binding throws a structured `PermissionDenied` error back into the sandboxed code; the attempt is logged either way.

`search` results are also filtered to `enabled` operations only by default, so the model doesn't see operations it can't call and doesn't waste a turn attempting one — a disabled operation simply doesn't appear as a match. (An optional `includeDisabled` flag on `search` can surface them anyway, tagged `disabled`, useful for an admin-assisted session deciding what to turn on next — off by default.)

### 3.2 Why call-time interception, not static pre-analysis

Same reasoning as the TrueNAS design: classifying arbitrary generated code ahead of time is brittle. The `seerr.request` binding is the sole egress; every call through it is checked at the moment it happens, regardless of how the surrounding code is structured. An optional cheap static pre-scan can still reject submissions that try to reach outside the sandbox (`fetch`, `require`, `import`, `process`, nested `eval`) as defense-in-depth, but it's not the security boundary.

### 3.3 Approval mechanism

- Each pending write/destructive call generates an approval request: HTTP method + path, full query/body params, the matched operation's `summary` from the spec, classification source/reason, and a human-readable summary (e.g. "This will permanently delete user `alex@example.com` (id 14)" or "This will request 1 season of *Show Title* (tvdbId 1234) for download").
- **Primary delivery: MCP elicitation.** The server sends an `elicitation/create` request back over the live MCP connection; the connected client (the agent) presents it to the person in-session and relays their decision back — no external service, webhook, or extra credential required. This is a standard MCP protocol capability and is how Cloudflare's own Code Mode / human-in-the-loop implementation surfaces destructive-action approvals. Use this whenever a live MCP session with a human on the other end is active.
- **Fallback delivery: notification channel (headless/unattended runs only).** If `execute` runs with no live session to elicit against — e.g. a scheduled request-processing job — fall back to an external notification path (Slack webhook, ntfy, email) carrying an approve/deny link. Only needed if the deployment intends to run unattended; skip it if all usage is interactive.
- Detect which path applies per-call: use elicitation if the connected MCP session supports it (per capability negotiation) and is currently connected; otherwise use the configured notification channel if one exists; if neither is available, auto-deny immediately and log "no approval path available" rather than leaving the call hanging.
- **Default timeout**: 15 minutes, configurable (applies to both paths). Unanswered → **auto-denied**, never auto-allowed, and logged.
- Approvals are **single-use, scoped to the exact request presented** — approving one media request never pre-authorizes another, even for the same title (e.g. a different season/profile).
- Persist to the `pending_approvals` and `approval_log` tables (2.6) — the same DB the Admin Portal reads for its Pending Approvals and Audit Log pages: timestamp, method+path, params/body, requester/session context, decision, decider identity, decision timestamp.

### 3.4 Extra confirmation for high-impact operations

A subset of `write` operations get a **typed confirmation** beyond the normal approval, because the consequence is either irreversible or affects other users/integrations: `DELETE /user/{userId}`, `POST /settings/main/regenerate` (invalidates the current API key — including this server's own, if it authenticates via API key rather than a dedicated service account/cookie), `DELETE /settings/radarr/{radarrId}` / `DELETE /settings/sonarr/{sonarrId}`, `PUT /user` (batch permission changes), any request-approval action (`POST` on the request-management endpoints) performed **on behalf of a different user than the one who filed the request**. These are the operations seeded as `locked` in the `operations` table (2.3, 2.6) — set once by the sync job's hardcoded list, not editable through the Admin UI/API at all.

**On-behalf-of approval pattern — decided: free (any approver).** Whoever is driving the MCP session, backed by this server's own Seerr account (Section 10 covers the admin-vs-service-account choice for that account), can approve or decline any user's request — mirroring exactly what Seerr's own web UI already allows an account with `MANAGE_REQUESTS`/`ADMIN` to do. This server adds no extra restriction beyond that: it doesn't check that the approver and the original requester match. The only guard is that these calls stay in the typed-confirmation/`locked` tier above, so an on-behalf-of approval is never silently pre-approved by a `pre_approval_rules` entry (3.5) — it always requires a live, explicit decision.

**Operational note**: because `POST /settings/main/regenerate` can invalidate this server's own credential, this server should authenticate via a **dedicated local-account cookie session or a separately-issued API key**, never the same key an operator might rotate through the Seerr UI for other purposes — otherwise a routine key rotation elsewhere silently breaks this integration. Document this prominently on the Admin Portal's Connection page (2.6).

### 3.5 Pre-Approved Actions (Operator-Configured Auto-Allow)

The default is still "every write needs a human." Pre-approval is an explicit, narrow opt-in that lets an operator mark *specific* write operations as safe to run without a live approval — e.g. "standard (non-4K) media requests within a user's existing quota" or "sending a test notification to an already-configured integration." This is what makes fully unattended automation (e.g. an agent processing a backlog of requests) practical without wiring up an external notification channel (3.3) for every write it might make — but only for the writes actually covered by a rule; anything outside the rule set still falls back to needing approval, and in a headless context with no other approval surface configured, that still means auto-deny (fail closed) — though note the Admin Portal's own Pending Approvals inbox (2.6) is itself an approval surface, so "headless" here specifically means "no admin checking the portal either," a narrower case than before.

**Config**: managed entirely through the **Pre-Approval Rules page and `/admin/pre-approval-rules` API** (2.6) — no YAML file. Every rule references an `operation_id` selected from the synced `operations` table, never a typed method+path string.

**Rule shape**, per entry (form fields on the Pre-Approval Rules page):
- `operation` — picked from the synced operations list (e.g. `POST /request`) — not free text.
- `match` (optional but recommended) — a structured constraint on the request body/query, so "allow media requests" doesn't silently mean "allow 4K requests" or "allow requests bypassing quota." E.g. an `is4k` toggle (off), or a media-type selector (movie only, if TV is meant to stay manual). A rule with no `match` applies to any body for that operation — use sparingly.
- `rate_limit` (optional, recommended) — max executions per time window (e.g. `20/hour`). Bounds the blast radius of a bug or runaway loop even for a pre-approved rule. Enforced via the `pre_approval_hits` rolling-counter table (2.6). Once hit, further matching calls fall back to the **normal approval flow** for the rest of the window.
- `expires_at` (optional) — date picker; TTL after which the rule reverts to requiring approval.
- `reason` (required form field, not a convention) — one-line human justification, enforced by the API schema.

**Hard boundary — cannot be bypassed via the UI or API**: any operation seeded `locked` (3.4, 2.3.1) — `DELETE /user/{userId}`, `POST /settings/main/regenerate`, `DELETE /settings/radarr/{radarrId}`/`sonarr/{sonarrId}`, `GET /settings/discover/reset`, etc. — can **never** be referenced by a pre-approval rule. `POST`/`PATCH /admin/pre-approval-rules` validates this server-side and rejects with a 409 if the selected operation is locked; the picker itself should also simply not offer locked operations as selectable, but the API enforces it independent of what the frontend shows.

**Audit trail**: a pre-approved execution is logged exactly like every other call, tagged `auto-approved (pre-approval: <rule id>)` rather than `human-approved` — visible in the Admin Portal's Audit Log page with a click-through to the authorizing rule.

**Example rules** (illustrative — what an operator would enter into the Pre-Approval Rules form, not a default/seeded configuration):

| Operation | Match | Rate limit | Reason |
|---|---|---|---|
| `POST /request` | `is4k: false` | 20/hour | Routine standard-quality media requests within user quota; 4K stays manual. |
| `POST /settings/notifications/{agent}/test` | — | 10/hour | Sending a test notification has no persistent effect; safe to automate. |

---

## 4. Security

- **Sandbox**: model-authored code runs in an isolated context (`isolated-vm` for Node, or a locked-down subprocess with no filesystem/network access besides the injected binding) — never `eval`/`vm.runInContext` in the main process, never a shared long-lived interpreter reused across requests.
- **No credentials inside the sandbox**: the sandbox only ever sees the bound `seerr.request` function — never the API key or session cookie. Credentials live only in the outer server process.
- **Seerr account scope**: a full `ADMIN`-equivalent Seerr account is the accepted operating assumption for this deployment — the server does not attempt to run with a narrower `permissions` bitmask by design, but it also doesn't *require* full admin specifically: every `seerr.request` call is wrapped so a `401`/`403` from Seerr (whatever permission bits are actually on the configured account) surfaces as a clean, structured error back through `execute` — logged, and returned to the model as "Seerr denied this call: insufficient permission," never a crash or a silent no-op. If the account is ever swapped for a narrower one later, the server keeps working for whatever that account can reach and degrades gracefully on the rest.
- **Resource limits**: hard timeout (default 10s) and memory cap per `search`/`execute` call; kill and error on breach.
- **Rate limiting**: cap `execute` calls per minute, especially write-classified ones — Seerr's own request-quota system is a per-user soft limit, not a hard stop against a misbehaving integration hammering the endpoint.
- **Audit log**: every `search` and `execute` call — including denied/timed-out approvals — logged with method+path, params (secrets redacted), classification, decision, and result status. Append-only in the `approval_log` table (2.6), readable by operators only via the Admin Portal's Audit Log page, never editable or deletable through the Admin API.
- **Redaction**: fields matching a documented sensitive-field list (`apiKey`, `plexToken`, `jellyfinAuthToken`, `password`, `webhookUrl` with embedded tokens, SMTP `authPass`) are redacted before being returned to the model or written to logs — several Seerr `GET` (read) endpoints legitimately return these (e.g. `GET /settings/main`, `GET /user/{userId}`), so redaction must apply on reads too, not just writes — and before being rendered anywhere in the Admin Portal UI, including the Audit Log and Pending Approvals pages.
- **No runtime privilege escalation**: `operations.classification`, `operations.enabled`, and `pre_approval_rules` are only editable through the Admin Portal/API, behind the portal's basic-auth restriction — never by the running MCP server process itself, and never by model-generated code. There is no MCP tool that writes to any of the three; the sandbox has no DB access at all, only the `seerr.request` binding, so sandboxed code can never enable an operation for itself.
- **Pre-approval cannot widen past the hard boundary**: `locked` operations (3.4, 2.3.1) are non-referenceable by any `pre_approval_rules` row — enforced at the Admin API layer (409 on violation), independent of and in addition to whatever the frontend UI happens to show.
- **Credential storage**: the Seerr credential is stored application-level-encrypted in the `connection` table (2.6), decryptable only by the MCP server process with its own master key/KMS access — the Admin API never returns it in plaintext once saved; re-entry is required to rotate it, not "reveal then re-save."
- **Portal auth is a separate boundary from MCP transport auth**: compromising the portal's basic-auth credential lets someone reclassify operations and write pre-approval rules (bounded by the `locked` floor above); compromising the MCP transport lets someone *call* the exposed `search`/`execute` tools. Both need independent protection — the portal's basic-auth restriction (2.6) should not be treated as also covering the MCP endpoint's own auth.
- **Network exposure**: bind to localhost or an internal network by default. If exposed further, require TLS and MCP-transport auth (bearer token/API key) in front of it — don't rely on Seerr's own auth, or the portal's auth, as the only gate for the MCP endpoint itself.
- **CSRF/cookie handling**: if authenticating to Seerr via cookie session rather than `X-Api-Key`, ensure the outer HTTP client re-authenticates on session expiry rather than silently failing calls; prefer `X-Api-Key` auth for this integration specifically since it has no CSRF surface and is simpler to scope/rotate independently (see 3.4 operational note).
- **Admin API hardening**: standard web-app protections apply since this is now a real HTTP admin surface — CSRF protection on all state-changing routes, session/JWT expiry, rate limiting on the login and `/admin/connection/test` routes specifically.

---

## 5. Maintenance & Auto-Update

- **Spec refresh — primary trigger: session start (debounced).** On every new MCP session/connection, check the last sync timestamp on the `connection` row (2.6); if older than a short threshold (default 1h, configurable), refresh `seerr-api.yml` from the matching release tag (falling back to `develop`) and upsert into `operations` before serving the session's first `search`/`execute`. A simple lock/debounce prevents a thundering herd when several sessions start at once — concurrent starts within the window share the existing state; only the first triggers a fetch.
- **Version-triggered refresh (also runs at session start)**: the `connection` row records both the git ref the last sync came from and the Seerr instance's reported `version`. At each session start, cheaply compare it against a fresh `GET /status` call regardless of sync age; on any mismatch, force an immediate refresh — this is what catches an actual Seerr upgrade without waiting on the debounce window.
- **Spec refresh — backstop: low-frequency cron.** A scheduled job (in-container cron or external scheduler) also runs the same refresh on a long interval (default: daily) and on manual trigger (`POST /admin/sync`, same endpoint the portal's "Sync now" button calls), purely as a safety net for stretches with no session starts at all — session-start refresh alone would let the catalog go fully stale during a quiet period or a mostly-headless deployment.
- **Mid-session staleness**: a long-lived session won't pick up a mid-session Seerr upgrade from the session-start trigger alone, since that check only runs once at connection time. Re-run the cheap version comparison on a lightweight interval within long-lived sessions too (e.g. every 30 min) if the deployment expects long sessions; otherwise document this as a known limitation.
- **Classification drift**: a newly discovered operation is inserted into `operations` with `classification_source: verb-default` (2.3) and `first_seen_at` set to now — the Admin Portal's Operations page surfaces this as a "New" badge, with the "GET as action" heuristic scan (2.3, final paragraph) run automatically on every sync to catch a new `GET /something/reset`-shaped endpoint before it's treated as a plain read. An operation absent from the latest sync is marked `stale` rather than deleted, preserving classification/pre-approval history against it.
- **Spec source drift monitoring**: since this depends on `seerr-team/seerr`'s repo structure staying stable (file path, OpenAPI version, tag naming), add a startup/sync sanity check — if the fetched file fails to parse as OpenAPI 3.0, or the file is unexpectedly tiny/empty, treat it as a fetch failure (fall back to the last-synced DB state) rather than corrupting the live `operations` table.
- **Dependency hygiene**: pin dependencies; run CI against a test/staging Seerr instance before deploying; enable Dependabot/Renovate for the sandbox runtime, MCP SDK, and OpenAPI-parsing library.
- **Health check**: `/healthz` reports last sync age + source ref, last successful Seerr connection, pending-approval count, sandbox runtime status, DB connectivity.

---

## 6. Documentation

- **README.md**: setup (Seerr account/API key creation + required permission bits, DB schema migration, setting the portal's basic-auth credential), how search/execute works, how to answer a pending approval (both via MCP elicitation and via the Admin Portal's Pending Approvals page), how pre-approval rules work and their hard limits (3.5), troubleshooting connection/spec-fetch issues.
- **In-portal help text** replaces the old heavily-commented YAML files: the Operations page explains `locked` vs `override` vs `verb-default` inline, including why `GET /settings/discover/reset` is locked despite its verb; the Pre-Approval Rules form explains `match`/`rate_limit`/`expires_at` inline, and the `reason` field is enforced by the API schema rather than by a comment convention. No YAML file to comment.
- **On-demand docs inside `search` results**: Seerr's spec already carries decent `summary`/`description` text per operation (visible in the fetched YAML) — surface this directly through `search` rather than re-writing it, so the model gets the same guidance a human reading the Seerr API docs would, without it costing anything until a matching `search` is actually run.
- **Change history**: since classification/pre-approval changes now happen through the portal rather than as git diffs on a YAML file, the rule-edit history in the DB (2.6) *is* the changelog — the Admin Portal should let an operator filter the Audit Log specifically to configuration changes (operation reclassifications, rule create/edit/delete), not just tool-call approvals, so this security-relevant history stays reviewable without needing git.
- **Runbook** (`docs/runbook.md`): what to do when Seerr is unreachable, an approval is stuck pending, the spec fetch fails (network, repo restructure, tag not found), a Seerr release changes an endpoint's shape in a way that breaks classification assumptions (e.g. a new `GET`-as-action endpoint shipped before the automated heuristic caught it), or the Admin Portal's DB is unreachable (recommend failing open on *reads* of the classification table using the last-synced state, while still failing closed on any write it can't classify with confidence).

---

## 7. Development Phase (TDD)

Built test-first, in the phases below, in order. Each phase's tests are written before that phase's implementation and must pass — along with every earlier phase's tests, run as regression — before moving to the next. A phase is never "made to pass" by loosening its own test; if a test turns out wrong, that's a deliberate, called-out change to the test, not a quiet weakening.

This order follows the dependency chain already laid out in 2.4 and 3.1 — each phase is the smallest testable unit that the next phase builds on, so the security-critical logic (classification, enablement, approval) is proven correct in isolation, with mocks, well before it's wired to a real Seerr instance, a real sandbox, or a real UI.

1. **Operation classification (2.3)** — pure functions, no network/DB/sandbox involved. Tests first: `GET` → `read`, `POST`/`PUT`/`PATCH`/`DELETE` → `write`; a `locked` classification always wins regardless of verb (including the "GET as action" cases like `GET /settings/discover/reset`); `override` wins over verb-default but never over `locked`; the "GET as action" heuristic scan flags an action-shaped `GET` for explicit review rather than silently defaulting it to `read`. Implement only enough to pass.
2. **Enablement gate** — tests first: a freshly-classified `read`/`GET` operation defaults `enabled: true`; write and `locked` operations default `enabled: false`; a call to a disabled operation is rejected (`OperationDisabled`) before classification is even consulted. Implement.
3. **Spec fetch and sync (2.2)** — tests against a mocked `seerr-api.yml` fetch: correct upsert into `operations`, fallback from a missing release tag to `develop`, `stale` marking for operations absent from a fetch, rejection of a fetch that doesn't parse as valid OpenAPI 3.0, refuse-to-start when there's no prior sync *and* no successful fetch. Implement against a fake HTTP client; the real fetch against GitHub is wired in a later phase.
4. **Sandbox binding (2.5, 4)** — tests first: sandboxed code's only egress is the injected `seerr.request` binding; attempts to reach `require`/`fetch`/`process`/filesystem are contained; a `PermissionDenied`/`OperationDisabled` thrown by the binding propagates back into the sandboxed code as a catchable error, not a crash. Implement the `isolated-vm` wiring.
5. **Approval flow (3.1, 3.3)** — tests first against a fake elicitation transport (no real MCP client needed yet): a `read` call auto-executes; a write call with no matching pre-approval rule pauses and creates a pending approval; approve/deny branch correctly, including the free/any-approver on-behalf-of pattern (3.4); an unanswered request auto-denies on timeout; an approval is single-use and scoped to its exact request. Implement.
6. **Pre-approval rules (3.5)** — tests first: a matching, unexpired, rate-limit-available rule auto-executes and logs `auto-approved`; a rule at its `rate_limit` falls back to the normal approval flow for the rest of the window; an expired rule is treated as no rule; a `locked` operation can never be referenced by a rule (rejected, not silently ignored). Implement.
7. **Admin API (2.6)** — contract tests first, one per endpoint: `GET /admin/connection` never returns the plaintext credential; `PATCH /admin/operations/:id` rejects a classification change on a `locked` row with 409 but accepts an `enabled` toggle on one; `POST/PATCH /admin/pre-approval-rules` rejects a `locked` operation with 409; any admin route returns 401 without the basic-auth credential. Implement the REST layer against the same SQLite schema the earlier phases already exercise.
8. **Admin Portal UI (Vue, 2.6)** — component/interaction tests (e.g. Vitest + Testing Library) for each page in 2.6's table, written against the Admin API's contract (mocked per phase 7's tests) before wiring the real API client: the Operations page's Enabled toggle and classification dropdown act independently; a `locked` row's classification control is disabled while its Enabled toggle isn't; the Pre-Approval Rules form won't let a `locked` operation be picked; the Pending Approvals page's Approve/Deny buttons call the right endpoints.
9. **`search`/`execute` MCP tools (2.1)** — integration tests: `search` returns only `enabled` operations by default and includes disabled ones, tagged, when asked; `execute` runs the full call-time flow (enablement → classification → approval-or-pre-approval) end-to-end against the fake elicitation transport and the fake Seerr client from earlier phases.
10. **Maintenance jobs (5)** — tests first, against a mocked clock/scheduler: session-start debounce and its lock behave correctly under concurrent session starts; a Seerr version mismatch forces an immediate refresh regardless of debounce; the cron backstop fires on its own schedule; mid-session staleness re-checks happen on the configured interval; spec-source drift monitoring correctly falls back to the last-synced state on a malformed fetch.

Only after all of the above pass against mocks does a real/staging Seerr instance enter the picture, for the integration tests in Section 9 — that pass is confirmation the mocked contracts matched reality, not where a bug is found for the first time. CI blocks merging any change that leaves a phase's tests red, and coverage is checked specifically on the classification/enablement/approval-flow code (the security-critical path, 2.3–3.5) rather than as one aggregate percentage that a well-tested UI could quietly carry.

---

## 8. Deployment

- Single container for the MCP server itself (Docker); the Admin Portal (UI + Admin API) can run as a module within the Vue frontend, or as its own small service — either way, it reads/writes the same SQLite file rather than standing up a separate DB instance.
- The MCP server process needs read access to `operations`/`pre_approval_rules`/`connection` (decrypting the credential) and write access to `pending_approvals`/`approval_log`/`pre_approval_hits`. The Admin Portal needs full read/write on all of it, gated by its own basic-auth restriction (2.6). SQLite doesn't support per-role DB credentials the way a server-based engine would, so this separation is enforced at the process/API level (only the Admin API writes to `operations`/`pre_approval_rules`; only the MCP server writes to `pending_approvals`/`approval_log`/`pre_approval_hits`) rather than via DB-level roles.
- Intentionally light footprint despite the added DB dependency: no message queue required for v1; the "external notification channel" question from Section 3.3/10 is now substantially narrower, since the Admin Portal's own Pending Approvals page is a first-party fallback that needs no new infrastructure.

---

## 9. Testing

- Unit tests for the classification engine: given a set of OpenAPI operations, verify correct read/write/destructive output by HTTP verb, and that `locked` always beats `override` always beats `verb-default`.
- **"GET as action" regression test**: run the heuristic scan (2.3) against the current `seerr-api.yml` and assert its output matches a checked-in expected list; fail CI if a new unclassified action-shaped `GET` appears without a corresponding `locked` entry in the seed list.
- Integration test against a real or staging Seerr instance: confirm sync works and correctly falls back to `develop` when no matching release tag exists; confirm a read call (`GET /request`) executes with no approval; confirm a write call (`POST /request` for a disposable test title, or `DELETE` on a test user) blocks pending approval and correctly branches on approve/deny (both via elicitation and via the Admin Portal's approve/deny endpoint).
- Sandbox-escape tests: attempt `require`, `fetch`, `process.env` access, prototype pollution, and infinite loops from submitted code; confirm all are contained or killed.
- Approval-timeout test: confirm default-deny on timeout, never default-allow.
- Redaction test: confirm `GET /settings/main`, `GET /user/{userId}`, and similar credential-bearing read endpoints have secrets stripped from both the model-facing result and the audit log, and from the Admin Portal's rendered UI.
- **Pre-approval tests**: a matching rule auto-executes with no approval request created and is logged as `auto-approved`; a non-matching call (wrong operation, or body outside `match` — e.g. `is4k: true` against a non-4K-only rule) falls through to the normal approval flow; a rule at its `rate_limit` falls back to requiring approval for the rest of the window; an expired rule is treated as no rule at all.
- **Enablement tests**: a freshly-synced `GET`/`read` operation has `enabled: true`; a freshly-synced write or `locked` operation has `enabled: false`; a call to a disabled operation throws `OperationDisabled` before classification is even consulted, and is logged as `rejected: disabled`; toggling an operation enabled through the Admin API makes it immediately callable (and immediately shows up in `search` results) without a restart; `search` excludes disabled operations by default and includes them, tagged, when `includeDisabled` is passed.
- **Admin API tests**: `PATCH /admin/operations/:id` and `POST/PATCH /admin/pre-approval-rules` both reject (409) any attempt to touch classification on a `locked` operation, but accept an `enabled` toggle on one; any admin route without the basic-auth credential returns 401; `GET /admin/connection` never returns the plaintext credential; CSRF protection is verified on all state-changing admin routes.

---

## 10. Open Decisions — Claude Code Should Ask, Not Assume

Implementation stack (Node/TS + FastMCP + `isolated-vm`) is **decided** — see 2.5. Configuration now lives in our own SQLite database behind an Admin Portal (2.6), not config files — also decided. Portal auth is a single basic-auth restriction, no RBAC — also decided. The portal's frontend is **Vue** — also decided; build the Pages/views in 2.6 as Vue components rather than asking again. The basic-auth credential is **provisioned via environment variables** (read at process startup, compared against the request's `Authorization` header — never stored in the SQLite DB itself) — also decided. Remaining open items:

- **Notification channel for approvals — deferred.** Not part of v1: the Admin Portal's own Pending Approvals page (2.6) plus MCP elicitation (3.3) are the whole approval surface for now. An external channel (Slack/webhook/ntfy/email) is left as a future iteration if unattended runs later need a push notification beyond checking the portal — the approval mechanism (3.3) is already written so adding a channel later is additive, not a redesign.
- Full `ADMIN`-equivalent access is **decided** (Section 4) — the server is built to work with whatever Seerr permission bits the configured account actually has, granted as full admin for now, and to fail gracefully (structured error, not a crash) on any call the account isn't permitted to make.
- Whether this server authenticates as a dedicated local Seerr service account (recommended, see 3.4) or reuses an existing admin API key — ask, since reuse creates the key-rotation fragility called out in 3.4.
- On-behalf-of approval is **decided as free/any-approver** (3.4) — no further question there.
- **Initial deployment posture is decided as read-only, enforced via the `enabled` toggle (2.3), not via `pre_approval_rules`.** Every operation starts with `enabled: true` if `read`(`GET`)-classified and `enabled: false` if write/`locked` — set automatically by the sync job, not something to seed by hand. So at initial deployment `search`/`execute` only ever surface reads; no write operation is reachable at all until an admin turns it on in the Operations page, one at a time. `pre_approval_rules` stays a fully separate, later decision — it controls whether an *enabled* write still needs a live approval or can auto-run, and ships empty regardless (every enabled write requires approval until a rule says otherwise).
