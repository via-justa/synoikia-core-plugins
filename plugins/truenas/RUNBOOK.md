# TrueNAS plugin: live checklist

The plugin is tested against a fake TrueNAS. This checklist confirms it against a real system (TrueNAS 25.04+), the step Synoikia design §13 phase 17 calls "then staging". It takes about 15 minutes.

**Before you start**

- Create a **disposable dataset parent** for the test, for example `tank/synoikia-test`. Every write below stays under it.
- Create an API key (_Credentials → API Keys_).
- Sign in to the admin portal with an account that has an authenticator app set up. Approvals need it.
- Use an MCP client that supports URL elicitation (approval prompts), for example Claude Code.

Record the result of each step (✅ / ❌ with what you saw).

## 1. Connect and sync

1. _+ New endpoint_ → plugin **TrueNAS**, slug `nas`. Enter the base URL and API key.
2. **Test connection**. Expect "OK" and your TrueNAS version.
3. Save, then **Sync now**. Expect several hundred methods and a few dozen groups, all at **Ask**.
4. On the **Access** page, check:
   - `pool.dataset.delete` and `system.reboot` show **locked**;
   - `filesystem.setacl#pool-root` exists;
   - `pool.dataset.create` shows **write**;
   - `pool.dataset.query` shows **read**, and its reason is `roles:read(DATASET_READ)`. If reasons say `naming:…` everywhere, TrueNAS sent no roles: report it.

## 2. Reads

Create a bearer token for `nas` with Read & write access (_Clients & Tokens_) and connect your MCP client to `…/nas`.

1. Ask: "List my pools and their status." Expect a `pool.query` call, no prompt, and a correct answer.
2. Ask: "Show my SMB shares." Expect no prompt, and no passwords in the result.
3. Set the `pool.dataset` group to **Read**. Ask: "Create dataset `tank/synoikia-test/a`." Expect a refusal: `pool.dataset` is at Read. Nothing is created.

## 3. An asked write

1. Set the `pool.dataset` group to **Ask**.
2. Ask again to create `tank/synoikia-test/a`. Expect an approval prompt in the client and the approval page to open. **Deny** it. Expect the client to report the denial, with nothing created.
3. Ask again, and this time **Approve**. Expect the dataset to exist in the TrueNAS UI.

## 4. A rule

1. On **Pre-Approval Rules**, create a rule: `pool.dataset.create`, name prefix `tank/synoikia-test`, reason "live test".
2. Ask to create `tank/synoikia-test/b`. Expect no prompt; the dataset is created.
3. Ask to create `tank/synoikia-test/c` with a quota. Expect a prompt, because the quota isn't covered by the rule. Deny it.

## 5. A locked delete

1. On **Access**, give `pool.dataset.delete` its own level **Ask**.
2. Ask to delete `tank/synoikia-test/a`. On the approval page:
   - expect a fresh authenticator code to be asked for;
   - expect the dataset name to be required;
   - type a wrong name and check the page refuses it;
   - type `tank/synoikia-test/a` and approve.
3. Expect the dataset to be gone.

## 6. Secrets

1. Ask: "List the users and their details." Expect no `unixhash` or `smbhash` values (they show `[REDACTED]`).
2. If you have a cloud credential (_Credentials → Backup Credentials_), ask to list them. Expect every `key` to show `[REDACTED]`.
3. If you have an encrypted dataset under the test parent, set `pool.dataset.encryption_summary` to **Read** and ask for its encryption summary with its key. Then check the **Audit Log** row: the key shows `[REDACTED]`.

## 7. Denial by TrueNAS (optional)

With an API key whose role is read-only, ask for a write under `tank/synoikia-test`. Expect the client to report "TrueNAS denied … insufficient permission" (`UPSTREAM_DENIED`), not a crash.

## 8. Audit and cleanup

1. **Audit Log**, filtered to `nas`. Expect the reads, a `denied`, a `human-approved`, an `auto-approved:rule:…` and the typed-confirmation delete. Check that no API key appears anywhere.
2. Delete `tank/synoikia-test` in the TrueNAS UI, and remove the rule and the token.

Report anything that differs, especially:

- methods the plugin classified wrongly (expected read, shown as write, or the reverse);
- job methods that timed out.
