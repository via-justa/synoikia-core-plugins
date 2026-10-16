# Grafana runbook

The plugin is tested against a fake Grafana. This checklist confirms it against a real instance before a release. It takes about 15 minutes.

**Before you start:** a Grafana 12 test instance (or a Cloud test stack) with a Prometheus data source, one dashboard in a folder and one contact point. Add a service account with the Admin role and a token.

1. **Connect.** New endpoint → **Grafana**, base URL and token. **Test connection** reports the version (e.g. `12.4.13`). A wrong token fails the test. Against a Grafana 11 instance the test fails with "needs Grafana 12 or later".
2. **Sync.** About 310 operations appear, grouped by tag (`dashboards`, `datasources`, `provisioning`, …). No `/datasources/proxy/…`, `/saml/…` or `/public/dashboards/…` operation is listed.
3. **Reads.** With `search`, `dashboards` and `datasources` at Read, ask for a dashboard by title: `GET /search`, `GET /dashboards/uid/{uid}`, no prompt. `GET /datasources` shows `url` but no secret values. A Prometheus query (`POST /ds/query`) is refused at Read; at Ask its prompt names the data source with its type and URL.
4. **A write.** With `annotations` at Ask, add an annotation: a prompt shows `POST /annotations` with the text; approve, and it appears on the dashboard.
5. **Locks.** Change the test data source's URL with `PUT /datasources/uid/{uid}`: the prompt shows the stored name, type and URL and the new URL, and asks to type the data source name. A wrong value is refused. Create a service account token (`POST /serviceaccounts/{id}/tokens`, type the account name): the result shows `key` as `[REDACTED]`. Delete the token afterwards (locked, account name).
6. **Destinations.** Update the contact point with `PUT /v1/provisioning/contact-points/{UID}`: the prompt shows `settings.url` as `[REDACTED]` and only its host as the target, other settings (recipients, addresses) in full, and asks for the contact point name. `GET /v1/provisioning/contact-points` shows `url` as `[REDACTED]`.
7. **Audit.** The audit log lists each call; the token from step 5 and any secure setting from step 6 appear nowhere.
