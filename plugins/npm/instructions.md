# Nginx Proxy Manager

Operation keys are `<VERB> <path>` relative to `/api`, as in `GET /nginx/proxy-hosts/{hostID}`. Hosts, streams, certificates and access lists live under `/nginx/`; users and settings at the top. IDs are numbers from the list calls. Lists return plain arrays with no paging; `expand` adds related objects (`expand: "certificate,access_list,owner"`).

Workflows:

- Add a proxy host with a Let's Encrypt certificate: `POST /nginx/proxy-hosts` with `{ domain_names, forward_scheme, forward_host, forward_port, certificate_id: "new", ssl_forced: true }`; NPM requests the certificate.
- Hosts and their certificates: `GET /nginx/proxy-hosts` with `expand: "certificate"`; `GET /nginx/certificates` lists them all with `expires_on`.
- Renew a certificate: `GET /nginx/certificates` → `POST /nginx/certificates/{certID}/renew`.
- Add an access list: `POST /nginx/access-lists` with `{ name, satisfy_any, items: [{ username, password }], clients: [{ address, directive: "allow" }] }` → `PUT /nginx/proxy-hosts/{hostID}` with `access_list_id`.

Locked (a person types a confirmation): proxy, redirection and stream creates and updates, every delete, disabling a host, enabling a proxy, redirection or stream host, 404 hosts with `advanced_config`, access-list updates, all user and 2FA changes, and settings.
