# Backstage runbook

The plugin is tested against a fake Backstage. This checklist confirms it against a real backend before a release. It takes about 15 minutes.

**Before you start:** a Backstage test instance (an app from `npx @backstage/create-app` is fine) with the catalog's example entities and templates, and this in `app-config.local.yaml`:

```yaml
backend:
  auth:
    externalAccess:
      - type: static
        options:
          token: ${SYNOIKIA_BACKSTAGE_TOKEN}
          subject: synoikia
```

Generate the token with `node -p 'require("crypto").randomBytes(24).toString("base64")'` and restart the backend.

1. **Connect.** New endpoint → **Backstage**, the backend URL (e.g. `http://localhost:7007`) and the token. **Test connection** reports version `1`. A wrong token fails the test.
2. **Sync.** 41 operations appear, grouped as `entity`, `locations`, `scaffolder`, `search`, `notifications` and `events`. Untick `events` in the connection's plugins and sync again: its operations go. If the app has no notifications or events backend, the sync still succeeds without them.
3. **Reads.** With `entity` at Read, list components: `GET /api/catalog/entities/by-query` with `filter=kind=component`, no prompt; page with `limit=1` and `cursor`.
4. **Template authoring.** With `scaffolder` and `entity` at Read: `GET /api/scaffolder/v2/actions` and `POST /api/catalog/validate-entity` on a small template, no prompt. `POST /api/scaffolder/v2/dry-run` is refused at Read; with `scaffolder` at Ask it prompts, with `secrets` as `[REDACTED]`. The dry-run log says which steps were skipped.
5. **Locks.** `POST /api/scaffolder/v2/tasks` for an example template shows `templateRef`, the values and the template's title, with `secrets` as `[REDACTED]`, and asks to type the `templateRef`; a wrong value is refused. Then `POST /api/scaffolder/v2/tasks/{taskId}/cancel` asks for the template's name. Register a location (`POST /api/catalog/locations`): the prompt leads with the target URL and asks to type it; delete it with `DELETE /api/catalog/locations/{id}`, typing its target. Check that entity delete, notification send and event publish are locked on the Access page (don't run them).
6. **Secrets.** `GET /api/scaffolder/v2/tasks/{taskId}` for the run from step 5 shows no `secrets` value.
7. **Audit.** The audit log lists each call; the secrets from step 5 appear nowhere.
