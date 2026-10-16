# Nginx Proxy Manager plugin: design

Nginx Proxy Manager (https://github.com/NginxProxyManager/nginx-proxy-manager) is a web UI over nginx for reverse proxy hosts, redirections, 404 hosts, TCP/UDP streams, Let's Encrypt certificates and basic-auth access lists. This plugin exposes its REST API through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

Every instance serves its compiled OpenAPI 3.1 spec at `GET /api/schema` without authentication (`backend/routes/schema.js`, which dereferences `backend/schema/swagger.json` and rewrites `servers[0].url` to `<origin>/api`). The plugin fetches it on every sync, so the catalog matches the installed version and `network.hosts` is only the instance. The version comes from the public health check `GET /api/` (`version.major.minor.revision`).

Operation keys are the spec's paths, relative to `/api` (`GET /nginx/proxy-hosts/{hostID}`); the model may include the `/api` prefix, which the binding drops. A spec with fewer than 50 operations, or one missing any operation `plugin.yaml` locks by exact key (`src/locked-keys.ts`), is refused.

Tests use a spec pinned from v2.16.0 (`plugins/npm/test/fixtures/npm-openapi.json`): the tagged `backend/schema/` compiled with `@apidevtools/json-schema-ref-parser` `dereference`, as `getCompiledSchema` does, with response bodies trimmed. Paths, parameters and request bodies are as served.

## Auth

Email and password of a dedicated NPM user. The plugin signs in with `POST /api/tokens` (`{ identity, secret }`), sends the JWT as `Authorization: Bearer`, signs in again five minutes before `expires` and once on a 401/403 (`HttpJsonClient` `before`/`onAuthFailure`). A user with two-factor authentication gets a challenge instead of a token, which the plugin reports as denied: the connection needs a user without 2FA. NPM's permissions apply: a user limited to `view` on proxy hosts gets 403 from writes, which core reports as `UPSTREAM_DENIED`.

## Classification

GET reads, every other verb writes, and anything the rules don't settle stays a write. No GET is flagged for review.

Excluded: sign-in and token refresh (`/tokens`, `/tokens/2fa`), the spec itself, `POST /users/{userID}/login` (impersonation: it returns another user's token), the certificate zip download, and the multipart certificate upload and validation, which carry private keys and certificate files.

## Locks

Each is locked with a typed confirmation. The literal is what the operation affects, looked up from the stored object where one exists:

| Operations                                                                               | Why                                                                                          | Literal                                                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Proxy, redirection and stream hosts: create, update                                      | They decide where a domain's or port's traffic goes (forward host and port, redirect target) | first domain (body on create, stored on update), or the incoming port                          |
| 404 hosts: create, update with `advanced_config` (split twin `#advanced`)                | Raw nginx config runs as part of the server block                                            | first domain (body on create, stored on update)                                                |
| Disable any host or stream; enable a proxy, redirection or stream host | Takes a live site down, or re-exposes one an admin turned off | stored first domain, or incoming port                                                          |
| Every `DELETE`, and user and settings writes (rules `DELETE *`, `POST /users/*`, `PUT /users/*`, `PUT /settings/*`, so ones a newer version adds are locked too)              | Irreversible                                                                                 | stored domain, port, certificate `nice_name`, access-list name or user email; else the path id |
| `PUT /nginx/access-lists/{listID}`                                                       | Emptying its users or clients opens every host behind it                                     | stored name                                                                                    |
| Users: create, update, delete, `…/auth` (password), `…/permissions`, every 2FA operation | Accounts, admin rights and credentials                                                       | stored email; the body email on create                                                         |
| `PUT /settings/{settingID}`                                                              | The default site can redirect all unknown hosts anywhere, or serve custom HTML               | the setting id                                                                                 |

Proxy and redirection host creates are locked rather than split on `advanced_config`: any create can point a domain at an attacker-chosen upstream. For every host or stream write the plugin appends the destinations it reads from the body to the approval summary (`[domains …; → http://host:port; location /x → …]`), so they stay visible even when the body is cut at 400 characters. Model-written strings there are shown as escaped JSON text (newlines, quotes, bidi and zero-width characters escaped), so they cannot fake summary text. Any host body with `advanced_config`, at the top level or in a custom location, adds `(injects raw nginx config)`. Literals never come from a body field the model writes about an existing object. Renewing a certificate, enabling a 404 host, and creating certificates, access lists and plain 404 hosts are ordinary writes.

## Secrets

- Manifest `sensitiveKeys`: `password`, `secret`, `token`, `challenge_token`, `dns_provider_credentials` (DNS-provider API tokens in certificate `meta`), `certificate_key` (custom certificates' private keys), `backup_codes` and `otpauth_url` (2FA).
- `sensitiveResult` (deep) on every `/nginx/*`, audit-log and report result: `dns_provider_credentials`, `certificate_key`, `password` (access-list basic-auth users). NPM already omits DNS credentials and masks access-list passwords; this holds if a version stops doing so. `secret`/`otpauth_url` on 2FA setup, `backup_codes` on 2FA enable and regeneration.
- `sensitiveParams`: certificate `meta.dns_provider_credentials` and `meta.certificate_key`, the user `auth.secret` on create, `secret`/`current` on a password change, 2FA `code` (body or query). Access-list `items[].password` is hidden by core's `password` key rule. Domain names, forward hosts and redirect targets stay visible: they are the destinations an approver must see.
