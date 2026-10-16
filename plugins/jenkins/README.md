# Jenkins

Jenkins 2.x for Synoikia: jobs, builds, console logs, test reports, the queue and nodes, from a fixed set of remote access API operations declared in `plugin.yaml` (Jenkins serves no API spec). Design: [`docs/designs/jenkins.md`](../../docs/designs/jenkins.md).

The sandbox calls `jenkins.call(key, { path, query })`, with jobs by full name (`folder/job`). Every call goes through Synoikia's permission gate, approvals, redaction and audit log; this plugin only describes Jenkins's API.

## Files

| File              | What                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `manifest.json`   | Binding, connection form, `sensitiveKeys` and network hosts                                  |
| `plugin.yaml`     | The declared operations, locks, confirmation literals, default `tree` filters and log limits |
| `instructions.md` | How to call the API, for the model                                                           |
| `src/plugin.ts`   | Handlers: param checks, summaries, invoke                                                    |
| `src/paths.ts`    | Job full name → `/job/a/job/b` path segments, build numbers, queue ids                       |
| `src/jenkins.ts`  | Status checks, job lookup, targets, build parameter checks                                   |
| `src/log.ts`      | Console log tail and byte ranges                                                             |
| `src/mask.ts`     | Password parameter values masked in results                                                  |
| `src/auth.ts`     | HTTP Basic with the username and API token                                                   |
| `test/`           | A fake Jenkins, unit, golden and e2e tests on Synoikia's harness                             |

## Connection

See the manifest's `connection.help`: the base URL (with a context path if any), a username and that user's API token. Use a dedicated user with only the Jenkins permissions Synoikia should have.

## Locked operations

`builds.delete` (confirm `<job>#<number>`), `jobs.delete`, `jobs.disable`, `jobs.enable` (confirm the job's full name), `system.safeRestart`, `system.quietDown` and `system.cancelQuietDown` (confirm the base URL's host name). The script console, credentials, plugin manager, job configuration and replay are not declared at all.
