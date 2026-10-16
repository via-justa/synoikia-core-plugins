import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkStatus, redirectFailure } from '../src/jenkins.js';
import { maskEmbeddedCredentials, maskParameterSecrets } from '../src/mask.js';
import { fillPath, jobSegments } from '../src/paths.js';
import { createJenkinsPlugin, safe, settings } from '../src/plugin.js';
import { checkTree, treeLeaves } from '../src/tree.js';
import {
  BUILD_SECRET,
  CONTEXT,
  CREDENTIALS,
  DEFAULT_SECRET,
  DEPLOY,
  ENV_SECRET,
  GIT_SECRET,
  GIT_URL,
  HELLO,
  LOG,
  startFakeJenkins,
  VERSION,
} from './fake-jenkins.js';
import type { FakeJenkins } from './fake-jenkins.js';
import { LOCK_CASES } from './locks.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const PERMALINKS = settings.plugin.permalinks;

let fake: FakeJenkins;
const plugin = createJenkinsPlugin();
let operations: OperationDescriptor[];
const context = { callId: 'test', deadlineMs: 5000 };

const connection = () => {
  const { username, token } = CREDENTIALS;
  return { instanceId: 'jenkins', config: { baseUrl: `${fake.url}${CONTEXT}`, username }, secrets: { token } };
};
const resolve = (key: string, params?: unknown) =>
  plugin.resolveOperation({ fn: 'call', args: params === undefined ? [key] : [key, params] });
const run = async (key: string, params: unknown = {}) => {
  const r = await resolve(key, params);
  return plugin.invoke({ key: r.key, params: r.params, context });
};
const lastRequest = () => fake.requests.at(-1)!;

beforeAll(async () => {
  fake = await startFakeJenkins();
  await plugin.init({ ...connection(), sdkVersion: '1' });
  operations = (await plugin.syncCatalog()).operations as OperationDescriptor[];
});
beforeEach(() => fake.reset());
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

describe('job paths', () => {
  it('nests each folder level as its own encoded segment', () => {
    expect(jobSegments('hello')).toBe('hello');
    expect(jobSegments('infra/deploy app')).toBe('infra/job/deploy%20app');
    expect(jobSegments('a/b c/ü-1.0')).toBe('a/job/b%20c/job/%C3%BC-1.0');
    // A job may be named like an endpoint; it stays under /job/.
    expect(jobSegments('scriptText')).toBe('scriptText');
    expect(fillPath('/job/{job}/api/json', { job: 'scriptText' }, [])).toBe('/job/scriptText/api/json');
  });

  it.each([
    '',
    '/a',
    'a/',
    'a//b',
    '.',
    '..',
    'a/../b',
    'a/./b',
    'a\nb',
    'a\u0000b',
    'x'.repeat(1025),
    'a;b',
    'a\\b',
    '%2e%2e',
    'a/%2e%2e/b',
    '\uff0e\uff0e',
    'a/\uff0e/b',
    'a?b',
    'a#b',
    'a[0]',
  ])('refuses job name %j', (name) => {
    expect(() => jobSegments(name)).toThrow(expect.objectContaining({ code: ErrorCodes.InvalidParams }));
  });

  it('refuses a job that is not a string', () => {
    expect(() => jobSegments(['a'])).toThrow(/full name/);
    expect(() => jobSegments({ toString: () => 'a' })).toThrow(/full name/);
  });

  it('fills job, folder, build and queue placeholders', () => {
    expect(fillPath('/job/{folder}/api/json', {}, [])).toBe('/api/json');
    expect(fillPath('/job/{folder}/api/json', { folder: 'infra' }, [])).toBe('/job/infra/api/json');
    expect(fillPath('/job/{job}/{number}/stop', { job: 'a/b', number: 12 }, [])).toBe('/job/a/job/b/12/stop');
    expect(fillPath('/job/{job}/{number}/api/json', { job: 'a', number: 'lastBuild' }, PERMALINKS)).toBe(
      '/job/a/lastBuild/api/json',
    );
    expect(fillPath('/queue/item/{id}/api/json', { id: '7' }, [])).toBe('/queue/item/7/api/json');
  });

  it('refuses permalinks for writes, bad numbers and params the template does not take', () => {
    const bad = (template: string, path: Record<string, unknown>, links: string[] = []) =>
      expect(() => fillPath(template, path, links)).toThrow(
        expect.objectContaining({ code: ErrorCodes.InvalidParams }),
      );
    bad('/job/{job}/{number}/stop', { job: 'a', number: 'lastBuild' });
    bad('/job/{job}/{number}/api/json', { job: 'a', number: 'nextBuild' }, PERMALINKS);
    for (const number of [0, -1, 1.5, '01', '1/../2', '12a']) bad('/job/{job}/{number}/stop', { job: 'a', number });
    bad('/queue/item/{id}/api/json', { id: '../1' });
    bad('/job/{job}/api/json', { job: 'a', number: 1 });
    bad('/job/{job}/api/json', { job: 'a', Job: 'b' });
  });
});

describe('secret parameters', () => {
  it('masks password parameter values and defaults, keeping their names', () => {
    const masked = maskParameterSecrets({
      actions: [
        {
          _class: 'hudson.model.ParametersAction',
          parameters: [
            { _class: 'hudson.model.StringParameterValue', name: 'BRANCH', value: 'main' },
            { _class: 'hudson.model.PasswordParameterValue', name: 'KEY', value: 's1' },
            { name: 'UNTYPED', value: 's2' },
          ],
        },
      ],
      property: [
        {
          parameterDefinitions: [
            { name: 'KEY', type: 'PasswordParameterDefinition', defaultParameterValue: { name: 'KEY', value: 's3' } },
            { _class: 'x.CredentialsParameterDefinition', name: 'CRED', defaultValue: 's4' },
          ],
        },
      ],
    });
    expect(JSON.stringify(masked)).not.toMatch(/"s[1-4]"/);
    expect(masked).toMatchObject({
      actions: [{ parameters: [{ value: 'main' }, { name: 'KEY', value: '[REDACTED]' }, { value: '[REDACTED]' }] }],
      property: [{ parameterDefinitions: [{ name: 'KEY', defaultParameterValue: '[REDACTED]' }, { name: 'CRED' }] }],
    });
  });
});

describe('tree and depth', () => {
  const builds = settings.plugin.trees['builds.get']!;

  it('reads the leaf fields of a tree', () => {
    expect(treeLeaves('a,b[c,d[e]]{0,5},_class')).toEqual(['a', 'b.c', 'b.d.e', '_class']);
    for (const bad of ['a[b', 'a]', 'a,,b', 'a{x}', 'a b', 'a[b]c', ''])
      expect(() => treeLeaves(bad), bad).toThrow(expect.objectContaining({ code: ErrorCodes.InvalidParams }));
  });

  it("allows fields of the operation's default tree, nested folders and _class", () => {
    expect(() =>
      checkTree('builds.get', 'number,result,actions[_class,causes[shortDescription]]', builds),
    ).not.toThrow();
    expect(() =>
      checkTree('jobs.list', 'jobs[fullName,jobs[fullName,jobs[color]]]', settings.plugin.trees['jobs.list']!),
    ).not.toThrow();
  });

  it('refuses fields the default tree leaves out, such as git remote URLs and environments', () => {
    for (const tree of ['actions[remoteUrls]', 'actions', 'actions[envMap]', 'number,changeSets[items[paths]]'])
      expect(() => checkTree('builds.get', tree, builds), tree).toThrow(/cannot select/);
  });

  it('refuses a tree naming remoteUrls, and depth outside 0 to 2, before any request', async () => {
    const before = fake.requests.length;
    await expect(
      resolve('builds.get', { path: { job: DEPLOY, number: 41 }, query: { tree: 'actions[remoteUrls]' } }),
    ).rejects.toThrow(/cannot select actions.remoteUrls/);
    await expect(resolve('jobs.get', { path: { job: HELLO }, query: { depth: 3 } })).rejects.toThrow(/depth/);
    await expect(resolve('builds.log', { path: { job: HELLO, number: 7 }, query: { tree: 'x' } })).rejects.toThrow();
    expect(fake.requests.length).toBe(before);
    await expect(resolve('jobs.get', { path: { job: HELLO }, query: { depth: 2 } })).resolves.toBeTruthy();
  });

  it('masks URL credentials and environments whatever is selected, as with depth', async () => {
    expect(maskEmbeddedCredentials({ u: ['git@x:y', 'https://a:b@h/p', 'ssh://tok@h'], envMap: { K: 'v' } })).toEqual({
      u: ['git@x:y', 'https://[REDACTED]@h/p', 'ssh://[REDACTED]@h'],
      envMap: '[REDACTED]',
    });
    const build = await run('builds.get', { path: { job: DEPLOY, number: 41 }, query: { depth: 1 } });
    const log = await run('builds.log', { path: { job: DEPLOY, number: 41 }, query: { start: 0, lines: 1 } });
    for (const r of [build, log]) {
      expect(JSON.stringify(r)).not.toContain(GIT_SECRET);
      expect(JSON.stringify(r)).not.toContain(ENV_SECRET);
    }
    expect(JSON.stringify(build)).toContain('https://[REDACTED]@git.example.com/infra/deploy.git');
    expect(GIT_URL).toContain(GIT_SECRET);
  });
});

describe('action redirects', () => {
  const base = 'https://ci.lan/jenkins';
  const res = (status: number, location?: string) => ({
    status,
    headers: location === undefined ? {} : { location },
    body: '',
  });

  it('accept a redirect within the base URL only, and never to the sign-in page', () => {
    expect(redirectFailure('https://ci.lan/jenkins/job/a/', base)).toBeUndefined();
    expect(redirectFailure('/jenkins/', base)).toBeUndefined();
    expect(redirectFailure('https://evil.lan/jenkins/', base)).toMatch(/outside the base URL/);
    expect(redirectFailure('https://ci.lan/other/', base)).toMatch(/outside the base URL/);
    expect(redirectFailure('https://ci.lan/jenkins/login?from=%2F', base)).toMatch(/sign-in/);
    expect(redirectFailure('https://ci.lan/jenkins/securityRealm/commenceLogin', base)).toMatch(/sign-in/);
    expect(redirectFailure(undefined, base)).toMatch(/without a location/);
  });

  it('count a read redirect as a failure', () => {
    expect(() => checkStatus(res(302, `${base}/login`), 'GET /api/json')).toThrow(
      expect.objectContaining({ code: ErrorCodes.UpstreamError }),
    );
    expect(() => checkStatus(res(302, `${base}/`), 'POST /safeRestart', base)).not.toThrow();
  });

  it('fail an action Jenkins redirected to sign in', async () => {
    fake.state.redirectTo = `${fake.url}${CONTEXT}/securityRealm/commenceLogin`;
    await expect(run('builds.stop', { path: { job: DEPLOY, number: 42 } })).rejects.toMatchObject({
      code: ErrorCodes.UpstreamError,
      message: expect.stringContaining('sign-in'),
    });
    fake.state.redirectTo = 'http://elsewhere.lan/';
    await expect(run('builds.stop', { path: { job: DEPLOY, number: 42 } })).rejects.toThrow(/outside the base URL/);
  });
});

describe('summaries', () => {
  it('escapes control, bidi and zero-width characters', () => {
    expect(safe('a"\n\u202eb\u200b')).toBe('a\\"\\n\\u202eb\\u200b');
  });
});

describe('Jenkins plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: createJenkinsPlugin(),
      init: connection(),
      samples: [
        { fn: 'call', args: ['jobs.list'], expectKey: 'jobs.list' },
        { fn: 'call', args: ['jobs.delete', { path: { job: HELLO } }], expectKey: 'jobs.delete' },
      ],
      rejects: [
        { fn: 'call', args: ['jobs.nope'] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('reports the version from X-Jenkins and refuses Jenkins 1.x', async () => {
    expect(await plugin.testConnection()).toMatchObject({ ok: true, upstreamVersion: VERSION });
    fake.state.version = '1.651.3';
    expect(await plugin.testConnection()).toMatchObject({ ok: false, message: expect.stringContaining('1.651.3') });
  });

  it('declares exactly the approved operations', () => {
    expect(operations.map((o) => `${o.key} ${o.classification}${o.locked ? ' locked' : ''}`).sort()).toEqual([
      'builds.delete write locked',
      'builds.get read',
      'builds.log read',
      'builds.stop write',
      'builds.testReport read',
      'builds.trigger write',
      'builds.trigger#params write locked',
      'jobs.delete write locked',
      'jobs.disable write locked',
      'jobs.enable write locked',
      'jobs.get read',
      'jobs.list read',
      'nodes.list read',
      'queue.get read',
      'queue.list read',
      'system.cancelQuietDown write locked',
      'system.quietDown write locked',
      'system.safeRestart write locked',
    ]);
  });

  it('lists jobs at the root and in a folder, with the default tree', async () => {
    const root = await run('jobs.list');
    expect(lastRequest().path).toBe(`${CONTEXT}/api/json`);
    expect(lastRequest().query.get('tree')).toBe(settings.plugin.trees['jobs.list']);
    expect(root).toMatchObject({ jobs: [{ fullName: 'infra' }, { fullName: HELLO }] });
    expect(await run('jobs.list', { path: { folder: 'infra' } })).toMatchObject({ jobs: [{ fullName: DEPLOY }] });
    expect(lastRequest().path).toBe(`${CONTEXT}/job/infra/api/json`);
  });

  it("keeps the call's own tree or depth", async () => {
    await run('jobs.get', { path: { job: HELLO }, query: { tree: 'name' } });
    expect(lastRequest().query.get('tree')).toBe('name');
    await run('jobs.get', { path: { job: HELLO }, query: { depth: 1 } });
    expect(lastRequest().query.has('tree')).toBe(false);
  });

  it('masks password parameters in a job and a build', async () => {
    const job = await run('jobs.get', { path: { job: DEPLOY } });
    const build = await run('builds.get', { path: { job: DEPLOY, number: 'lastFailedBuild' } });
    expect(lastRequest().path).toBe(`${CONTEXT}/job/infra/job/deploy%20app/lastFailedBuild/api/json`);
    for (const r of [job, build]) {
      expect(JSON.stringify(r)).not.toContain(BUILD_SECRET);
      expect(JSON.stringify(r)).not.toContain(DEFAULT_SECRET);
      expect(JSON.stringify(r)).toContain('[REDACTED]');
    }
    expect(JSON.stringify(build)).toContain('"value":"main"');
  });

  describe('console log', () => {
    const log = Buffer.from(LOG, 'utf8');
    const p = (query: Record<string, unknown>) => ({ path: { job: DEPLOY, number: 41 }, query });

    it('returns the tail by default, as text with offsets', async () => {
      const r = await run('builds.log', p({ bytes: 30 }));
      expect(lastRequest().query.get('start')).toBe('0');
      expect(r).toMatchObject({ end: log.length, size: log.length, more: false, truncated: false });
      const { text, start } = r as { text: string; start: number };
      expect(LOG.endsWith(text)).toBe(true);
      expect(log.subarray(start).toString('utf8')).toBe(text);
    });

    it('cuts the tail to whole lines and whole characters', async () => {
      expect(await run('builds.log', p({ lines: 2 }))).toMatchObject({ text: 'line 39 ✓\nline 40 ✓\n' });
      // `✓` is three bytes: a cut inside it moves to the next character.
      expect(await run('builds.log', p({ bytes: 2 }))).toMatchObject({ text: '\n' });
    });

    it('reads from an offset, and says when more follows', async () => {
      const first = (await run('builds.log', p({ start: 0, lines: 1 }))) as { text: string; end: number };
      // The clone line's URL credentials are masked; offsets still count Jenkins's bytes.
      expect(first).toMatchObject({
        text: 'Cloning https://[REDACTED]@git.example.com/infra/deploy.git\n',
        start: 0,
        end: Buffer.byteLength(`Cloning ${GIT_URL}\n`),
        truncated: true,
      });
      const next = await run('builds.log', p({ start: first.end, lines: 1 }));
      expect(lastRequest().query.get('start')).toBe(String(first.end));
      expect(next).toMatchObject({ text: 'line 1 ✓\n' });
      expect(await run('builds.log', p({ start: log.length }))).toMatchObject({ text: '', truncated: false });
    });

    it('says a running build has more coming', async () => {
      expect(await run('builds.log', { path: { job: DEPLOY, number: 42 } })).toMatchObject({ more: true });
    });

    it('refuses a start past the end and out-of-range sizes', async () => {
      await expect(run('builds.log', p({ start: log.length + 1 }))).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
      for (const q of [{ bytes: 0 }, { bytes: settings.plugin.log.maxBytes + 1 }, { lines: 1.5 }, { start: -1 }])
        await expect(run('builds.log', p(q))).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    });
  });

  it('follows a triggered build through the queue to its number', async () => {
    const queued = (await run('builds.trigger', { path: { job: DEPLOY }, query: { BRANCH: 'release' } })) as {
      queueId: number;
    };
    expect(lastRequest()).toMatchObject({
      method: 'POST',
      path: `${CONTEXT}/job/infra/job/deploy%20app/buildWithParameters`,
    });
    expect(lastRequest().query.get('BRANCH')).toBe('release');
    expect(queued).toEqual({ job: DEPLOY, queueId: 100 });
    expect(await run('queue.get', { path: { id: queued.queueId } })).not.toHaveProperty('executable');
    expect(await run('queue.get', { path: { id: queued.queueId } })).toMatchObject({ executable: { number: 43 } });
    expect(await run('builds.get', { path: { job: DEPLOY, number: 43 } })).toMatchObject({ result: 'SUCCESS' });
  });

  it('splits a trigger: without parameters a plain write, with any the locked #params twin', async () => {
    expect(await resolve('builds.trigger', { path: { job: DEPLOY } })).toMatchObject({ key: 'builds.trigger' });
    expect(await resolve('builds.trigger', { path: { job: DEPLOY }, query: { BRANCH: 'x' } })).toMatchObject({
      key: 'builds.trigger#params',
    });
    expect(operations.find((o) => o.key === 'builds.trigger')).toMatchObject({ locked: false });
    expect(operations.find((o) => o.key === 'builds.trigger#params')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
    const mismatched = [
      { key: 'builds.trigger', params: { path: { job: DEPLOY }, query: { BRANCH: 'x' } } },
      { key: 'builds.trigger#params', params: { path: { job: DEPLOY } } },
    ];
    for (const m of mismatched)
      await expect(plugin.invoke({ ...m, context })).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
  });

  it('builds a parameterized job with its defaults through /buildWithParameters', async () => {
    expect(await run('builds.trigger', { path: { job: DEPLOY } })).toEqual({ job: DEPLOY, queueId: 100 });
    expect(lastRequest().path).toBe(`${CONTEXT}/job/infra/job/deploy%20app/buildWithParameters`);
  });

  it('triggers a job without parameters through /build', async () => {
    expect(await run('builds.trigger', { path: { job: HELLO } })).toEqual({ job: HELLO, queueId: 100 });
    expect(lastRequest().path).toBe(`${CONTEXT}/job/hello/build`);
  });

  it('refuses unknown and password build parameters before anything is sent', async () => {
    const before = fake.requests.filter((r) => r.method === 'POST').length;
    await expect(resolve('builds.trigger', { path: { job: DEPLOY }, query: { DEPLOY_KEY: 'x' } })).rejects.toThrow(
      /password parameter/,
    );
    await expect(resolve('builds.trigger', { path: { job: DEPLOY }, query: { NOPE: 'x' } })).rejects.toThrow(
      /no parameter NOPE; it takes BRANCH, DEPLOY_KEY/,
    );
    await expect(resolve('builds.trigger', { path: { job: HELLO }, query: { A: '1' } })).rejects.toThrow(
      /takes no parameters/,
    );
    await expect(
      resolve('builds.trigger', { path: { job: DEPLOY }, query: { BRANCH: { nested: true } } }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(before);
  });

  it('refuses query keys that differ only by case', async () => {
    await expect(
      resolve('builds.trigger', { path: { job: DEPLOY }, query: { BRANCH: 'a', branch: 'b' } }),
    ).rejects.toThrow(/only by case/);
    await expect(
      resolve('builds.log', { path: { job: HELLO, number: 7 }, query: { start: 0, Start: 1 } }),
    ).rejects.toThrow();
  });

  it('refuses bodies, unknown query keys, and queries on actions', async () => {
    await expect(resolve('builds.stop', { path: { job: HELLO, number: 7 }, body: {} })).rejects.toThrow(/no body/);
    await expect(resolve('jobs.list', { query: { jsonp: 'x' } })).rejects.toThrow(/takes no query.jsonp/);
    await expect(resolve('jobs.delete', { path: { job: HELLO }, query: { a: 1 } })).rejects.toThrow(/takes no query/);
    await expect(resolve('jobs.get', { path: { job: '../script' } })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
    await expect(resolve('builds.stop', { path: { job: HELLO, number: 'lastBuild' } })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });

  it('stops a build and reads the test report, queue and nodes', async () => {
    expect(await run('builds.stop', { path: { job: DEPLOY, number: 42 } })).toEqual({ ok: true });
    expect(fake.jobs.get(DEPLOY)?.builds.get(42)?.result).toBe('ABORTED');
    expect(await run('builds.testReport', { path: { job: DEPLOY, number: 41 } })).toMatchObject({ failCount: 1 });
    expect(await run('queue.list')).toMatchObject({ items: [] });
    expect(await run('nodes.list')).toMatchObject({ totalExecutors: 2 });
  });

  it('maps a missing job and a denial to upstream errors without the HTML page', async () => {
    await expect(run('jobs.get', { path: { job: 'nope' } })).rejects.toMatchObject({
      code: ErrorCodes.UpstreamError,
      message: expect.stringContaining('HTTP 404'),
    });
    fake.denied.add('/computer/api/json');
    await expect(run('nodes.list')).rejects.toMatchObject({ code: ErrorCodes.UpstreamDenied });
  });

  describe('locked operations', () => {
    it.each(LOCK_CASES)('$key confirms on "$confirm" and shows its target first', async (c) => {
      const { key, params } = await resolve(c.call, c.params);
      expect(key).toBe(c.key);
      const targets = (await plugin.resolveTargets?.({ key, params })) ?? [];
      const summary = await plugin.summarize({ key, params, targets });
      expect(summary.confirmLiteral).toBe(c.confirm);
      expect(summary.text).toBe(`Jenkins ${c.key} ${c.shows}`);
    });

    it('falls back to the names in the call when the job cannot be read', async () => {
      const params = { path: { job: 'gone/job', number: 3 } };
      expect(await plugin.resolveTargets?.({ key: 'builds.delete', params })).toEqual([]);
      expect(await plugin.summarize({ key: 'builds.delete', params, targets: [] })).toEqual({
        text: 'Jenkins builds.delete on job "gone/job" #3: POST /job/gone/job/job/3/doDelete',
        confirmLiteral: 'gone/job#3',
      });
    });

    it('resolves no build target for a build that does not exist', async () => {
      const params = { path: { job: HELLO, number: 99 } };
      expect(await plugin.resolveTargets?.({ key: 'builds.delete', params })).toEqual([]);
    });
  });

  it('summarizes a trigger with its parameters, a secret or unknown one hidden', async () => {
    const params = { path: { job: DEPLOY }, query: { BRANCH: 'x"\u202e', DEPLOY_KEY: 's', OTHER: 'o' } };
    const key = 'builds.trigger#params';
    const targets = (await plugin.resolveTargets?.({ key, params })) ?? [];
    expect(await plugin.summarize({ key, params, targets })).toEqual({
      confirmLiteral: DEPLOY,
      text: `Jenkins builds.trigger#params on ${DEPLOY}: POST /job/infra/job/deploy%20app/buildWithParameters with BRANCH="x\\"\\u202e", DEPLOY_KEY=[REDACTED], OTHER=[REDACTED]`,
    });
  });

  it('reports rejected credentials without throwing', async () => {
    const bad = createJenkinsPlugin();
    await bad.init({ ...connection(), secrets: { token: 'wrong' }, sdkVersion: '1' });
    expect(await bad.testConnection()).toMatchObject({ ok: false, message: expect.stringContaining('denied') });
    await bad.shutdown?.();
  });

  it('refuses a connection without a base URL', async () => {
    await expect(createJenkinsPlugin().init({ ...connection(), config: {}, sdkVersion: '1' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });
});
