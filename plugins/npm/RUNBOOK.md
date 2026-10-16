# Nginx Proxy Manager runbook

The plugin is tested against a fake Nginx Proxy Manager. This checklist confirms it against a real instance before a release. It takes about 15 minutes.

**Before you start:** create a dedicated NPM user without 2FA, make it an administrator (for steps 6–7), and have a throwaway domain that resolves to the instance, plus a throwaway second user.

1. **Connect.** New endpoint → **Nginx Proxy Manager**, base URL (`http://<host>:81`), email and password. **Test connection** reports the version (e.g. `2.16.0`). A wrong password fails the test; so does a user with 2FA on, with a message saying so.
2. **Sync.** About 64 operations appear, grouped by the API tags (`proxy-hosts`, `certificates`, …). `POST /tokens`, `GET /schema`, `POST /users/{userID}/login` and the certificate download/upload are absent.
3. **Reads.** With `proxy-hosts` at Read, ask the client to list hosts with their certificates: expect `GET /nginx/proxy-hosts` with `expand: "certificate"`, no prompt, and no `dns_provider_credentials` or private key in the result.
4. **A locked create.** Add a proxy host for the throwaway domain: the approval shows the domain and `→ http://host:port`, and asks to type the domain. Approve, and the host works in NPM.
5. **A write.** With `certificates` at Ask, renew a certificate: an ordinary prompt, no typed literal.
6. **Split.** Create a 404 host without `advanced_config` (ordinary write), then update it with `advanced_config: "return 404;"`: the approval says `(injects raw nginx config)` and asks for the domain.
7. **Locks.** Delete the throwaway user with `DELETE /users/{userID}`: the approval asks to type its email, a wrong value is refused, the right one deletes it. Delete the throwaway proxy host the same way (its domain).
8. **Session.** Leave the endpoint idle past the token expiry (or restart NPM, which rotates its signing key) and run a read: it signs in again and succeeds.
9. **Denied.** With a user that has `hidden` for proxy hosts, `GET /nginx/proxy-hosts` returns an empty list or `UPSTREAM_DENIED`, and a write reports `UPSTREAM_DENIED`.
10. **Audit.** The audit log lists each call; the connection password, the JWT and any DNS credentials appear nowhere.
