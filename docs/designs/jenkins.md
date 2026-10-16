# Jenkins plugin: design

Jenkins 2.x (https://www.jenkins.io/) is a CI server: jobs in nested folders, builds with console logs and test reports, a build queue and build agents. This plugin exposes it through Synoikia's `search` and `execute` tools. Where this note and Synoikia's design disagree, Synoikia's design applies.

## Catalog source

Jenkins has no OpenAPI spec, served or published. Its remote access API makes every object readable at `<object URL>/api/json`, filtered with `tree=` or `depth=`, and acts through POSTs to Stapler actions. The plugin is a `static-rest` plugin: `plugin.yaml` declares a small, fixed set of operations. The user approved this set, modelled on the Jenkins tools of `emnify/emnify-mcp-developer`, as the plan's "Jenkins: a small, fixed tool set" decision. Nothing else in Jenkins is reachable.

The sandbox calls `jenkins.call(key, { path, query })`. No operation takes a body.

## Operations

| Key | Request | Class |
| --- | --- | --- |
| `jobs.list` | `GET /api/json`, or `GET /job/{folder}/api/json` | read |
| `jobs.get` | `GET /job/{job}/api/json` | read |
| `builds.get` | `GET /job/{job}/{number}/api/json` | read |
| `builds.log` | `GET /job/{job}/{number}/logText/progressiveText` | read |
| `builds.testReport` | `GET /job/{job}/{number}/testReport/api/json` | read |
| `queue.list` | `GET /queue/api/json` | read |
| `queue.get` | `GET /queue/item/{id}/api/json` | read |
| `nodes.list` | `GET /computer/api/json` | read |
| `builds.trigger` | `POST /job/{job}/build`, or `/buildWithParameters` for a parameterized job, without parameters in the call | write |
| `builds.trigger#params` | The same with build parameters in `query` | locked |
| `builds.stop` | `POST /job/{job}/{number}/stop` | write |
| `builds.delete` | `POST /job/{job}/{number}/doDelete` | locked |
| `jobs.delete` | `POST /job/{job}/doDelete` | locked |
| `jobs.disable`, `jobs.enable` | `POST /job/{job}/disable`, `/enable` | locked |
| `system.safeRestart` | `POST /safeRestart` | locked |
| `system.quietDown`, `system.cancelQuietDown` | `POST /quietDown` (`reason`), `/cancelQuietDown` | locked |

Not declared, so not reachable: the script console (`/script`, `/scriptText`), credentials, the plugin manager, `config.xml` reads and writes, `/manage`, job create, copy and rename, build replay, `term`/`kill`, and the immediate `restart`/`exit`.

Each read has a default `tree` in `plugin.yaml` (`plugin.trees`) so responses stay small. A call's own `tree` or `depth` replaces it. Reads take only `tree` and `depth`; other query keys (such as `jsonp`) are refused.

- A call's `tree` may name only leaf fields of the operation's default tree, plus `_class` (nested `jobs[…]` count as `jobs`). So it cannot select fields such as git `BuildData.remoteUrls` or EnvInject `envMap`.
- `depth` is 0, 1 or 2.
- Whatever a read returns, the plugin masks credentials in URLs (`scheme://user:token@` → `scheme://[REDACTED]@`) in every string, console log text included, and hides `envMap` and `environment` values. `depth` can reach such fields, so this is the second line of defense.

## Paths

`path.job` is the job's full name, `folder/sub/job`. Each level becomes its own `encodeURIComponent` segment: `/job/folder/job/sub/job/job`. A name is refused when it is not a string, is over 1024 characters, has control characters, has a character Jenkins forbids in item names (``?*\%!@#$^&|<>[]:;``), or has an empty level or one that is `.` or `..` after NFKC normalization (fullwidth `．．`). So a name reaches only the job it names; a job named like an endpoint (`scriptText`) stays under `/job/`. `{folder}` is optional; without it, `jobs.list` reads the root. `path.number` is a build number; reads also take the permalinks `lastBuild`, `lastSuccessfulBuild`, `lastFailedBuild` and `lastCompletedBuild`, writes take a number only (a permalink can move during an approval wait). `path.id` is a numeric queue item. A path param the template does not take is refused. The SDK's HTTP client also refuses `.` and `..` segments and paths outside the base URL.

Query keys that differ only by case are refused, and query values must be strings, numbers or booleans.

## Console log

`progressiveText?start=N` returns the log from byte `N` on, with the total size in `X-Text-Size` and `X-More-Data: true` while the build runs. Jenkins has no tail request and starts over from 0 when `start` is past the end. The plugin asks for `start` (0 by default) and cuts the reply:

- Without `query.start`: the last `bytes` (default 64 KiB, at most 256 KiB), or the last `lines` (at most 5000) of those.
- With `query.start`: up to `bytes` from there, or the first `lines`; `truncated` says more follows, from `end`.
- `start` past the end is refused. Cuts move to whole UTF-8 characters. The result is `{ text, start, end, size, more, truncated }`.

A tail call downloads the log from byte 0, within the HTTP client's 32 MiB response cap; a follow-up with `start` downloads only the rest.

## Builds and the queue

A trigger with build parameters resolves to the locked twin `builds.trigger#params`; one without stays a plain write (a parameterized job then builds with its defaults). Parameter values can be code: a branch with its own Jenkinsfile, or strings a pipeline passes to `evaluate`. This is stricter than the approved set, which had the trigger as a plain write, and follows the plan's lock list ("Jenkins build with params"). The plugin refuses an `invoke` whose key does not match whether the call has parameters.

`builds.trigger` reads the job's parameter definitions first. A job with parameters is built through `/buildWithParameters` with `query` as its parameters, a job without through `/build`. A parameter the job does not define is refused. The reply's `Location` header (`…/queue/item/<id>/`) gives `{ job, queueId }`. The model polls `queue.get` until `executable.number`, then reads the build.

## Auth

The username and an API token, as HTTP Basic. With an API token Jenkins needs no CSRF crumb on POSTs. The token is `writeOnly` with the `secret` widget; `sensitiveKeys` are `token`, `password`, `apiToken` and `secret`. The version comes from the `X-Jenkins` header of `GET /api/json?tree=mode`, a call that also proves the credentials; Jenkins 1.x is refused.

## Secrets in build parameters

Password parameters (`PasswordParameterDefinition`, `PasswordParameterValue`, and plugin types with password, secret or credential in their class or type) carry secrets under the key `value`, which core cannot mask by key name. So:

- Read results are masked by the plugin: every field of such a parameter but `_class`, `name`, `type` and `description`, and the `value` of a build parameter without `_class`.
- `builds.trigger` refuses to set a password parameter, in `resolveOperation`, before core writes the call's params to the audit log. Its default applies. A parameter definition without a type counts as a password.
- The trigger summary shows parameter values, except password parameters and any the job does not define.

Console logs are returned as Jenkins writes them. Jenkins masks bound credentials and password parameters in logs; other secrets a build prints reach the result.

## Locks

Each locked operation needs a typed confirmation:

| Operation | Why | Literal |
| --- | --- | --- |
| `builds.trigger#params` | Runs the job with values the model chose, which can be code | job full name (lookup) |
| `builds.delete` | Removes the build, its log and artifacts | `<job full name>#<number>` (lookup) |
| `jobs.delete` | Removes the job, or a folder with all its jobs, and every build | job full name (lookup) |
| `jobs.disable`, `jobs.enable` | Stops or starts scheduled and triggered builds | job full name (lookup) |
| `system.safeRestart` | Restarts the instance for everyone | base URL host name |
| `system.quietDown`, `system.cancelQuietDown` | Stops or resumes new builds on the whole instance | base URL host name |

Jenkins has no instance name, so instance-wide locks confirm on the base URL's host name (`jenkins.internal.lan`, without the port). Job and build literals come from the stored object, read back as the approval's target; when it cannot be read, the names in the call are the literal. `*.delete` and `system.*` are locked as a pattern, so a later delete or instance action is locked until reviewed.

`builds.trigger` without parameters and `builds.stop` are plain writes: an admin decides at the group level, and pre-approval rules can name the job target.

## Redirects

Jenkins answers most actions with a redirect. An action's 3xx is success only when its `Location` stays within the base URL (same origin and path prefix) and is not a sign-in page (`/login`, `securityRealm`): those mean the action did not run. A read's 3xx is a failure. The Jenkins URL setting must therefore match the connection's base URL.

## Targets

`resolveTargets` gives writes their stored object: `job` (id and name the full name) or `build` (id `<full name>#<number>`, name `<full name> #<number>`, only when the build exists), and `instance` (the host name) for `system.*`. Targets hold no status, as core resolves them again after the approval wait and refuses the call when they changed. Reads have no targets.

## Summaries

Destination first: `Jenkins jobs.delete on infra/deploy app: POST /job/infra/job/deploy%20app/doDelete`. Job names, parameter names and values, and the quiet-down reason are escaped (control, bidi and zero-width characters as `\uXXXX`) and truncated.
