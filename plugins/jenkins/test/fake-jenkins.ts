import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Jenkins under the `/jenkins` context path: nested folders, parameterized jobs, builds with logs and
 * test reports, the queue and nodes. Password parameter values it returns must never reach the sandbox. */

export const VERSION = '2.462.3';
export const CONTEXT = '/jenkins';
export const CREDENTIALS = { username: 'synoikia', token: 'test-token-EXAMPLE' };
/** A build's password parameter value, and a job's password parameter default. */
export const BUILD_SECRET = 'fake-build-secret-5f4e3d';
export const DEFAULT_SECRET = 'fake-default-secret-9a8b7c';
/** Credentials in a git remote URL and an injected environment variable. */
export const GIT_SECRET = 'fake-git-secret-EXAMPLE';
export const ENV_SECRET = 'fake-env-secret-EXAMPLE';
export const GIT_URL = `https://ci-bot:${GIT_SECRET}@git.example.com/infra/deploy.git`;
export const DEPLOY = 'infra/deploy app';
export const HELLO = 'hello';
export const LOG = `Cloning ${GIT_URL}\n` + Array.from({ length: 40 }, (_, i) => `line ${i + 1} ✓`).join('\n') + '\n';

interface Build {
  number: number;
  result: string | null;
  building: boolean;
  params: { _class: string; name: string; value?: unknown }[];
  log: string;
}
interface Job {
  fullName: string;
  folder: boolean;
  disabled: boolean;
  params: { _class: string; name: string; type: string; defaultParameterValue?: unknown }[];
  builds: Map<number, Build>;
  next: number;
}
interface QueueItem {
  id: number;
  job: string;
  query: Record<string, string>;
  polls: number;
  number?: number;
}

export interface FakeJenkins extends FakeHttp {
  jobs: Map<string, Job>;
  queue: Map<number, QueueItem>;
  state: {
    quietingDown: boolean;
    quietReason?: string;
    restarting: boolean;
    version: string;
    /** Where every POST action redirects instead, e.g. a sign-in page. */
    redirectTo?: string;
  };
  /** Paths answered 403. */
  denied: Set<string>;
  reset(): void;
}

const authorized = (req: FakeRequest) =>
  req.headers.authorization ===
  `Basic ${Buffer.from(`${CREDENTIALS.username}:${CREDENTIALS.token}`).toString('base64')}`;

function seed() {
  const jobs = new Map<string, Job>();
  const job = (fullName: string, extra: Partial<Job> = {}) =>
    jobs.set(fullName, { fullName, folder: false, disabled: false, params: [], builds: new Map(), next: 1, ...extra });
  job('infra', { folder: true });
  job(DEPLOY, {
    params: [
      {
        _class: 'hudson.model.StringParameterDefinition',
        name: 'BRANCH',
        type: 'StringParameterDefinition',
        defaultParameterValue: { _class: 'hudson.model.StringParameterValue', name: 'BRANCH', value: 'main' },
      },
      {
        _class: 'hudson.model.PasswordParameterDefinition',
        name: 'DEPLOY_KEY',
        type: 'PasswordParameterDefinition',
        defaultParameterValue: {
          _class: 'hudson.model.PasswordParameterValue',
          name: 'DEPLOY_KEY',
          value: DEFAULT_SECRET,
        },
      },
    ],
    builds: new Map([
      [
        41,
        {
          number: 41,
          result: 'FAILURE',
          building: false,
          params: [
            { _class: 'hudson.model.StringParameterValue', name: 'BRANCH', value: 'main' },
            { _class: 'hudson.model.PasswordParameterValue', name: 'DEPLOY_KEY', value: BUILD_SECRET },
          ],
          log: LOG,
        },
      ],
      [42, { number: 42, result: null, building: true, params: [], log: 'Started by user synoikia\n' }],
    ]),
    next: 43,
  });
  job(HELLO, {
    builds: new Map([[7, { number: 7, result: 'SUCCESS', building: false, params: [], log: 'hi\n' }]]),
    next: 8,
  });
  return jobs;
}

export async function startFakeJenkins(): Promise<FakeJenkins> {
  const jobs = seed();
  const queue = new Map<number, QueueItem>();
  const state: FakeJenkins['state'] = { quietingDown: false, restarting: false, version: VERSION };
  const denied = new Set<string>();
  let nextQueue = 100;

  const base = (req: FakeRequest) => `http://${req.headers.host ?? 'localhost'}${CONTEXT}`;
  const jobUrl = (req: FakeRequest, fullName: string) =>
    `${base(req)}/job/${fullName.split('/').map(encodeURIComponent).join('/job/')}/`;
  const notFound: FakeResponse = { status: 404, body: '<html><body>Not Found</body></html>' };
  const redirect = (req: FakeRequest, to = '/'): FakeResponse => ({
    status: 302,
    headers: { location: state.redirectTo ?? base(req) + to },
  });

  const buildJson = (req: FakeRequest, job: Job, b: Build) => ({
    _class: 'org.jenkinsci.plugins.workflow.job.WorkflowRun',
    number: b.number,
    url: `${jobUrl(req, job.fullName)}${b.number}/`,
    result: b.result,
    building: b.building,
    duration: 1234,
    actions: [
      { _class: 'hudson.model.CauseAction', causes: [{ shortDescription: 'Started by user synoikia' }] },
      ...(b.params.length ? [{ _class: 'hudson.model.ParametersAction', parameters: b.params }] : []),
      ...(b.number === 41
        ? [
            { _class: 'hudson.plugins.git.util.BuildData', remoteUrls: [GIT_URL] },
            { _class: 'org.jenkinsci.plugins.envinject.EnvInjectPluginAction', envMap: { DB_TOKEN: ENV_SECRET } },
          ]
        : []),
    ],
  });
  const jobJson = (req: FakeRequest, job: Job) => ({
    _class: job.folder
      ? 'com.cloudbees.hudson.plugins.folder.Folder'
      : 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
    name: job.fullName.split('/').at(-1),
    fullName: job.fullName,
    url: jobUrl(req, job.fullName),
    ...(job.folder
      ? { jobs: children(req, job.fullName) }
      : {
          color: job.disabled ? 'disabled' : 'blue',
          disabled: job.disabled,
          property: job.params.length
            ? [
                {
                  _class: 'hudson.model.ParametersDefinitionProperty',
                  parameterDefinitions: job.params,
                },
              ]
            : [],
          builds: [...job.builds.values()].map((b) => ({ number: b.number, result: b.result })),
        }),
  });
  const children = (req: FakeRequest, folder: string | undefined) =>
    [...jobs.values()]
      .filter((j) => {
        const parent = j.fullName.includes('/') ? j.fullName.slice(0, j.fullName.lastIndexOf('/')) : undefined;
        return parent === folder;
      })
      .map((j) => ({ name: j.fullName.split('/').at(-1), fullName: j.fullName, url: jobUrl(req, j.fullName) }));

  const permalink = (job: Job, ref: string) => {
    const all = [...job.builds.values()].sort((a, b) => b.number - a.number);
    if (/^\d+$/.test(ref)) return job.builds.get(Number(ref));
    if (ref === 'lastBuild') return all[0];
    if (ref === 'lastFailedBuild') return all.find((b) => b.result === 'FAILURE');
    if (ref === 'lastSuccessfulBuild') return all.find((b) => b.result === 'SUCCESS');
    if (ref === 'lastCompletedBuild') return all.find((b) => !b.building);
    return undefined;
  };

  function onJob(req: FakeRequest, job: Job, rest: string): FakeResponse {
    const post = req.method === 'POST';
    if (rest === '/api/json' && !post) return { body: jobJson(req, job) };
    if (rest === '/build' && post) {
      if (job.params.length) return { status: 400, body: 'This page expects a form submission' };
      return enqueue(req, job, {});
    }
    if (rest === '/buildWithParameters' && post) {
      if (!job.params.length) return { status: 500, body: 'This build is not parameterized!' };
      return enqueue(req, job, Object.fromEntries(req.query));
    }
    if (rest === '/doDelete' && post) {
      for (const name of [...jobs.keys()])
        if (name === job.fullName || name.startsWith(`${job.fullName}/`)) jobs.delete(name);
      return redirect(req);
    }
    if ((rest === '/disable' || rest === '/enable') && post) {
      job.disabled = rest === '/disable';
      return redirect(req);
    }
    const m = /^\/([^/]+)(\/.*)$/.exec(rest);
    const build = m ? permalink(job, decodeURIComponent(m[1]!)) : undefined;
    if (!m || !build) return notFound;
    const tail = m[2]!;
    if (tail === '/api/json' && !post) return { body: buildJson(req, job, build) };
    if (tail === '/logText/progressiveText' && !post) {
      const bytes = Buffer.from(build.log, 'utf8');
      let start = Number(req.query.get('start') ?? 0);
      if (start > bytes.length) start = 0;
      return {
        status: 200,
        body: bytes.subarray(start).toString('utf8'),
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'x-text-size': String(bytes.length),
          ...(build.building ? { 'x-more-data': 'true' } : {}),
        },
      };
    }
    if (tail === '/testReport/api/json' && !post)
      return {
        body: {
          _class: 'hudson.tasks.junit.TestResult',
          failCount: 1,
          passCount: 2,
          skipCount: 0,
          suites: [{ name: 'api', cases: [{ className: 'api.Health', name: 'responds', status: 'FAILED' }] }],
        },
      };
    if (tail === '/stop' && post) {
      build.building = false;
      build.result = 'ABORTED';
      return redirect(req, jobUrl(req, job.fullName).slice(base(req).length));
    }
    if (tail === '/doDelete' && post) {
      job.builds.delete(build.number);
      return redirect(req);
    }
    return notFound;
  }

  function enqueue(req: FakeRequest, job: Job, query: Record<string, string>): FakeResponse {
    const id = nextQueue++;
    queue.set(id, { id, job: job.fullName, query, polls: 0 });
    return { status: 201, headers: { location: `${base(req)}/queue/item/${id}/` } };
  }

  function route(req: FakeRequest): FakeResponse {
    if (!req.path.startsWith(`${CONTEXT}/`)) return notFound;
    const path = req.path.slice(CONTEXT.length);
    if (denied.has(path)) return { status: 403, body: '<html>Access Denied</html>' };
    const post = req.method === 'POST';
    const jm = /^((?:\/job\/[^/]+)+)(\/.*)$/.exec(path);
    if (jm) {
      const fullName = jm[1]!
        .split('/job/')
        .slice(1)
        .map((s) => decodeURIComponent(s))
        .join('/');
      const job = jobs.get(fullName);
      return job ? onJob(req, job, jm[2]!) : notFound;
    }
    if (path === '/api/json' && !post)
      return { body: { _class: 'hudson.model.Hudson', mode: 'NORMAL', jobs: children(req, undefined) } };
    if (path === '/queue/api/json' && !post)
      return {
        body: {
          items: [...queue.values()]
            .filter((q) => q.number === undefined)
            .map((q) => ({ id: q.id, why: 'Waiting for next available executor', task: { name: q.job } })),
        },
      };
    const qm = /^\/queue\/item\/(\d+)\/api\/json$/.exec(path);
    if (qm && !post) {
      const item = queue.get(Number(qm[1]));
      if (!item) return notFound;
      item.polls++;
      const job = jobs.get(item.job);
      if (item.number === undefined && item.polls > 1 && job) {
        item.number = job.next++;
        const params = job.params.map((d) => ({
          _class: d._class.replace('Definition', 'Value'),
          name: d.name,
          value: item.query[d.name] ?? (d.defaultParameterValue as { value?: unknown } | undefined)?.value,
        }));
        job.builds.set(item.number, {
          number: item.number,
          result: 'SUCCESS',
          building: false,
          params,
          log: `Started by user synoikia\nBRANCH=${item.query.BRANCH ?? 'main'}\nFinished: SUCCESS\n`,
        });
      }
      return {
        body: {
          _class: item.number === undefined ? 'hudson.model.Queue$WaitingItem' : 'hudson.model.Queue$LeftItem',
          id: item.id,
          task: { name: item.job },
          ...(item.number === undefined
            ? { why: 'Waiting for next available executor' }
            : { executable: { number: item.number, url: `${jobUrl(req, item.job)}${item.number}/` } }),
        },
      };
    }
    if (path === '/computer/api/json' && !post)
      return {
        body: {
          busyExecutors: 1,
          totalExecutors: 2,
          computer: [{ displayName: 'Built-In Node', offline: false, idle: false, numExecutors: 2 }],
        },
      };
    if (path === '/safeRestart' && post) {
      state.restarting = true;
      return redirect(req);
    }
    if (path === '/quietDown' && post) {
      state.quietingDown = true;
      state.quietReason = req.query.get('reason') ?? undefined;
      return redirect(req);
    }
    if (path === '/cancelQuietDown' && post) {
      state.quietingDown = false;
      return redirect(req);
    }
    return notFound;
  }

  const fake = await startFakeHttp({
    routes: {},
    guard: (req) => {
      const reply = authorized(req)
        ? route(req)
        : { status: 401, body: '<html>Invalid password/token for user</html>' };
      return { ...reply, headers: { 'x-jenkins': state.version, ...reply.headers } };
    },
  });
  return {
    ...fake,
    jobs,
    queue,
    state,
    denied,
    reset() {
      jobs.clear();
      for (const [k, v] of seed()) jobs.set(k, v);
      queue.clear();
      nextQueue = 100;
      Object.assign(state, {
        quietingDown: false,
        quietReason: undefined,
        restarting: false,
        version: VERSION,
        redirectTo: undefined,
      });
      denied.clear();
    },
  };
}
