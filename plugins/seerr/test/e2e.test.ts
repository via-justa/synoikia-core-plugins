import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_EMAIL, FAKE_PASSWORD, startFakeSeerr } from './fake-seerr.js';
import type { FakeSeerr } from './fake-seerr.js';

/**
 * The real core running this plugin's built bundle (a permission-confined child) against a fake Seerr
 * over HTTP, spec included, through core's plugin harness (design §13 phase 18).
 */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeSeerr;

beforeAll(async () => {
  fake = await startFakeSeerr();
  h = await startPluginHarness({
    pluginDir: PLUGIN_DIR,
    connection: {
      baseUrl: fake.url,
      authMethod: 'local',
      email: FAKE_EMAIL,
      password: FAKE_PASSWORD,
      specBaseUrl: fake.specUrl,
    },
  });
}, 30_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

describe('Seerr plugin end to end (fake Seerr)', () => {
  it('syncs the spec for the instance version into groups that start at Read', () => {
    expect(h.operations()).toHaveLength(216);
    expect(h.operation('GET /settings/discover/reset')).toMatchObject({ locked: true });
    expect(h.operation('POST /request/{requestId}/{status}#on-behalf')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
    expect(h.instance()).toMatchObject({ upstreamVersion: '3.4.1', sourceRef: 'v3.4.1', lastSyncStatus: 'ok' });
  });

  it('runs reads at Read, redacts settings secrets, and hides writes', async () => {
    await expect(h.execute(`return (await seerr.request({ path: '/movie/603' })).title;`)).resolves.toMatchObject({
      ok: true,
      value: 'The Matrix',
    });
    const settings = await h.execute(
      `return await Promise.all(['/settings/main', '/settings/notifications/telegram', '/settings/notifications/webhook', '/settings/radarr'].map((path) => seerr.request({ path })));`,
    );
    for (const s of [
      'seerr-main-api-key-123',
      'tg-bot-secret-456',
      'hooks.example/secret-789',
      'hook-secret-000',
      'radarr-key-111',
    ])
      expect(JSON.stringify(settings)).not.toContain(s);
    expect(settings).toMatchObject({
      ok: true,
      value: [
        { applicationTitle: 'Home Seerr', apiKey: '[REDACTED]' },
        { options: { botAPI: '[REDACTED]', chatId: '42' } },
        { options: { webhookUrl: '[REDACTED]', authHeader: '[REDACTED]' } },
        [{ name: 'Radarr 4K', apiKey: '[REDACTED]' }],
      ],
    });
    // At Read a group's writes are off (new groups start at Ask in newer core).
    h.setGroupLevel('request', 'read');
    await expect(
      h.execute(
        `return await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 1 } });`,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_DISABLED' } });
  });

  it('never runs the library GETs as reads: they save the enabled-library list', async () => {
    h.setGroupLevel('settings', 'read');
    expect(h.operation('GET /settings/plex/library')).toMatchObject({ locked: true, classification: 'write' });
    for (const call of [
      `seerr.request({ method: 'GET', path: '/settings/plex/library' })`,
      `seerr.request({ method: 'GET', path: '/settings/jellyfin/library', query: { Enable: '1' } })`,
    ])
      await expect(h.execute(`return await ${call};`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'OPERATION_DISABLED' },
      });
  });

  it('asks for a media request at Ask and runs it once a human approves', async () => {
    h.setGroupLevel('request', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      `return (await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 550 } })).media;`,
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve();
        },
      },
    );
    expect(r).toMatchObject({ ok: true, value: { mediaType: 'movie', tmdbId: 550 } });
    expect(shown[0]).toContain('Seerr POST /request {"mediaType":"movie","mediaId":550,"is4k":false}');
  });

  it('auto-approves standard-quality requests under a media-request rule, and asks for 4K', async () => {
    h.addRule({
      operation: 'POST /request',
      match: [
        { field: '/body/is4k', op: 'bool', value: false },
        { field: '/body/mediaType', op: 'in', value: ['movie'] },
        { field: '/body/mediaId', op: 'any' },
      ],
      reason: 'standard movie requests',
    });
    const standard = await h.execute(
      `return (await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 551 } })).is4k;`,
    );
    expect(standard).toMatchObject({ ok: true, value: false });
    // 4K doesn't match the rule, so a human is asked (and here, nobody can be).
    const uhd = await h.execute(
      `return await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 552, is4k: true } });`,
    );
    expect(uhd).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(h.audit({ operationKey: 'POST /request' }).map((a) => a.decision)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^auto-approved:rule:/), 'human-approved', 'denied']),
    );
  });

  it("needs the requester's name typed to approve someone else's request (locked)", async () => {
    h.setOperationLevel('POST /request/{requestId}/{status}#on-behalf', 'ask');
    const attempts: string[] = [];
    const r = await h.execute(`return (await seerr.request({ method: 'POST', path: '/request/7/approve' })).status;`, {
      onApproval: (a) => {
        try {
          a.approve('7');
        } catch (err) {
          attempts.push((err as Error).message);
          a.approve('Alex');
        }
      },
    });
    expect(attempts[0]).toMatch(/Type "Alex" exactly/);
    expect(r).toMatchObject({ ok: true, value: 2 });
    // Approving the plugin's own request is the ordinary key, which is at Ask via the group.
    const own = await h.execute(
      `return (await seerr.request({ method: 'POST', path: '/request/8/approve' })).status;`,
      {
        onApproval: (a) => a.approve(),
      },
    );
    expect(own).toMatchObject({ ok: true, value: 2 });
  });

  it('reports a Seerr permission denial as UPSTREAM_DENIED', async () => {
    fake.denied.add('/settings/main');
    await expect(h.execute(`return await seerr.request({ path: '/settings/main' });`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/settings/main');
  });

  it('loads under the permission model and reports an unreachable Seerr cleanly', async () => {
    await expect(
      // A new address needs every stored secret entered again, as in the portal.
      h.testConnection({ baseUrl: 'http://127.0.0.1:1', authMethod: 'apiKey', apiKey: 'k', password: 'p' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /movie/{movieId}', code: `return await seerr.request({ path: '/movie/603' });` },
        write: {
          key: 'POST /request',
          code: `return await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 2 } });`,
        },
        locked: {
          key: 'DELETE /user/{userId}',
          code: `return await seerr.request({ method: 'DELETE', path: '/user/14' });`,
          confirm: 'alex@example.com',
        },
        secrets: {
          code: `return await seerr.request({ path: '/settings/main' });`,
          values: ['seerr-main-api-key-123'],
        },
      }),
    ).toEqual([]);
    expect(fake.users.has(14)).toBe(false);
  });
});
