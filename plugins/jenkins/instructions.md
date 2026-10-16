# Jenkins

Jenkins 2.x remote access API, as fixed operations: `jenkins.call(key, { path, query })`. A job is its full name with folders, `team/apps/api`, in `path.job`; a build is `path.number` (reads also take `lastBuild`, `lastSuccessfulBuild`, `lastFailedBuild`, `lastCompletedBuild`).

Reads apply a small default `tree`; `query.tree` may pick a subset of its fields (e.g. `jobs[fullName,color]`, nested to walk folders); `depth` is 0–2.

Workflows:

- Find a job: `jobs.list`, `path.folder` for one folder → `jobs.get` (parameters, health, recent builds).
- Run a build: `builds.trigger` (parameters in `query`) returns `queueId` → poll `queue.get` until `executable.number` → `builds.get` → `builds.log`.
- Why did it fail: `builds.get` with `lastFailedBuild` → `builds.log` (tail; `lines: 200`) → `builds.testReport`.
- Follow a running build: `builds.log` with `start: 0`, then `start` = the previous `end` while `more` is true.
- Capacity: `queue.list`, `nodes.list`; `builds.stop` aborts.

Locked (a person types the job full name, `job#number`, or the host): `builds.trigger` with parameters, `builds.delete`, `jobs.delete`, `jobs.disable`, `jobs.enable`, `system.safeRestart`, `system.quietDown`, `system.cancelQuietDown`. Not available: script console, credentials, plugin manager, job config, replay; password parameters can't be set.
