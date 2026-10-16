import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, INSTANCE, SECRETS, startFakeSonarr, TAG, VERSION } from './fake-sonarr.js';
import type { FakeSonarr } from './fake-sonarr.js';
import { LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake Sonarr, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeSonarr;

beforeAll(async () => {
  fake = await startFakeSonarr();
  h = await startPluginHarness({
    pluginDir: PLUGIN_DIR,
    connection: { baseUrl: fake.url, specBaseUrl: fake.specUrl, ...CREDENTIALS },
  });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

beforeEach(() => fake.reset());

const call = (request: unknown) => `return await sonarr.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);
const SECRET_VALUES = Object.values(SECRETS);

describe('Sonarr end to end (fake Sonarr)', () => {
  it('syncs the spec for the instance release', () => {
    expect(h.operations()).toHaveLength(224);
    expect(h.instance()).toMatchObject({ upstreamVersion: VERSION, lastSyncStatus: 'ok' });
    expect(fake.specFetches).toContain(TAG);
    expect(h.operation('DELETE /api/v3/series/{id}#delete-files')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('looks up a series and checks the calendar at Read', async () => {
    allow('GET /api/v3/series/lookup', 'read');
    allow('GET /api/v3/calendar', 'read');
    const r = await h.execute(
      `const [hit] = await sonarr.request({ path: '/api/v3/series/lookup', query: { term: 'andor' } });
       const cal = await sonarr.request({ path: '/api/v3/calendar' });
       return hit.tvdbId + ' ' + cal[0].title;`,
    );
    expect(r).toMatchObject({ ok: true, value: '393189 Good News About Hell' });
  });

  it('runs a quick command once a human approves it at Ask, then polls it', async () => {
    // Both are in the `command` group: the group reads, the POST has its own Ask.
    allow('GET /api/v3/command/{id}', 'read');
    h.setOperationLevel('POST /api/v3/command', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      `const { id } = await sonarr.request({ method: 'POST', path: '/api/v3/command', body: { name: 'SeriesSearch', seriesId: 2 } });
       return (await sonarr.request({ path: '/api/v3/command/' + id })).status;`,
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve();
        },
      },
    );
    h.setOperationLevel('POST /api/v3/command', null);
    expect(r).toMatchObject({ ok: true, value: 'completed' });
    expect(shown[0]).toContain('Sonarr POST /api/v3/command');
  });

  describe('every locked operation needs its literal typed', () => {
    it.each(LOCK_CASES)('$key → "$confirm"', async ({ key, request, confirm }) => {
      h.setOperationLevel(key, 'ask');
      await expect(h.execute(call(request))).resolves.toMatchObject({ ok: false });
      let literal: unknown;
      let wrongRefused = false;
      const shown: string[] = [];
      const r = await h.execute(call(request), {
        onApproval: (a) => {
          literal = a.pending.confirmLiteral;
          shown.push(a.message, JSON.stringify(a.pending));
          try {
            a.approve(`${confirm} (wrong)`);
          } catch {
            wrongRefused = true;
            a.approve(confirm);
          }
        },
      });
      h.setOperationLevel(key, null);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(wrongRefused).toBe(true);
      expect(literal).toBe(confirm);
      const text = shown.join('\n');
      for (const secret of ['sab-key-777777', 'idx-key-888888', 'secret-hook-999999', 'pk-123456', ...SECRET_VALUES])
        expect(text).not.toContain(secret);
      // The approver sees where a provider call sends data.
      if (
        /(downloadclient|indexer|importlist|notification)(\/(test|action)|\/\{id\}|$)/.test(key) &&
        !key.includes('testall')
      )
        expect(shown[0]).toMatch(/→ (https?:\/\/|smtp)/);
    });
  });

  describe('secrets stay masked', () => {
    it.each([
      ['GET /api/v3/config/host', { path: '/api/v3/config/host' }, [SECRETS.hostApiKey, SECRETS.proxyPassword]],
      ['GET /api/v3/downloadclient', { path: '/api/v3/downloadclient' }, [SECRETS.clientPassword]],
      [
        'GET /api/v3/indexer',
        { path: '/api/v3/indexer' },
        [SECRETS.indexerApiKey, SECRETS.trackerPasskey, SECRETS.trackerCookie],
      ],
      ['GET /api/v3/notification', { path: '/api/v3/notification' }, [SECRETS.webhookToken, SECRETS.headerToken]],
      [
        'GET /api/v3/release',
        { path: '/api/v3/release', query: { seriesId: 1 } },
        [
          SECRETS.releaseApiKey,
          SECRETS.magnetPasskey,
          SECRETS.guidPasskey,
          SECRETS.infoPasskey,
          SECRETS.magnetGuidPasskey,
        ],
      ],
      [
        'GET /api/v3/history',
        { path: '/api/v3/history' },
        [SECRETS.guidPasskey, SECRETS.infoPasskey, SECRETS.grabPasskey, SECRETS.magnetGuidPasskey],
      ],
    ])('%s', async (key, request, secrets) => {
      allow(key, 'read');
      const r = await h.execute(call(request));
      expect(r.ok).toBe(true);
      for (const secret of secrets) expect(JSON.stringify(r)).not.toContain(secret);
    });

    it('keeps provider credentials and webhook tokens out of the approval and the audit log', async () => {
      const key = 'POST /api/v3/notification';
      const hook = 'https://hooks.example.com/t/new-hook-token-121212';
      h.setOperationLevel(key, 'ask');
      const shown: string[] = [];
      const r = await h.execute(
        call({
          method: 'POST',
          path: '/api/v3/notification',
          body: { name: 'Hook', implementation: 'Webhook', fields: [{ name: 'url', value: hook }] },
        }),
        {
          onApproval: (a) => {
            shown.push(a.message, JSON.stringify(a.pending));
            a.approve('Hook');
          },
        },
      );
      h.setOperationLevel(key, null);
      expect(r.ok).toBe(true);
      expect(shown[0]).toContain('→ https://hooks.example.com');
      expect(shown.join('\n')).not.toContain('new-hook-token-121212');
      expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain('new-hook-token-121212');
    });

    it('refuses to write back a masked value', async () => {
      h.setOperationLevel('PUT /api/v3/config/host/{id}', 'ask');
      const r = await h.execute(
        call({ method: 'PUT', path: '/api/v3/config/host/1', body: { id: 1, password: '[REDACTED]' } }),
      );
      h.setOperationLevel('PUT /api/v3/config/host/{id}', null);
      expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    });
  });

  it('reports a Sonarr denial as UPSTREAM_DENIED', async () => {
    allow('GET /api/v3/queue', 'read');
    fake.denied.add('/api/v3/queue');
    await expect(h.execute(call({ path: '/api/v3/queue' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/api/v3/queue');
  });

  it('reports a rejected key and an unreachable Sonarr cleanly', async () => {
    await expect(
      h.testConnection({ baseUrl: fake.url, specBaseUrl: fake.specUrl, apiKey: 'wrong' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(h.testConnection({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /api/v3/tag', code: call({ path: '/api/v3/tag' }) },
        write: { key: 'POST /api/v3/tag', code: call({ method: 'POST', path: '/api/v3/tag', body: { label: 'new' } }) },
        locked: {
          key: 'POST /api/v3/system/restart',
          code: call({ method: 'POST', path: '/api/v3/system/restart' }),
          confirm: INSTANCE,
        },
        secrets: { code: call({ path: '/api/v3/config/host' }), values: [SECRETS.hostApiKey] },
      }),
    ).toEqual([]);
  });
});
