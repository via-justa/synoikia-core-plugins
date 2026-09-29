# Seerr plugin: live checklist

The plugin is tested against a fake Seerr. This checklist confirms it against a real instance, the step Synoikia design §13 phase 18 needs before it is called done. It takes about 15 minutes.

**Before you start**

- Create a **dedicated local user** for the server (_Users → Create Local User_). Give it Request and Manage Requests; add Admin only for step 5.
- Create a **second, throwaway local user** (for example `synoikia-test@seerr.local`). You'll file one request as that user and delete the user at the end.
- Pick a title nobody wants downloaded, or make sure Radarr/Sonarr won't grab it (for example, no quality profile matches).
- Sign in to the admin portal with an account that has an authenticator app set up. Approvals need it.
- Use an MCP client that supports URL elicitation (approval prompts), for example Claude Code.

Record the result of each step (✅ / ❌ with what you saw).

## 1. Connect and sync

1. _+ New endpoint_ → plugin **Seerr**, slug `seerr`. Choose **Local user**, enter the base URL, email and password. Leave _API spec source_ empty.
2. **Test connection**. Expect "OK" and your Seerr version.
3. Save, then **Sync now**. Expect about 210 operations, groups named after the API tags (`request`, `settings`, `users`, …), all at **Read**, and a source such as `v3.4.1` (or `develop` for a nightly).
4. On the **Access** page, check:
   - `GET /settings/discover/reset` and `DELETE /user/{userId}` show **locked**;
   - `POST /request/{requestId}/{status}#on-behalf` exists and is locked;
   - `POST /request` shows **write**, `GET /request` **read**.

## 2. Reads

Create a bearer token for `seerr` with Read & write access (_Clients & Tokens_) and connect your MCP client to `…/seerr`.

1. Ask: "List pending requests." Expect a `GET /request` call, no prompt, and a correct answer.
2. Ask: "Show Seerr's main settings." Expect no prompt, and `apiKey` shown as `[REDACTED]`.
3. Ask: "Request the movie _<your title>_." Expect a refusal: `request` is at Read. Nothing is created.

## 3. An asked write

1. Set the `request` group to **Ask**.
2. Ask again to request the title. Expect an approval prompt in the client and the approval page to open. **Deny** it. Expect the client to report the denial, with no request in Seerr.
3. Ask again, and **Approve**. Expect the request in Seerr, filed by the server's user.

## 4. A rule

1. On **Pre-Approval Rules**, create a rule for `POST /request`: 4K request **no**, media type **movie**, `mediaId` **any value**, reason "live test".
2. Ask for another standard-quality movie. Expect no prompt; the request is created.
3. Ask for the same in 4K (if 4K is configured). Expect a prompt; deny it.

## 5. Someone else's request (locked)

1. Sign in to Seerr as the throwaway user and request a title.
2. On **Access**, give `POST /request/{requestId}/{status}#on-behalf` its own level **Ask**. Confirm the dialog.
3. Ask the client to decline that request. On the approval page:
   - expect a fresh authenticator code to be asked for;
   - expect the requester's name to be required;
   - type a wrong name and check the page refuses it;
   - type the throwaway user's display name and approve.
4. Expect the request to be declined in Seerr.
5. Ask to approve or decline one of the **server's own** requests. Expect an ordinary prompt, with no name to type.

## 6. Session expiry (optional)

Sign the server's user out of all sessions (for example, change its password in Seerr, then update it on the Connection page), and make a read. Expect it to work without a manual step: the plugin signs in again.

## 7. Denial by Seerr (optional)

Remove Manage Requests from the server's user and ask to approve a request. Expect the client to report "Seerr denied … insufficient permission" (`UPSTREAM_DENIED`), not a crash.

## 8. Audit and cleanup

1. **Audit Log**, filtered to `seerr`. Expect the reads, a `denied`, a `human-approved`, an `auto-approved:rule:…` and the typed-confirmation decline. Check that no password, cookie or API key appears anywhere.
2. Delete the test requests and the throwaway user in Seerr, and remove the rule and the token.

Report anything that differs, especially:

- operations classified wrongly (a read shown as a write, or the reverse);
- a spec source other than the tag you expected;
- anything secret visible in a result or the audit log.
