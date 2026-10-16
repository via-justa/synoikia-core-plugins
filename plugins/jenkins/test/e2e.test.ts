import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILD_SECRET,
  CONTEXT,
  CREDENTIALS,
  DEFAULT_SECRET,
  DEPLOY,
  ENV_SECRET,
  GIT_SECRET,
  HELLO,
  startFakeJenkins,
  VERSION,
} from './fake-jenkins.js';
import type { FakeJenkins } from './fake-jenkins.js';
import { LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake Jenkins, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeJenkins;

beforeAll(async () => {
  fake = await startFakeJenkins();
  h = await startPluginHarness({
    pluginDir: PLUGIN_DIR,
    connection: { baseUrl: `${fake.url}${CONTEXT}`, ...CREDENTIALS },
  });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

beforeEach(() => fake.reset());

const call = (key: string, params?: unknown) =>
  `return await jenkins.call(${JSON.stringify(key)}${params === undefined ? '' : `, ${JSON.stringify(params)}`});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);

describe('Jenkins end to end (fake Jenkins under /jenkins)', () => {
  it('syncs the declared operations and the version', () => {
    expect(h.operations()).toHaveLength(18);
    expect(h.operation('builds.trigger')).toMatchObject({ locked: false });
    expect(h.operation('builds.trigger#params')).toMatchObject({ locked: true, typedConfirmation: true });
    expect(h.instance()).toMatchObject({ upstreamVersion: VERSION, lastSyncStatus: 'ok' });
    expect(h.operation('system.safeRestart')).toMatchObject({ locked: true, typedConfirmation: true });
  });

  it('reads a failed build: build, log tail and test report at Read', async () => {
    allow('builds.get', 'read');
    const r = await h.execute(
      `const b = await jenkins.call('builds.get', { path: { job: ${JSON.stringify(DEPLOY)}, number: 'lastFailedBuild' } });
       const log = await jenkins.call('builds.log', { path: { job: ${JSON.stringify(DEPLOY)}, number: b.number }, query: { lines: 1 } });
       const t = await jenkins.call('builds.testReport', { path: { job: ${JSON.stringify(DEPLOY)}, number: b.number } });
       return [b.number, b.result, log.text, t.failCount];`,
    );
    expect(r).toMatchObject({ ok: true, value: [41, 'FAILURE', 'line 40 ✓\n', 1] });
  });

  it('triggers a build with parameters once its job name is typed, then follows the queue to the build', async () => {
    allow('builds.trigger', 'ask');
    h.setOperationLevel('builds.trigger#params', 'ask');
    allow('queue.get', 'read');
    const shown: string[] = [];
    let literal: unknown;
    const r = await h.execute(
      `const q = await jenkins.call('builds.trigger', { path: { job: ${JSON.stringify(DEPLOY)} }, query: { BRANCH: 'release' } });
       let item = await jenkins.call('queue.get', { path: { id: q.queueId } });
       if (!item.executable) item = await jenkins.call('queue.get', { path: { id: q.queueId } });
       return item.executable.number;`,
      {
        onApproval: (a) => {
          shown.push(a.message);
          literal = a.pending.confirmLiteral;
          a.approve(DEPLOY);
        },
      },
    );
    h.setOperationLevel('builds.trigger#params', null);
    expect(r).toMatchObject({ ok: true, value: 43 });
    expect(literal).toBe(DEPLOY);
    expect(shown[0]).toContain(
      `on ${DEPLOY}: POST /job/infra/job/deploy%20app/buildWithParameters with BRANCH="release"`,
    );
  });

  it('refuses a password build parameter before it reaches the audit log', async () => {
    allow('builds.trigger', 'ask');
    const posts = () => fake.requests.filter((q) => q.method === 'POST').length;
    const before = posts();
    const r = await h.execute(call('builds.trigger', { path: { job: DEPLOY }, query: { DEPLOY_KEY: BUILD_SECRET } }), {
      onApproval: (a) => a.approve(),
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(posts()).toBe(before);
    expect(JSON.stringify(h.audit({}))).not.toContain(BUILD_SECRET);
  });

  it('refuses a job path that would leave the job tree', async () => {
    allow('jobs.get', 'read');
    for (const job of ['../../script', 'a//b', 'a/./b'])
      await expect(h.execute(call('jobs.get', { path: { job } }))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' },
      });
    expect(fake.requests.some((q) => q.path.includes('script'))).toBe(false);
  });

  describe('every locked operation needs its literal typed', () => {
    it.each(LOCK_CASES)('$key → "$confirm"', async ({ key, call: fn, params, confirm, shows }) => {
      h.setOperationLevel(key, 'ask');
      let literal: unknown;
      let wrongRefused = false;
      const shown: string[] = [];
      const r = await h.execute(call(fn, params), {
        onApproval: (a) => {
          literal = a.pending.confirmLiteral;
          shown.push(a.message);
          try {
            a.approve(`${confirm} (wrong)`);
          } catch {
            wrongRefused = true;
            a.approve(confirm);
          }
        },
      });
      h.setOperationLevel(key, null);
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      expect(wrongRefused).toBe(true);
      expect(literal).toBe(confirm);
      expect(shown[0]).toContain(shows);
    });

    it('and they took effect upstream', async () => {
      for (const c of LOCK_CASES) {
        h.setOperationLevel(c.key, 'ask');
        await h.execute(call(c.call, c.params), { onApproval: (a) => a.approve(c.confirm) });
        h.setOperationLevel(c.key, null);
      }
      expect(fake.jobs.get(DEPLOY)?.builds.has(41)).toBe(false);
      expect(fake.jobs.has(HELLO)).toBe(false);
      expect(fake.state).toMatchObject({ restarting: true, quietingDown: false, quietReason: 'upgrade\u202e tonight' });
    });
  });

  it('refuses a tree naming git remote URLs, and masks them under depth', async () => {
    allow('builds.get', 'read');
    const at = { path: { job: DEPLOY, number: 41 } };
    await expect(
      h.execute(call('builds.get', { ...at, query: { tree: 'actions[remoteUrls]' } })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    const r = await h.execute(call('builds.get', { ...at, query: { depth: 1 } }));
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(GIT_SECRET);
    expect(JSON.stringify(r)).not.toContain(ENV_SECRET);
    await expect(h.execute(call('builds.get', { ...at, query: { depth: 3 } }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAMS' },
    });
  });

  describe('secrets stay masked', () => {
    it('in a build result and a job definition', async () => {
      allow('builds.get', 'read');
      allow('jobs.get', 'read');
      const r = await h.execute(
        `return [await jenkins.call('builds.get', { path: { job: ${JSON.stringify(DEPLOY)}, number: 41 } }),
                 await jenkins.call('jobs.get', { path: { job: ${JSON.stringify(DEPLOY)} } })];`,
      );
      expect(r.ok).toBe(true);
      for (const secret of [BUILD_SECRET, DEFAULT_SECRET]) {
        expect(JSON.stringify(r)).not.toContain(secret);
        expect(JSON.stringify(h.audit({}))).not.toContain(secret);
      }
    });

    it('the API token, everywhere', async () => {
      allow('jobs.list', 'read');
      await h.execute(call('jobs.list'));
      expect(JSON.stringify(h.audit({}))).not.toContain(CREDENTIALS.token);
    });
  });

  it('reports a Jenkins denial as UPSTREAM_DENIED', async () => {
    allow('nodes.list', 'read');
    fake.denied.add('/computer/api/json');
    await expect(h.execute(call('nodes.list'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
  });

  it('reports a rejected token and an unreachable Jenkins cleanly', async () => {
    const base = `${fake.url}${CONTEXT}`;
    await expect(h.testConnection({ baseUrl: base, username: 'synoikia', token: 'wrong' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      h.testConnection({ baseUrl: 'http://127.0.0.1:1', username: 'synoikia', token: 't' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'jobs.list', code: call('jobs.list') },
        write: { key: 'builds.stop', code: call('builds.stop', { path: { job: DEPLOY, number: 42 } }) },
        locked: { key: 'jobs.delete', code: call('jobs.delete', { path: { job: HELLO } }), confirm: HELLO },
        secrets: { code: call('builds.get', { path: { job: DEPLOY, number: 41 } }), values: [BUILD_SECRET] },
      }),
    ).toEqual([]);
    expect(fake.jobs.has(HELLO)).toBe(false);
  });
});
