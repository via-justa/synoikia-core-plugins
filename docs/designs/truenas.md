# TrueNAS MCP Server — Design Document

## 1. Purpose & Scope

Replace the current hand-curated, 52-tool TrueNAS MCP server with a **search/execute (Code Mode) server** that exposes the entire TrueNAS JSON-RPC API (~650–700 methods across ~110 namespaces) through a fixed, small tool surface, while adding a **permission gate**: reads execute automatically; every write, update, delete, or state-changing call requires explicit human approval before it reaches TrueNAS.

Goals, in priority order:
1. **Security first** — destructive/irreversible operations (`disk.wipe`, `pool.export`, `system.reboot`, `pool.dataset.delete`, etc.) never execute without a human approving that specific call, with its specific parameters.
2. **Self-hosted** — runs as a single local process/container with network access to the TrueNAS instance. No external SaaS dependency.
3. **Lightweight** — fixed ~1–3K token tool-definition footprint regardless of API size (vs. ~15–20K today, ~100K+ for a naive 1:1 wrapper).
4. **Low-maintenance, automated currency** — stays current with TrueNAS API changes automatically, using TrueNAS's own live method introspection rather than a manually maintained spec file.

Non-goals: this is not a general-purpose TrueNAS admin UI. It does not try to replicate the wizard-style guidance baked into the current 52 tools inside the model's permanent context — that guidance moves to on-demand documentation retrieval (Section 6).

---

## 2. Architecture

### 2.1 Pattern: Search + Execute (Code Mode)

Two MCP tools only:

- **`search(code)`** — runs sandboxed, read-only code against the current method catalog (2.2) and its classification metadata (2.3). Returns only the matched methods/schemas/examples needed for the task. The full catalog never enters the model's context window.
- **`execute(code)`** — runs sandboxed code that calls a bound `truenas.call(method, params)` function (wrapping the authenticated JSON-RPC/WebSocket client). Can compose multiple calls, filter, and return a minimal focused result. Every call this code makes passes through the permission gate (Section 3) before it reaches TrueNAS.

This assumes the prior analysis's conclusion (token cost, coverage, maintenance burden favor this pattern over the current 52-tool design and over a naive 1:1 wrapper) and specifies the implementation.

### 2.2 Method catalog source: live introspection, not a static file

TrueNAS exposes `core.get_methods`, returning the full current method set directly from the running instance. Use this as the **primary source of truth** instead of vendoring a copy of the generated `api.truenas.com` docs.

- On startup, and on a refresh interval (see Section 5), call `core.get_methods` and `core.get_services` against the connected instance.
- **Upsert the result into the `methods` table** (2.6) — not a disk-cached JSON file. Each row carries the method name, a timestamp, and the TrueNAS `system.version` string it was captured against; a method missing from the latest sync is marked `stale` rather than deleted outright, so classification/pre-approval history isn't lost if a sync is briefly incomplete.
- If the live instance is unreachable at startup, serve from the last-synced DB rows and log a warning; refuse to start with **no** prior sync recorded and **no** live connection.

Result: upgrading TrueNAS from 25.10 to 26 requires zero code changes here — the next refresh picks up new/changed/removed methods automatically, and any genuinely new method lands in the Admin Portal flagged for classification review (2.6) rather than requiring anyone to hand-edit a file.

### 2.3 Method classification (drives the permission gate)

`core.get_methods` metadata alone isn't a reliable read/write signal for security purposes, so classify with a **layered, fail-closed** approach. This logic is unchanged from the file-based design — what changes is *where it's stored and edited*: classification lives on each row of the DB-backed `methods` table (2.6), populated automatically by the sync job and editable only through the Admin Portal/API, never as hand-typed YAML. This is what eliminates the mistyped-method-name failure mode: an admin can only classify a method that the importer actually found on the live instance, selected from a picker, never typed freehand.

1. **Explicit override, locked or admin-set** — a `classification_source` of `locked` marks known-destructive methods regardless of naming (`system.reboot`, `system.shutdown`, `pool.export`, `disk.wipe`, `config.reset`, `user.set_password`, `pool.dataset.change_key`, `pool.dataset.delete`, etc.) and is seeded by the sync job itself from a small hardcoded list at import time — **not editable via the Admin UI/API at all** (2.6, 2.7). A `classification_source` of `override` marks an admin's manual reclassification of an otherwise-inferred method, made through the portal.
2. **Naming-convention inference**, the default the importer assigns to anything not `locked`:
   - `.query`, `.get_instance`, `.config`, `.status`, `.choices`/`_choices`, `.info`, or verbs `list`/`get`/`search` → `read`.
   - `.create`, `.update`, `.delete`, `.set_*`, or verbs `run`/`start`/`stop`/`restart`/`install`/`upgrade`/`reboot`/`shutdown`/`wipe`/`attach`/`detach`/`export`/`remove`/`replace` → `write`.
3. **Default-deny on ambiguity** — anything matching neither pattern confidently is classified `write` (requires approval), never `read`. Fail closed.
4. The resolved classification (source: `locked`/`override`/`inferred`) is stored per method and surfaced in `search` results, so the model can see *before* attempting a call whether it will need approval — and surfaced in the Admin Portal's methods table so an admin can review/override the inferred ones.

**Enablement is a separate gate from classification.** Classification (above) decides *whether a call needs approval*; enablement decides *whether a method is reachable through `search`/`execute` at all*. Every method row also carries an `enabled` boolean, seeded automatically by the sync job from its classification at import time:

- `read`-classified methods → `enabled: true` by default. These are the routine lookups (`pool.query`, `pool.dataset.get_instance`, etc.) — safe to expose without a separate curation step.
- `write`- and `locked`-classified methods → `enabled: false` by default. A newly-synced write method (e.g. `pool.dataset.delete`, `app.upgrade`) is invisible to `search`/`execute` until an admin explicitly turns it on in the Methods page — at which point it's reachable, but still gated by the normal approval flow (3.1) exactly like any other write.

This is the mechanism behind the "start read-only" posture: at initial deployment, nothing needs to go into `pre_approval_rules` for the server to only expose reads — it already does, because no write method is enabled yet. Turning on individual write methods (`pool.dataset.create`, `app.upgrade`, …) as they're actually needed is a distinct, later decision from whether calls to those methods still require a human (that's what `pre_approval_rules`, 3.5, is for). A disabled method that's called anyway (e.g. from stale cached knowledge in a long-running sandboxed script) is rejected at call-time with a clear `MethodDisabled` error, same enforcement point as the classification gate (3.1) — never silently ignored.

The Methods page (2.6) carries this as its own toggle, independent of the classification dropdown; `locked` methods are never toggleable to enabled by anyone other than an admin explicitly opting in per-row (there's no "enable all writes" bulk action by design).

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
│  Method catalog cache    Permission gate         │
│  (+ classification)      (classify → approve     │
│                            or auto-run)          │
│                                │                 │
│                                ▼                 │
│                        TrueNAS WS client         │
│                        (holds the API key)       │
└───────────────────────────────┬─────────────────┘
                                 ▼
                  TrueNAS instance (JSON-RPC/WebSocket)
```

### 2.5 Implementation Stack (Decided)

This server is built in **Node/TypeScript on FastMCP, with `isolated-vm` as the sandbox runtime**. This is a decision, not an open question — build against this stack rather than re-evaluating alternatives (Python/subprocess, Go/goja — see prior discussion) unless a concrete blocker surfaces during implementation, in which case flag it back rather than switching silently.

- **[FastMCP](https://github.com/punkpeye/fastmcp)** (TypeScript) as the MCP server framework. It provides, out of the box: `elicit()` on the tool context / `session.requestElicitation()` for the in-session approval flow (Section 3.3), automatic session lifecycle tracking (used to trigger the debounced session-start refresh in Section 5), Zod-validated tool schemas for the two `search`/`execute` tools, and custom HTTP routes (via Hono) for the `/healthz` and `POST /admin/refresh` endpoints (Sections 5, 9) without standing up a second HTTP server. It's a thin wrapper over the official `@modelcontextprotocol/sdk` — no protocol-level compatibility risk, purely boilerplate removal.
- **`isolated-vm`** as the code sandbox for both `search` and `execute`. Runs model-authored code in a genuinely separate V8 isolate (not `vm`/`vm2`, which are not security boundaries), with only the `truenas.call` binding injected in and no ambient `require`/`fetch`/`process`/filesystem access — matches the Section 4 sandbox requirements directly.

### 2.6 Admin Portal & Configuration API (replaces config files)

**All configuration — connection credentials, method classification, pre-approval rules, and approvals — is managed through a web admin portal and its backing REST API, stored in our own SQLite database, not through YAML files.** This is a deliberate divergence from the earlier file-based design, made because we already run a frontend and a DB for this — adding config files back in would mean maintaining a second, disconnected configuration surface. The permission *model* (Sections 3–4) doesn't change: reads still auto-execute, writes still require approval or a matching pre-approval rule, destructive/typed-confirmation methods are still non-overridable. Only *where configuration lives and how it's edited* changes.

This section's UI shape borrows directly from Cloudflare's own MCP server portal (Cloudflare One → Access controls → MCP Portals), which solves an adjacent problem — curating which tools an MCP client sees and how they're authorized — with a pattern worth reusing rather than reinventing: a server/connection list with live status, a tools table with per-row toggles and edit actions, and a default-disabled-unless-curated posture for anything higher-risk. Cloudflare's own WriteGuard work (in private beta as of this writing) converges on the same idea from the write-permission angle: classify by risk tier, make the highest tier a hard, non-approvable rejection rather than a checkbox. Both inform the design below; neither is a dependency — this portal is self-hosted and stands alone.

**Why this also solves the mistyping problem directly**: every method an admin can classify or write a pre-approval rule against comes from the `methods` table (2.3), which is populated *only* by the sync job parsing `core.get_methods` against the live instance. There is no free-text method-name field anywhere in the admin UI or API — an admin picks from an auto-populated, searchable list, so a typo simply can't produce a rule that silently fails to match (or worse, matches something unintended) the way a hand-typed YAML key could.

**Pages/views** (built as Vue components — this is a functional spec, not a full component spec):

| Page | Purpose | Maps to Cloudflare portal concept |
|---|---|---|
| **Connection** | TrueNAS URL + API key entry, "Test connection" action, live status (Ready / Error / Unreachable), "Sync now" button, last-sync timestamp | Server add/edit + Ready/Error/Waiting status + "Authenticate server" |
| **Methods** | Searchable/filterable table of every synced method: name, classification (`read`/`write`/`locked`), source, **Enabled toggle** (on by default for `read`, off by default for `write`/`locked` — 2.3), last-seen. "New" badge on methods first seen in the latest sync. Classification dropdown editable per row *except* `locked` rows (disabled with a lock icon and tooltip); the Enabled toggle is a separate control on every row, including `locked` ones — locking a method prevents it ever being pre-approved or reclassified, but doesn't by itself prevent an admin from choosing to expose it (still gated by the full approval/typed-confirmation flow once enabled) | Tools panel with per-tool toggles/aliases; `default_disabled` + explicit-enable pattern |
| **Pre-Approval Rules** | List + create/edit form: method (picker, not free text), match constraints (structured fields — e.g. a path-prefix input for `pool.dataset.create`, a multi-select of installed apps for `app.upgrade` — not a regex text box where avoidable), rate limit, expiry date picker, required reason field, enabled toggle, last-triggered timestamp | Closest Cloudflare analog: allowlist pattern (`default_disabled` + `updated_tools`), generalized with match/rate-limit/expiry |
| **Pending Approvals** | Inbox of paused write calls awaiting a decision — full params, matched method, classification reason, Approve/Deny buttons. This is the **first-party alternative to an external Slack/ntfy channel** (3.3) for headless runs: the portal itself is the notification surface, and can use the existing app's own notification system (email/push/in-app) to alert an admin rather than standing up a separate integration | Logs / request history view |
| **Audit Log** | Every `search`/`execute` call: method, classification, decision (`human-approved`/`auto-approved: <rule>`/`denied`/`timed-out`), decider, timestamp. Filterable, exportable | Per-tool request logs (status, duration) |

**Admin API** (REST, backing the UI — exact routing/framework left to whichever stack we settle on):

- `GET/PUT /admin/connection` — credential is **write-only**: `PUT` accepts it, `GET` returns a masked form (`sk-…ab12`) or nothing, never the plaintext back. `POST /admin/connection/test` validates without saving.
- `POST /admin/sync` — trigger an immediate catalog sync (same operation the session-start/cron triggers from Section 5 call internally).
- `GET /admin/methods`, `PATCH /admin/methods/:id` — list/filter; `PATCH` accepts `classification_source: override` and/or `enabled: true|false` as independent fields on the same row. **Server-side rejects any attempt to change the classification of a `locked` row with a 409**, regardless of what the UI shows — the lock is enforced at the API, not just hidden in the frontend. The `enabled` field has no such restriction: even a `locked` method can be toggled enabled by an admin (2.3) — locking only protects classification and pre-approval eligibility, not visibility.
- `GET/POST/PATCH/DELETE /admin/pre-approval-rules` — CRUD. `POST`/`PATCH` **validates against the `locked` method set and rejects with a 409** if the referenced method is non-approvable, same enforcement point as classification. This replaces the file-based design's "refuse to start the server" check with an instant "refuse to save the rule" — a strictly better failure mode since it's caught at edit-time in the UI instead of at next deploy.
- `GET /admin/pending-approvals`, `POST /admin/pending-approvals/:id/approve|deny` — backs the Pending Approvals page; also what a portal-side notification link (email/push) points at.
- `GET /admin/audit-log` — filterable read of the audit trail (Section 4).

**Portal authentication** — this is a separate concern from both the TrueNAS credential and the MCP transport auth (Section 4's "bind to localhost, require bearer token if exposed"): a single basic-auth restriction (one shared credential, or a small credential we manage ourselves) gates the whole portal. No role split and no maker-checker — this is a personal, single-operator setup, so the added process of a second approver reviewing every classification/rule change isn't warranted. If that ever changes, this is the place to revisit it, but it's not part of the initial design.

**Database**: SQLite, stored as a single file alongside the server (or wherever we run the frontend from). Table shapes:

```
methods(id, name, classification, classification_source, enabled, locked, first_seen_at, last_seen_at, stale)
pre_approval_rules(id, method_id FK, match TEXT, rate_limit, window_seconds, expires_at, reason, enabled, created_by, created_at)
pre_approval_hits(id, rule_id FK, occurred_at)              -- rolling counter for rate-limit enforcement
pending_approvals(id, method_id FK, params TEXT, requested_at, status, decided_by, decided_at)
approval_log(id, method_id FK, params TEXT, classification, decision, decided_by, decided_at, source)  -- source: human | pre_approval_rule:<id> | timeout | denied
connection(id, base_url, credential_encrypted, last_synced_at, last_sync_status)
```

`match` and `params` are stored as `TEXT` columns holding JSON-encoded content (SQLite has no native JSON/JSONB column type — JSON is just text with `json_*()` helper functions available at query time if needed). `credential_encrypted` uses application-level encryption (a master key held outside the SQLite file itself — an env var or a small local secrets file, not a DB row) — the plaintext TrueNAS API key is never queryable back out through the Admin API once saved, only usable server-side by the MCP process itself.

Hard requirement, not a configurable default: **reads execute immediately; every write, update, delete, or state-changing call blocks on human approval before touching TrueNAS — unless it matches an operator-defined pre-approval rule (3.5), in which case it auto-executes and is logged as such.**

---

## 3. Permission Model: Approved Read / Required Approval for Write & Delete

### 3.1 Flow

1. Model calls `execute(code)`.
2. The sandbox's *only* path to TrueNAS is the injected `truenas.call(method, params)` binding — no raw network access. Each individual call through this binding is intercepted at call-time (not via static parsing of the submitted code beforehand — see 3.2 for why).
3. **Enablement check, first** (2.3): if the method's `enabled` flag is `false`, the binding throws a structured `MethodDisabled` error immediately — no classification lookup, no approval flow, the call never gets that far. Logged as `rejected: disabled`.
4. If enabled, look up its classification (2.3):
   - `read` → executes immediately inline, result flows back into the running sandboxed code.
   - `write`/`destructive` → check `pre_approval_rules` (3.5, 2.6) for a matching, unexpired, rate-limit-available rule.
     - **Matched** → executes immediately, logged as `auto-approved (pre-approval: <rule id>)`, no approval request created.
     - **No match** → the call is paused. An approval request is created (3.3) and the sandbox blocks on it. Default: **the whole `execute` invocation blocks on that single pending call** rather than allowing surrounding reads to race ahead, so behavior stays easy to reason about; this is configurable if a deployment wants concurrent read continuation.
5. Approved (or pre-approved) → the real call runs, execution resumes.
6. Denied or timed out → the binding throws a structured `PermissionDenied` error back into the sandboxed code (so the model's code can handle it, e.g. report back to the user) rather than silently no-op'ing; the attempt is logged either way.

`search` results are also filtered to `enabled` methods only by default, so the model doesn't see methods it can't call and doesn't waste a turn attempting one — a disabled method simply doesn't appear as a match. (An optional `includeDisabled` flag on `search` can surface them anyway, tagged `disabled`, useful for an admin-assisted session deciding what to turn on next — off by default.)

### 3.2 Why call-time interception, not static pre-analysis

`execute` runs arbitrary generated code, so classifying "the code" as a whole up front is unreliable — static AST scanning of dynamically generated JS/Python for every possible call shape is brittle and gameable. Instead:

- **Primary gate**: the sandbox's *only* egress to TrueNAS is the `truenas.call` binding. Every invocation of it, whenever it happens during execution, is checked against the classification table before it's allowed to proceed. This is robust regardless of how the surrounding code is structured.
- **Secondary, defense-in-depth**: an optional best-effort static pre-scan can still reject a submission outright if it references a method absent from the current catalog, or attempts to reach outside the sandbox (`require`, `fetch`, `import`, `process`, dynamic `eval` of further strings). Treat this as an early cheap reject, not the security boundary — the call-time gate is the actual boundary.

### 3.3 Approval mechanism

- Each pending write/destructive call generates an approval request containing: method name, full params, classification source/reason, and a human-readable summary (e.g. "This will permanently delete dataset `tank/media/archive` and all its snapshots").
- **Primary delivery: MCP elicitation.** The server sends an `elicitation/create` request back over the live MCP connection; the connected client (the agent) presents it to the person in-session and relays their decision back. This requires no external service, webhook, or extra credential — it's a standard MCP protocol capability, and it's how Cloudflare's own Code Mode / human-in-the-loop implementation surfaces destructive-action approvals. Use this whenever a live MCP session with a human on the other end is active.
- **Fallback delivery: notification channel (headless/unattended runs only).** If `execute` is invoked with no live session to elicit against — e.g. a scheduled job or an unattended agent run — the server instead needs an external notification path (Slack webhook, ntfy, email) carrying an approve/deny link back to its approval endpoint. This path is only needed if the deployment intends to run unattended; if all usage is interactive, elicitation alone is sufficient and this can be left unconfigured.
- Detect which path applies per-call: if the MCP session supports elicitation (per client capability negotiation at connection time) and is currently connected, use it; otherwise fall back to the configured notification channel if one exists; if neither is available, auto-deny immediately and log "no approval path available" rather than leaving the call hanging.
- **Default timeout**: 15 minutes, configurable (applies to both paths — a session that goes idle mid-elicitation should still time out rather than block forever). An unanswered request is **auto-denied**, never auto-allowed, and logged.
- Approvals are **single-use, scoped to the exact params presented** — approving "delete dataset X" never pre-authorizes a different call, even a similar one, later in the same session.
- Persist to the `pending_approvals` and `approval_log` tables (2.6) — the same DB the Admin Portal reads for its Pending Approvals and Audit Log pages: timestamp, method, params, requester/session context, decision, decider identity, decision timestamp.

### 3.4 Extra confirmation for irreversible / high-blast-radius methods

A subset of `write`-classified methods require a **typed confirmation** on top of the normal approval flow, because a single click is too easy to fat-finger: `disk.wipe`, `pool.export`, `pool.destroy`-equivalents, `system.reboot`, `system.shutdown`, `config.reset`, `user.delete` (admin accounts), `filesystem.setacl`/`chown` at pool-root paths. The approval prompt must include the literal target name and require it be echoed back before proceeding — mirrors TrueNAS's own UI pattern for these operations. These are the methods seeded as `locked` in the `methods` table (2.3, 2.6) — set once by the sync job's hardcoded list, not editable through the Admin UI/API at all.

### 3.5 Pre-Approved Actions (Operator-Configured Auto-Allow)

The default is still "every write needs a human." Pre-approval is an explicit, narrow opt-in that lets an operator mark *specific* write operations as safe to run without a live approval — e.g. "routine dataset creation under `tank/media/*`" or "app upgrades for already-installed apps." This is what makes fully unattended automation practical without wiring up an external notification channel (3.3) for every write the automation might make — but only for the writes actually covered by a rule; anything outside the rule set still falls back to needing approval (3.3), and in a headless context with no other approval surface configured, that still means auto-deny (fail closed, per the existing default) — though note the Admin Portal's own Pending Approvals inbox (2.6) is itself an approval surface, so "headless" here specifically means "no admin checking the portal either," a narrower case than before.

**Config**: managed entirely through the **Pre-Approval Rules page and `/admin/pre-approval-rules` API** (2.6) — no YAML file. Every rule references a `method_id` selected from the synced `methods` table, never a typed string.

**Rule shape**, per entry (form fields on the Pre-Approval Rules page):
- `method` — picked from the synced methods list (e.g. `app.upgrade`, `pool.dataset.create`) — not free text.
- `match` (optional but recommended) — a structured constraint on the call's params, so "allow dataset creation" doesn't silently mean "allow dataset creation anywhere." E.g. a path-prefix field on the dataset name (`tank/media/`), or a multi-select of allowed app names for `app.upgrade`. A rule with no `match` applies to any params — use sparingly, only for genuinely low-risk methods.
- `rate_limit` (optional, recommended) — max executions per time window (e.g. `10/hour`). Bounds the blast radius of a bug or a runaway loop even for a pre-approved rule. Enforced via the `pre_approval_hits` rolling-counter table (2.6). Once a rule's limit is hit, further matching calls fall back to the **normal approval flow** for the rest of the window — degrading to "needs a human," never silently blocked and never silently exceeding the limit.
- `expires_at` (optional) — date picker; TTL after which the rule stops matching and reverts to requiring approval. Useful for time-boxed automation windows (e.g. "auto-approve during this weekend's planned migration only").
- `reason` (required form field, not a convention) — one-line human justification, enforced by the API schema rather than by code-review convention on a YAML comment.

**Hard boundary — cannot be bypassed via the UI or API**: any method seeded `locked` (3.4, 2.3.1) can **never** be referenced by a pre-approval rule. `POST`/`PATCH /admin/pre-approval-rules` validates this server-side and rejects with a 409 if the selected method is locked — the picker itself should also simply not offer locked methods as selectable, but the API enforces it independent of what the frontend shows. This replaces the file-based design's "refuse to start the server" check with an instant "refuse to save the rule," which is a strictly better failure mode — caught in the UI at edit time, not discovered at next deploy.

**Audit trail**: a pre-approved execution is logged exactly like every other call (Section 4's audit log), tagged `auto-approved (pre-approval: <rule id>)` rather than `human-approved` — visible in the Admin Portal's Audit Log page, so reviewing it always shows *why* something ran without a live decision, and which rule authorized it, with a click-through to that rule's edit history.

**Example rules** (illustrative — what an operator would enter into the Pre-Approval Rules form, not a default/seeded configuration):

| Method | Match | Rate limit | Reason |
|---|---|---|---|
| `pool.dataset.create` | name prefix: `tank/media/` | 20/hour | Routine media-library dataset provisioning; scoped below pool root, quotas apply. |
| `app.upgrade` | app in: `plex`, `sonarr`, `radarr` | 5/day | Allow unattended upgrades for the media stack only; other apps still require approval. |

---

## 4. Security

- **Sandbox**: model-authored code runs in an isolated context (`isolated-vm` for Node, or a locked-down subprocess with no filesystem/network access besides the injected binding) — never `eval`/`vm.runInContext` in the main process, never a shared long-lived interpreter reused across requests.
- **No credentials inside the sandbox**: the sandbox only ever sees the bound `truenas.call` function — never the API key, WS URL, or any other secret. Credentials live only in the outer server process.
- **TrueNAS API key scope**: `FULL_ADMIN` is the accepted operating assumption for this deployment (a deliberate call, not a default to avoid) — the server does not attempt to run with a narrower TrueNAS RBAC role by design, but it also doesn't *require* `FULL_ADMIN` specifically: every `truenas.call` is wrapped so a permission-denied response from TrueNAS (whatever role is actually attached to the configured key) surfaces as a clean, structured error back through `execute` — logged, and returned to the model as "TrueNAS denied this call: insufficient permission," never a crash or a silent no-op. If the key is ever swapped for a narrower role later, the server keeps working for whatever that role can reach and degrades gracefully on the rest.
- **Resource limits**: hard timeout (default 10s) and memory cap per `search`/`execute` call; kill and error on breach.
- **Rate limiting**: cap `execute` calls per minute, especially write-classified ones, to blunt a runaway-loop scenario.
- **Audit log**: every `search` and `execute` call — including denied/timed-out approvals — logged with method(s), params (secrets redacted), classification, decision, and result status. Append-only in the `approval_log` table (2.6), never exposed back to the model, readable by operators only via the Admin Portal's Audit Log page (or directly against the DB) — never editable or deletable through the Admin API.
- **Redaction**: any field matching a documented sensitive-field list (`apiKey`, `password`, `passphrase`, `token`, `bindpw`, private keys) is redacted before being returned to the model or written to logs — including on reads (e.g. `sharing.smb.query` can surface stored credentials depending on config) — and before being rendered anywhere in the Admin Portal UI, including the Audit Log and Pending Approvals pages.
- **No runtime privilege escalation**: `methods.classification`, `methods.enabled`, and `pre_approval_rules` are only editable through the Admin Portal/API, behind the portal's basic-auth restriction — never by the running MCP server process itself, and never by model-generated code. There is no MCP tool that writes to any of the three; the sandbox has no DB access at all, only the `truenas.call` binding, so sandboxed code can never enable a method for itself.
- **Pre-approval cannot widen past the hard boundary**: `locked` methods (3.4, 2.3.1) are non-referenceable by any `pre_approval_rules` row — enforced at the Admin API layer (409 on violation), independent of and in addition to whatever the frontend UI happens to show.
- **Credential storage**: the TrueNAS API key is stored application-level-encrypted in the `connection` table (2.6), decryptable only by the MCP server process with its own master key/KMS access — the Admin API never returns it in plaintext once saved, including to Admin-role users; re-entry is required to rotate it, not "reveal then re-save."
- **Portal auth is a separate boundary from MCP transport auth**: compromising the portal's basic-auth credential lets someone reclassify methods and write pre-approval rules (bounded by the `locked` floor above); compromising the MCP transport lets someone *call* the exposed `search`/`execute` tools. Both need independent protection — the portal's basic-auth restriction (2.6) should not be treated as also covering the MCP endpoint's own auth.
- **Network exposure**: bind to localhost or an internal network by default. If exposed further, require TLS and MCP-transport auth (bearer token/API key) in front of it — don't rely on TrueNAS's own auth, or the portal's auth, as the only gate for the MCP endpoint itself.
- **Admin API hardening**: standard web-app protections apply since this is now a real HTTP admin surface — CSRF protection on all state-changing routes, session/JWT expiry, rate limiting on the login and `/admin/connection/test` routes specifically (avoid becoming a credential-testing oracle against the TrueNAS instance).

---

## 5. Maintenance & Auto-Update

- **Catalog refresh — primary trigger: session start (debounced).** On every new MCP session/connection, check the last sync timestamp on the `connection` row (2.6); if older than a short threshold (default 1h, configurable), refresh via `core.get_methods`/`core.get_services` and upsert into `methods` before serving the session's first `search`/`execute`. The debounce window prevents a thundering herd when several sessions start at once (concurrent session starts within the window share the same last-sync state; only the first triggers a fetch, guarded by a simple lock — a DB advisory lock or equivalent, since this may now run across multiple server instances sharing one DB). This keeps the catalog "fresh as of when someone's actually using it" rather than fresh on a blind clock, and pairs with the version check below for the case that matters most (an actual TrueNAS upgrade).
- **Version-triggered refresh (also runs at session start)**: the `connection` row records the TrueNAS `system.version` the last sync was captured against. At each session start, cheaply compare it against the live instance's current version regardless of sync age; on any mismatch, force an immediate refresh — this is what catches an actual TrueNAS upgrade without waiting on the debounce window.
- **Catalog refresh — backstop: low-frequency cron.** A scheduled job (in-container cron or external scheduler) also calls the same refresh on a long interval (default: daily) and on manual trigger (`POST /admin/sync`, same endpoint the portal's "Sync now" button calls), purely as a safety net for stretches with no session starts at all (e.g. a mostly-headless deployment, or a long quiet period) — session-start refresh alone would otherwise let the catalog go fully stale when nobody connects.
- **Mid-session staleness**: a session that stays open for a long time (hours) will not pick up a mid-session TrueNAS upgrade from the session-start trigger alone, since that check only runs once at connection time. Re-run the cheap version comparison on a lightweight interval within long-lived sessions too (e.g. every 30 min) if the deployment expects long sessions; otherwise document this as a known limitation.
- **Classification drift**: a newly discovered method is inserted into `methods` with `classification_source: inferred` (2.3) and `first_seen_at` set to now — the Admin Portal's Methods page surfaces this as a "New" badge for operator review. New methods are never silently exempt from the gate — ambiguous inference defaults to `write` (2.3.3), and a method absent from the latest sync is marked `stale` rather than deleted, preserving any classification/pre-approval history against it.
- **Dependency hygiene**: pin dependencies; run CI against a test/staging TrueNAS instance before deploying; enable Dependabot/Renovate specifically for the sandbox runtime and MCP SDK (the security-critical path).
- **Health check**: `/healthz` reports last sync age, last successful TrueNAS connection, pending-approval count, sandbox runtime status, DB connectivity.

---

## 6. Documentation

- **README.md**: setup (TrueNAS API key creation + required RBAC role, DB schema migration, setting the portal's basic-auth credential), how search/execute works, how to answer a pending approval (both via MCP elicitation and via the Admin Portal's Pending Approvals page), how pre-approval rules work and their hard limits (3.5), connection troubleshooting.
- **In-portal help text** replaces the old heavily-commented YAML files: the Methods page explains `locked` vs `override` vs `inferred` inline; the Pre-Approval Rules form explains `match`/`rate_limit`/`expires_at` inline, and the `reason` field is enforced by the API schema rather than by a comment convention. No YAML file to comment.
- **On-demand method docs inside `search` results**: the old 52-tool design's wizard guidance (dataset creation options, SMB share purposes, app install schema groups) is not baked into a static schema anymore — it must be retrievable through `search`. Populate a lightweight local docs layer (can be sourced/summarized from TrueNAS's own generated API docs) so `search` can return not just "method + params" but the guidance a human admin would want for the genuinely wizard-shaped operations (dataset/app/share/directory-service creation). This preserves the old design's real value without its fixed per-session token cost.
- **Change history**: since classification/pre-approval changes now happen through the portal rather than as git diffs on a YAML file, the `approval_log`/rule-edit history in the DB (2.6) *is* the changelog — the Admin Portal should let an operator filter the Audit Log specifically to configuration changes (method reclassifications, rule create/edit/delete), not just tool-call approvals, so this security-relevant history stays reviewable without needing git.
- **Runbook** (`docs/runbook.md`): what to do when TrueNAS is unreachable, an approval is stuck pending, the sandbox is killing calls on timeout, a new TrueNAS version removes/renames a method an operator relies on, or the Admin Portal's DB is unreachable (should the MCP server keep serving reads with the last-synced classification, or refuse — recommend the former, fail open on *reads* of the classification table while still failing closed on any write it can't classify with confidence).

---

## 7. Development Phase (TDD)

Built test-first, in the phases below, in order. Each phase's tests are written before that phase's implementation and must pass — along with every earlier phase's tests, run as regression — before moving to the next. A phase is never "made to pass" by loosening its own test; if a test turns out wrong, that's a deliberate, called-out change to the test, not a quiet weakening.

This order follows the dependency chain already laid out in 2.4 and 3.1 — each phase is the smallest testable unit that the next phase builds on, so the security-critical logic (classification, enablement, approval) is proven correct in isolation, with mocks, well before it's wired to a real TrueNAS instance, a real sandbox, or a real UI.

1. **Classification engine (2.3)** — pure functions, no network/DB/sandbox involved. Tests first: naming-convention inference maps known read/write verb patterns correctly; anything matching neither pattern defaults to `write`, never `read`; a `locked` classification always wins regardless of naming; `override` wins over inferred but never over `locked`. Implement only enough to pass.
2. **Enablement gate** — tests first: a freshly-classified `read` method defaults `enabled: true`; `write`/`locked` default `enabled: false`; a call to a disabled method is rejected (`MethodDisabled`) before classification is even consulted. Implement.
3. **Method catalog sync (2.2)** — tests against a mocked `core.get_methods`/`core.get_services` response: correct upsert into `methods`, `stale` marking for methods absent from a sync, refuse-to-start when there's no prior sync *and* no live connection. Implement against a fake TrueNAS client; the real WebSocket client is wired in a later phase.
4. **Sandbox binding (2.5, 4)** — tests first: sandboxed code's only egress is the injected `truenas.call` binding; attempts to reach `require`/`fetch`/`process`/filesystem are contained; a `PermissionDenied`/`MethodDisabled` thrown by the binding propagates back into the sandboxed code as a catchable error, not a crash. Implement the `isolated-vm` wiring.
5. **Approval flow (3.1, 3.3)** — tests first against a fake elicitation transport (no real MCP client needed yet): a `read` call auto-executes; a `write` call with no matching pre-approval rule pauses and creates a pending approval; approve/deny branch correctly; an unanswered request auto-denies on timeout; an approval is single-use and scoped to its exact params. Implement.
6. **Pre-approval rules (3.5)** — tests first: a matching, unexpired, rate-limit-available rule auto-executes and logs `auto-approved`; a rule at its `rate_limit` falls back to the normal approval flow for the rest of the window; an expired rule is treated as no rule; a `locked` method can never be referenced by a rule (rejected, not silently ignored). Implement.
7. **Admin API (2.6)** — contract tests first, one per endpoint: `GET /admin/connection` never returns the plaintext credential; `PATCH /admin/methods/:id` rejects a classification change on a `locked` row with 409 but accepts an `enabled` toggle on one; `POST/PATCH /admin/pre-approval-rules` rejects a `locked` method with 409; any admin route returns 401 without the basic-auth credential. Implement the REST layer against the same SQLite schema the earlier phases already exercise.
8. **Admin Portal UI (Vue, 2.6)** — component/interaction tests (e.g. Vitest + Testing Library) for each page in 2.6's table, written against the Admin API's contract (mocked per phase 7's tests) before wiring the real API client: the Methods page's Enabled toggle and classification dropdown act independently; a `locked` row's classification control is disabled while its Enabled toggle isn't; the Pre-Approval Rules form won't let a `locked` method be picked; the Pending Approvals page's Approve/Deny buttons call the right endpoints.
9. **`search`/`execute` MCP tools (2.1)** — integration tests: `search` returns only `enabled` methods by default and includes disabled ones, tagged, when asked; `execute` runs the full call-time flow (enablement → classification → approval-or-pre-approval) end-to-end against the fake elicitation transport and the fake TrueNAS client from earlier phases.
10. **Maintenance jobs (5)** — tests first, against a mocked clock/scheduler: session-start debounce and its lock behave correctly under concurrent session starts; a `system.version` mismatch forces an immediate refresh regardless of debounce; the cron backstop fires on its own schedule; mid-session staleness re-checks happen on the configured interval.

Only after all of the above pass against mocks does a real/staging TrueNAS instance enter the picture, for the integration tests in Section 9 — that pass is confirmation the mocked contracts matched reality, not where a bug is found for the first time. CI blocks merging any change that leaves a phase's tests red, and coverage is checked specifically on the classification/enablement/approval-flow code (the security-critical path, 2.3–3.5) rather than as one aggregate percentage that a well-tested UI could quietly carry.

---

## 8. Deployment

- Single container for the MCP server itself (Docker); the Admin Portal (UI + Admin API) can run as a module within the Vue frontend, or as its own small service — either way, it reads/writes the same SQLite file rather than standing up a separate DB instance.
- The MCP server process needs read access to `methods`/`pre_approval_rules`/`connection` (decrypting the credential) and write access to `pending_approvals`/`approval_log`/`pre_approval_hits`. The Admin Portal needs full read/write on all of it, gated by its own basic-auth restriction (2.6). SQLite doesn't support per-role DB credentials the way a server-based engine would, so this separation is enforced at the process/API level (only the Admin API writes to `methods`/`pre_approval_rules`; only the MCP server writes to `pending_approvals`/`approval_log`/`pre_approval_hits`) rather than via DB-level roles.
- Intentionally light footprint despite the added DB dependency: no message queue required for v1; the "external notification channel" question from Section 3.3/10 is now substantially narrower, since the Admin Portal's own Pending Approvals page is a first-party fallback that needs no new infrastructure.

---

## 9. Testing

- Unit tests for the classification engine: given a method name/list, verify correct read/write/destructive output, and that `locked` always beats `override` always beats `inferred`.
- Integration test against a real or staging TrueNAS instance: confirm sync via `core.get_methods` upserts `methods` correctly; confirm a read call (`pool.query`) executes with no approval; confirm a write call (`pool.dataset.delete` on a disposable test dataset) blocks pending approval and correctly branches on approve/deny (both via elicitation and via the Admin Portal's approve/deny endpoint).
- Sandbox-escape tests: attempt `require`, `fetch`, `process.env` access, prototype pollution, and infinite loops from submitted code; confirm all are contained or killed.
- Approval-timeout test: confirm default-deny on timeout, never default-allow.
- **Pre-approval tests**: a matching rule auto-executes with no approval request created and is logged as `auto-approved`; a non-matching call (wrong method, or params outside `match`) falls through to the normal approval flow; a rule at its `rate_limit` correctly falls back to requiring approval for the rest of the window rather than blocking outright or exceeding the limit; an expired rule (`expires_at` in the past) is treated as no rule at all.
- **Enablement tests**: a freshly-synced `read` method has `enabled: true`; a freshly-synced `write` or `locked` method has `enabled: false`; a call to a disabled method throws `MethodDisabled` before classification is even consulted, and is logged as `rejected: disabled`; toggling a method enabled through the Admin API makes it immediately callable (and immediately shows up in `search` results) without a restart; `search` excludes disabled methods by default and includes them, tagged, when `includeDisabled` is passed.
- **Admin API tests**: `PATCH /admin/methods/:id` and `POST/PATCH /admin/pre-approval-rules` both reject (409) any attempt to touch classification on a `locked` method, but accept an `enabled` toggle on one; any admin route without the basic-auth credential returns 401; `GET /admin/connection` never returns the plaintext credential; CSRF protection is verified on all state-changing admin routes.

---

## 10. Open Decisions — Claude Code Should Ask, Not Assume

Implementation stack (Node/TS + FastMCP + `isolated-vm`) is **decided** — see 2.5. Configuration now lives in our own SQLite database behind an Admin Portal (2.6), not config files — also decided. Portal auth is a single basic-auth restriction, no RBAC — also decided. The portal's frontend is **Vue** — also decided; build the Pages/views in 2.6 as Vue components rather than asking again. The basic-auth credential is **provisioned via environment variables** (read at process startup, compared against the request's `Authorization` header — never stored in the SQLite DB itself) — also decided. Remaining open items:

- **Notification channel for approvals — deferred.** Not part of v1: the Admin Portal's own Pending Approvals page (2.6) plus MCP elicitation (3.3) are the whole approval surface for now. An external channel (Slack/webhook/ntfy/email) is left as a future iteration if unattended runs later need a push notification beyond checking the portal — the approval mechanism (3.3) is already written so adding a channel later is additive, not a redesign.
- `FULL_ADMIN` is **decided** (Section 4) — the server is built to work with whatever TrueNAS permission the configured key actually has, granted as `FULL_ADMIN` for now, and to fail gracefully (structured error, not a crash) on any call the key isn't permitted to make.
- **Initial deployment posture is decided as read-only, enforced via the `enabled` toggle (2.3), not via `pre_approval_rules`.** Every method starts with `enabled: true` if `read`-classified and `enabled: false` if `write`/`locked` — set automatically by the sync job, not something to seed by hand. So at initial deployment `search`/`execute` only ever surface reads; no write method is reachable at all until an admin turns it on in the Methods page, one at a time. `pre_approval_rules` stays a fully separate, later decision — it controls whether an *enabled* write still needs a live approval or can auto-run, and ships empty regardless (every enabled write requires approval until a rule says otherwise).
