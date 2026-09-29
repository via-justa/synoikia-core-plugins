# Home Assistant plugin: live checklist

The plugin is tested against a fake Home Assistant. This checklist confirms it against a real instance, the step Synoikia design §13 phase 19 needs before it is called done. It takes about 20 minutes.

**Before you start**

- A **test light** you can switch freely, in an area with at least one other light. A virtual one is fine, for example a template light or the Demo integration.
- Optional: a lock, or a cover with device class `garage`. The Demo integration provides both (`lock.front_door`, `cover.garage_door`).
- A long-lived access token of an administrator (_Profile → Security_).
- Sign in to the admin portal with an account that has an authenticator app set up. Approvals need it.
- Use an MCP client that supports URL elicitation (approval prompts), for example Claude Code.

Record the result of each step (✅ / ❌ with what you saw).

## 1. Connect and sync

1. _+ New endpoint_ → plugin **Home Assistant**, slug `ha`. Enter the base URL and the token.
2. **Test connection**. Expect "OK" and your Home Assistant version.
3. Save, then **Sync now**. Expect hundreds of operations and one group per service domain, all at **Read**.
4. On the **Access** page, check:
   - `lock.unlock` and `homeassistant.restart` show **locked**;
   - `cover.open_cover#garage` and `homeassistant.turn_off#protected` exist and are locked;
   - `light.turn_on` shows **write**, `get_states` **read**.

## 2. Reads

Create a bearer token for `ha` with Read & write access (_Clients & Tokens_) and connect your MCP client to `…/ha`.

1. Ask: "Which lights are on?" Expect `get_states` (ideally filtered by domain), no prompt, and a correct answer.
2. Ask: "Show my cameras." If you have one, expect `access_token` and `entity_picture` as `[REDACTED]`.
3. Ask: "Turn on the test light." Expect a refusal: `light` is at Read.

## 3. An asked service call

1. Set the `light` group to **Ask**.
2. Ask to turn on **the lights in the test light's area**. Expect an approval prompt that **names each light**, not the area. **Deny** it: nothing changes.
3. Ask again and **Approve**. Expect exactly those lights to turn on.

## 4. An area rule

1. On **Pre-Approval Rules**, create a rule for `light.turn_off`. Under **Targets**, pick the test area. Reason: "live test".
2. Ask to turn off the lights in that area. Expect no prompt; they turn off.
3. Ask to turn off those lights **and** one light in another area. Expect a prompt: the rule only covers calls where every light is in the area. Deny it.

## 5. A locked call (if you have a lock or garage door)

1. Give `lock.unlock` (or `cover.open_cover#garage`) its own level **Ask**. Confirm the dialog.
2. Ask to unlock the lock (or open the garage door). On the approval page:
   - expect a fresh authenticator code to be asked for;
   - expect the entity's name to be required;
   - type a wrong name and check the page refuses it;
   - type the name and approve.
3. Ask to do the same with `homeassistant.turn_off` (or `turn_on` for the garage). Expect the same locked prompt (`#protected`).

## 6. Editing an automation

1. Create a throwaway automation in the HA UI, for example "HSM test", with a time trigger and a notification action.
2. Set the `automation` group to **Ask**.
3. Ask the client to rename it to "HSM test renamed" and add a second time trigger. Expect:
   - the client reads the automation and fetches the guide first (a `guide_read` in the audit log);
   - an approval prompt showing a **diff** of only the alias and the added trigger;
   - after approval, the change in the HA UI.
4. Ask for another change, but before approving it, edit the automation in the HA UI and save it. Then approve. Expect `CONFIG_CONFLICT`, and your UI edit kept.
5. Ask to delete it. Expect a locked prompt asking for the alias.

## 7. Registry changes (optional)

Move the test light to another area in the HA UI, then ask to turn on the lights in its old area. Expect the prompt no longer to include it, without a manual sync.

## 8. Audit and cleanup

1. **Audit Log**, filtered to `ha`. Expect:
   - the reads;
   - a `denied`, a `human-approved`, an `auto-approved:rule:…`;
   - the typed-confirmation call and the automation edit with its diff.

   Check that no token appears anywhere.

2. Delete the test automation, the rule and the token.

Report anything that differs, especially:

- a sensitive action that wasn't locked;
- a target that resolved to the wrong entities;
- anything secret visible in a result or the audit log.
