# Grafana Cloud runbook

The plugin is tested against a fake grafana.com. This checklist confirms it against the real API before a release. It takes about 15 minutes.

**Before you start:** a Grafana Cloud org with a free test stack you can change (not production). Create a Cloud access policy in the org realm with `orgs:read`, `stacks:read`, `stacks:write`, `stack-plugins:read`, `stack-plugins:write`, `stack-plugins:delete`, `accesspolicies:read`, `accesspolicies:write` and `accesspolicies:delete`, and a token for it.

1. **Connect.** New endpoint → **Grafana Cloud**, org slug and token. **Test connection** reports `public`. A wrong token, or another org's slug, fails the test.
2. **Sync.** About 54 operations appear, grouped `instances`, `stacks`, `orgs`, `accesspolicies`, `tokens`, `stack-regions`, `plugins`. The source is `grafana.com`. With grafana.com blocked (e.g. a firewall rule), a sync still succeeds from `raw.githubusercontent.com`.
3. **Reads.** With `orgs` and `instances` at Read, ask for the org's stacks and their URLs: `GET /orgs/{orgSlug}/instances`, no prompt; `machineLearningLogsToken` shows `[REDACTED]`. Ask for the plugins on the test stack (`GET /instances/{instanceId}/plugins`) and the regions (`GET /stack-regions`).
4. **Plugin install.** Install a small panel plugin on the test stack: the prompt shows `plugin=` and `version=` first, the note on third-party code, the stack slug, URL and region, and asks to type the stack slug. A wrong value is refused. Uninstall it (locked, stack slug).
5. **Access policy and token.** Create a read-only policy for the test stack (`POST /v1/accesspolicies` with `region`): the prompt shows `realms=` and `scopes=` first and asks for the policy name. Create a token for it: the prompt names the policy with its scopes and realms, and asks for the policy name; the result shows `token` as `[REDACTED]`. Delete the token and the policy (locked, their names).
6. **Stack delete prompt.** Start `DELETE /instances/{instanceId}` on the test stack: the prompt says the deletion cannot be undone and asks for the stack slug. Deny it.
7. **Audit.** The audit log lists each call; the token from step 5 appears nowhere.
