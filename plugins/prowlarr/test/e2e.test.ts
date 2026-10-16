import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, INSTANCE, SECRETS, startFakeProwlarr, TAG, VERSION } from './fake-prowlarr.js';
import type { FakeProwlarr } from './fake-prowlarr.js';
import { BODY_SECRETS, LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake Prowlarr, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeProwlarr;

beforeAll(async () => {
  fake = await startFakeProwlarr();
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

const call = (request: unknown) => `return await prowlarr.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);
const SECRET_VALUES = Object.values(SECRETS);

describe('Prowlarr end to end (fake Prowlarr)', () => {
  it('syncs the spec for the instance release', () => {
    expect(h.operations()).toHaveLength(118);
    expect(h.instance()).toMatchObject({ upstreamVersion: VERSION, lastSyncStatus: 'ok' });
    expect(fake.specFetches).toContain(TAG);
    expect(h.operation('POST /api/v1/applications/test#stored')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('searches across indexers and reads their stats at Read, with links masked', async () => {
    allow('GET /api/v1/search', 'read');
    allow('GET /api/v1/indexerstats', 'read');
    const r = await h.execute(
      `const hits = await prowlarr.request({ path: '/api/v1/search', query: { query: 'dune', type: 'search' } });
       const stats = await prowlarr.request({ path: '/api/v1/indexerstats' });
       return { titles: hits.map((x) => x.title), hits, grabs: stats.indexers[0].numberOfGrabs };`,
    );
    expect(r).toMatchObject({
      ok: true,
      value: { titles: ['Dune.2021.2160p', 'Dune.2021.1080p', 'Dune.2021.720p'], grabs: 3 },
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRETS.hostApiKey);
    expect(text).not.toContain(SECRETS.trackerPasskey);
    expect(text).not.toContain(SECRETS.magnetGuidPasskey);
    expect(text).toContain('nzbgeek-guid-1');
    expect(text).toContain('"commentUrl":"https://privatehd.example/[REDACTED]"');
  });

  it('runs a quick command once a human approves it at Ask, then polls it', async () => {
    allow('GET /api/v1/command/{id}', 'read');
    h.setOperationLevel('POST /api/v1/command', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      `const { id } = await prowlarr.request({ method: 'POST', path: '/api/v1/command', body: { name: 'CheckHealth' } });
       return (await prowlarr.request({ path: '/api/v1/command/' + id })).status;`,
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve();
        },
      },
    );
    h.setOperationLevel('POST /api/v1/command', null);
    expect(r).toMatchObject({ ok: true, value: 'completed' });
    expect(shown[0]).toContain('Prowlarr POST /api/v1/command');
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
      for (const secret of [...BODY_SECRETS, ...SECRET_VALUES]) expect(text).not.toContain(secret);
      // The approver sees where a provider call sends data.
      if (
        /(downloadclient|indexer|indexerproxy|notification|applications)(\/(test|action)|\/\{id\}|$)/.test(key) &&
        !key.includes('testall')
      )
        expect(shown[0]).toMatch(/→ https?:\/\//);
    });
  });

  describe('secrets stay masked', () => {
    it.each([
      ['GET /api/v1/config/host', { path: '/api/v1/config/host' }, [SECRETS.hostApiKey, SECRETS.proxyPassword]],
      ['GET /api/v1/downloadclient', { path: '/api/v1/downloadclient' }, [SECRETS.clientPassword]],
      [
        'GET /api/v1/indexer',
        { path: '/api/v1/indexer' },
        [
          SECRETS.indexerApiKey,
          SECRETS.trackerPasskey,
          SECRETS.trackerCookie,
          SECRETS.cardigannPassword,
          SECRETS.twoFactor,
          SECRETS.trackerPid,
        ],
      ],
      ['GET /api/v1/applications', { path: '/api/v1/applications' }, [SECRETS.appApiKey]],
      ['GET /api/v1/indexerproxy', { path: '/api/v1/indexerproxy' }, [SECRETS.socksPassword]],
      ['GET /api/v1/notification', { path: '/api/v1/notification' }, [SECRETS.webhookToken, SECRETS.headerToken]],
      [
        'GET /api/v1/history',
        { path: '/api/v1/history' },
        [SECRETS.indexerApiKey, SECRETS.trackerPasskey, SECRETS.grabPasskey, SECRETS.infoPasskey],
      ],
    ])('%s', async (key, request, secrets) => {
      allow(key, 'read');
      const r = await h.execute(call(request));
      expect(r.ok).toBe(true);
      for (const secret of secrets) expect(JSON.stringify(r)).not.toContain(secret);
    });

    it("keeps an application's API key and a webhook token out of the approval and the audit log", async () => {
      const key = 'POST /api/v1/applications';
      h.setOperationLevel(key, 'ask');
      const shown: string[] = [];
      const r = await h.execute(
        call({
          method: 'POST',
          path: '/api/v1/applications',
          body: {
            name: 'Radarr',
            implementation: 'Radarr',
            fields: [
              { name: 'prowlarrUrl', value: 'http://prowlarr.lan:9696' },
              { name: 'baseUrl', value: 'http://radarr.lan:7878' },
              { name: 'apiKey', value: 'new-app-key-141414', privacy: 'apiKey' },
            ],
          },
        }),
        {
          onApproval: (a) => {
            shown.push(a.message, JSON.stringify(a.pending));
            a.approve('Radarr');
          },
        },
      );
      h.setOperationLevel(key, null);
      expect(r.ok).toBe(true);
      expect(shown[0]).toContain('→ http://prowlarr.lan:9696, http://radarr.lan:7878');
      expect(shown.join('\n')).not.toContain('new-app-key-141414');
      expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain('new-app-key-141414');
    });

    it('refuses to write back a masked value', async () => {
      h.setOperationLevel('PUT /api/v1/config/host/{id}', 'ask');
      const r = await h.execute(
        call({ method: 'PUT', path: '/api/v1/config/host/1', body: { id: 1, password: '[REDACTED]' } }),
      );
      h.setOperationLevel('PUT /api/v1/config/host/{id}', null);
      expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    });
  });

  it('reports a Prowlarr denial as UPSTREAM_DENIED', async () => {
    allow('GET /api/v1/history', 'read');
    fake.denied.add('/api/v1/history');
    await expect(h.execute(call({ path: '/api/v1/history' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/api/v1/history');
  });

  it('reports a rejected key and an unreachable Prowlarr cleanly', async () => {
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
        read: { key: 'GET /api/v1/tag', code: call({ path: '/api/v1/tag' }) },
        write: { key: 'POST /api/v1/tag', code: call({ method: 'POST', path: '/api/v1/tag', body: { label: 'new' } }) },
        locked: {
          key: 'POST /api/v1/system/restart',
          code: call({ method: 'POST', path: '/api/v1/system/restart' }),
          confirm: INSTANCE,
        },
        secrets: { code: call({ path: '/api/v1/config/host' }), values: [SECRETS.hostApiKey] },
      }),
    ).toEqual([]);
  });
});
