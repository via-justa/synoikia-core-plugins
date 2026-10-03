import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes, parseManifest } from '@synoikia/plugin-sdk';
import type { InitParams, PluginHandlers } from '@synoikia/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createSeerrPlugin } from '../src/plugin.js';
import { FAKE_API_KEY, FAKE_EMAIL, FAKE_PASSWORD, startFakeSeerr } from './fake-seerr.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(opts: { apiKey?: boolean } = {}) {
  const fake = await startFakeSeerr();
  cleanup.push(() => fake.close());
  const plugin = createSeerrPlugin();
  cleanup.push(() => plugin.shutdown?.());
  const init: Omit<InitParams, 'sdkVersion'> = opts.apiKey
    ? {
        instanceId: 'seerr',
        config: { baseUrl: fake.url, authMethod: 'apiKey', specBaseUrl: fake.specUrl },
        secrets: { apiKey: FAKE_API_KEY },
      }
    : {
        instanceId: 'seerr',
        config: { baseUrl: fake.url, authMethod: 'local', email: FAKE_EMAIL, specBaseUrl: fake.specUrl },
        secrets: { password: FAKE_PASSWORD },
      };
  await plugin.init({ ...init, sdkVersion: '1.0.0' });
  return { fake, plugin, init };
}

const resolve = (plugin: PluginHandlers, req: Record<string, unknown>) =>
  plugin.resolveOperation({ fn: 'request', args: [req] });

const invoke = (plugin: PluginHandlers, key: string, params: unknown) =>
  plugin.invoke({ key, params, context: { callId: 'c1', deadlineMs: 5000 } });

describe('Seerr plugin', () => {
  it('passes the SDK conformance checks against a (fake) Seerr', async () => {
    const { plugin, init } = await setup();
    const issues = await checkConformance({
      manifest,
      handlers: plugin,
      init,
      samples: [
        { fn: 'request', args: [{ method: 'GET', path: '/request' }], expectKey: 'GET /request' },
        { fn: 'request', args: [{ path: '/movie/603' }], expectKey: 'GET /movie/{movieId}' },
        {
          fn: 'request',
          args: [{ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 603 } }],
          expectKey: 'POST /request',
        },
        { fn: 'request', args: [{ method: 'DELETE', path: '/user/14' }], expectKey: 'DELETE /user/{userId}' },
        {
          fn: 'request',
          args: [{ method: 'GET', path: '/settings/discover/reset' }],
          expectKey: 'GET /settings/discover/reset',
        },
        {
          fn: 'request',
          args: [{ method: 'POST', path: '/request/8/approve' }],
          expectKey: 'POST /request/{requestId}/{status}',
        },
        {
          fn: 'request',
          args: [{ method: 'POST', path: '/request/7/approve' }],
          expectKey: 'POST /request/{requestId}/{status}#on-behalf',
        },
        {
          fn: 'request',
          args: [{ method: 'POST', path: '/settings/plex/sync', body: { start: true } }],
          expectKey: 'POST /settings/plex/sync#start',
        },
        {
          fn: 'request',
          args: [{ method: 'POST', path: '/settings/plex/sync', body: { cancel: true } }],
          expectKey: 'POST /settings/plex/sync',
        },
        {
          fn: 'request',
          args: [{ method: 'POST', path: '/settings/jobs/plex-full-scan/run' }],
          expectKey: 'POST /settings/jobs/{jobId}/run#start',
        },
      ],
      rejects: [
        { fn: 'request', args: [{ method: 'GET', path: '/nope' }] },
        { fn: 'request', args: [{ method: 'GET', path: '/user/../settings/main' }] },
        { fn: 'request', args: [{ method: 'GET', path: '/request?take=5' }] },
        { fn: 'request', args: [{ method: 'TRACE', path: '/request' }] },
        { fn: 'request', args: [{ method: 'GET', path: 'request' }] },
        { fn: 'request', args: ['GET /request'] },
        { fn: 'call', args: [{ path: '/request' }] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('syncs the catalog from the spec matching the instance version', async () => {
    const { plugin, fake } = await setup();
    const result = await plugin.syncCatalog();
    expect(result).toMatchObject({ upstreamVersion: '3.4.1', sourceRef: 'v3.4.1' });
    expect(result.operations.length).toBe(216);
    fake.version = '3.5.0-develop';
    expect((await plugin.syncCatalog()).sourceRef).toBe('develop');
  });

  it('keeps the catalog it has when a fetched spec is invalid', async () => {
    const { plugin, fake } = await setup();
    await plugin.syncCatalog();
    fake.specText = 'openapi: 3.0.2\npaths: {}\n';
    await expect(plugin.syncCatalog()).rejects.toMatchObject({
      code: ErrorCodes.UpstreamError,
      message: expect.stringMatching(/refusing a partial catalog \(v3\.4\.1\)/),
    });
    expect((await resolve(plugin, { path: '/request' })).key).toBe('GET /request');
  });

  it('tests the credentials, not just reachability', async () => {
    const { plugin, fake } = await setup();
    expect(await plugin.testConnection()).toEqual({ ok: true, upstreamVersion: '3.4.1' });
    await plugin.init({
      instanceId: 'seerr',
      config: { baseUrl: fake.url, email: FAKE_EMAIL },
      secrets: { password: 'wrong' },
      sdkVersion: '1.0.0',
    });
    expect(await plugin.testConnection()).toMatchObject({ ok: false, message: expect.stringMatching(/rejected/) });
  });

  it('defaults to a local user and shows only the fields for the chosen sign-in method', () => {
    const { connection } = parseManifest(manifest);
    const props = connection.schema.properties as Record<string, { default?: unknown }>;
    expect(props.authMethod?.default).toBe('local');
    const shownFor = (method: string) =>
      Object.entries(connection.ui)
        .filter(([, ui]) => !ui.showWhen || ui.showWhen.in.includes(method))
        .map(([name]) => name);
    expect(shownFor('local')).toEqual(['baseUrl', 'authMethod', 'email', 'password', 'specBaseUrl']);
    expect(shownFor('apiKey')).toEqual(['baseUrl', 'authMethod', 'apiKey', 'actAsUserId', 'specBaseUrl']);
  });

  it('requires the fields of the chosen sign-in method', async () => {
    const plugin = createSeerrPlugin();
    const init = async (config: Record<string, unknown>, secrets: Record<string, string>) =>
      plugin.init({ instanceId: 'x', config, secrets, sdkVersion: '1.0.0' });
    await expect(init({}, {})).rejects.toThrow(/baseUrl/);
    await expect(init({ baseUrl: 'https://s' }, { password: 'p' })).rejects.toThrow(/email/);
    await expect(init({ baseUrl: 'https://s', email: 'a@b' }, {})).rejects.toThrow(/password/);
    await expect(init({ baseUrl: 'https://s', authMethod: 'apiKey' }, {})).rejects.toThrow(/apiKey/);
    await expect(init({ baseUrl: 'https://s', authMethod: 'apiKey' }, { apiKey: 'k' })).resolves.toBeUndefined();
  });

  it('splits params into path, query and body', async () => {
    const { plugin } = await setup();
    expect(
      await resolve(plugin, {
        method: 'put',
        path: '/api/v1/request/7',
        query: { a: 1 },
        body: { mediaType: 'movie' },
      }),
    ).toEqual({
      key: 'PUT /request/{requestId}',
      params: { path: { requestId: '7' }, query: { a: 1 }, body: { mediaType: 'movie' } },
    });
    // A GET never carries a body; empty parts are left out so strict rules see only what was sent.
    expect(await resolve(plugin, { path: '/request', query: {}, body: { x: 1 } })).toEqual({
      key: 'GET /request',
      params: {},
    });
  });

  it('makes the is4k default explicit on media requests, so a "4K: no" rule can match', async () => {
    const { plugin } = await setup();
    expect(
      await resolve(plugin, { method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 1 } }),
    ).toEqual({
      key: 'POST /request',
      params: { body: { mediaType: 'movie', mediaId: 1, is4k: false } },
    });
    expect(
      (await resolve(plugin, { method: 'POST', path: '/request', body: { mediaType: 'tv', mediaId: 1, is4k: true } }))
        .params,
    ).toEqual({ body: { mediaType: 'tv', mediaId: 1, is4k: true } });
  });

  it('locks a full library scan whenever `start` could be truthy (fail closed)', async () => {
    const { plugin } = await setup();
    const key = async (body?: unknown) =>
      (
        await resolve(plugin, {
          method: 'POST',
          path: '/settings/jellyfin/sync',
          ...(body === undefined ? {} : { body }),
        })
      ).key;
    for (const body of [{ start: true }, { start: 1 }, { start: 'true' }, { start: null }, 'start', ['start']])
      expect(await key(body), JSON.stringify(body)).toBe('POST /settings/jellyfin/sync#start');
    for (const body of [undefined, { cancel: true }, { start: false }, {}])
      expect(await key(body), JSON.stringify(body)).toBe('POST /settings/jellyfin/sync');
  });

  it('keeps the library GETs on their locked key whatever the query, and says what they do', async () => {
    const { plugin } = await setup();
    for (const server of ['plex', 'jellyfin']) {
      const base = `GET /settings/${server}/library`;
      for (const query of [undefined, { enable: '1,2' }, { Enable: '1' }, { 'enable[]': '1' }, { sync: 'true' }])
        expect(
          (await resolve(plugin, { method: 'GET', path: `/settings/${server}/library`, ...(query ? { query } : {}) }))
            .key,
          JSON.stringify(query),
        ).toBe(base);
    }
    const summary = await plugin.summarize({ key: 'GET /settings/plex/library', params: {}, targets: [] });
    expect(summary.text).toContain('libraries not listed in `enable` are disabled');
    expect(summary.confirmLiteral).toBeTruthy();
  });

  it('locks running a full scan, or any heavy or unknown job, through the jobs endpoint', async () => {
    const { plugin } = await setup();
    const key = async (jobId: string) =>
      (await resolve(plugin, { method: 'POST', path: `/settings/jobs/${jobId}/run` })).key;
    for (const job of [
      'plex-full-scan',
      'jellyfin-full-scan',
      'availability-sync',
      'download-sync-reset',
      'some-future-job',
    ])
      expect(await key(job), job).toBe('POST /settings/jobs/{jobId}/run#start');
    for (const job of ['radarr-scan', 'plex-recently-added-scan', 'download-sync'])
      expect(await key(job), job).toBe('POST /settings/jobs/{jobId}/run');
  });

  it('locks approving a request someone else filed, and fails closed when that is unknown', async () => {
    const { plugin, fake } = await setup();
    // Request 8 was filed by the plugin's own user; 7 by Alex.
    expect((await resolve(plugin, { method: 'POST', path: '/request/8/decline' })).key).toBe(
      'POST /request/{requestId}/{status}',
    );
    expect((await resolve(plugin, { method: 'POST', path: '/request/7/approve' })).key).toBe(
      'POST /request/{requestId}/{status}#on-behalf',
    );
    expect((await resolve(plugin, { method: 'POST', path: '/request/999/approve' })).key).toMatch(/#on-behalf$/);
    fake.denied.add('/auth/me');
    const other = createSeerrPlugin();
    cleanup.push(() => other.shutdown?.());
    await other.init({
      instanceId: 's',
      config: { baseUrl: fake.url, email: FAKE_EMAIL, specBaseUrl: fake.specUrl },
      secrets: { password: FAKE_PASSWORD },
      sdkVersion: '1.0.0',
    });
    expect((await resolve(other, { method: 'POST', path: '/request/8/approve' })).key).toMatch(/#on-behalf$/);
  });

  it('asks for the name of what a locked operation affects', async () => {
    const { plugin } = await setup();
    const literal = async (req: Record<string, unknown>) => {
      const r = await resolve(plugin, req);
      return (await plugin.summarize({ key: r.key, params: r.params, targets: [] })).confirmLiteral;
    };
    expect(await literal({ method: 'DELETE', path: '/user/14' })).toBe('alex@example.com');
    expect(await literal({ method: 'DELETE', path: '/user/404' })).toBe('404');
    expect(await literal({ method: 'DELETE', path: '/settings/radarr/0' })).toBe('Radarr 4K');
    expect(await literal({ method: 'DELETE', path: '/settings/discover/3' })).toBe('Trending');
    expect(await literal({ method: 'POST', path: '/request/7/approve' })).toBe('Alex');
    expect(await literal({ method: 'POST', path: '/settings/main/regenerate' })).toBe('Home Seerr');
    expect(await literal({ method: 'GET', path: '/settings/discover/reset' })).toBe('Home Seerr');
    expect(await literal({ method: 'POST', path: '/settings/plex/sync', body: { start: true } })).toBe('Home Seerr');
    expect(await literal({ method: 'POST', path: '/settings/jobs/plex-full-scan/run' })).toBe('plex-full-scan');
    expect(
      await literal({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 1 } }),
    ).toBeUndefined();
    const summary = await plugin.summarize({
      key: 'POST /request/{requestId}/{status}#on-behalf',
      params: { path: { requestId: '7', status: 'approve' } },
      targets: [],
    });
    expect(summary.text).toBe("Seerr POST /request/7/approve (another user's request)");
  });

  it('invokes the call with the template filled in, query and body', async () => {
    const { plugin, fake } = await setup();
    const created = await invoke(plugin, 'POST /request', { body: { mediaType: 'tv', mediaId: 1399, is4k: true } });
    expect(created).toMatchObject({ is4k: true, media: { mediaType: 'tv' } });
    await invoke(plugin, 'POST /request/{requestId}/{status}#on-behalf', {
      path: { requestId: '7', status: 'approve' },
    });
    expect(fake.requests.get(7)?.status).toBe(2);
    await invoke(plugin, 'GET /request', { query: { take: 5, filter: 'all' } });
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'GET',
      path: '/request',
      query: { take: ['5'], filter: ['all'] },
    });
    await expect(invoke(plugin, 'GET /user/{userId}', {})).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    await expect(invoke(plugin, 'GET /nope', {})).rejects.toMatchObject({ code: ErrorCodes.UnknownOperation });
  });

  it('surfaces a permission denial as UPSTREAM_DENIED', async () => {
    const { plugin, fake } = await setup({ apiKey: true });
    fake.denied.add('/settings/main');
    await expect(invoke(plugin, 'GET /settings/main', {})).rejects.toMatchObject({ code: ErrorCodes.UpstreamDenied });
  });

  it('works after a restart without a fresh sync (the spec is fetched on demand)', async () => {
    const { plugin, fake } = await setup();
    expect(await resolve(plugin, { path: '/movie/603' })).toEqual({
      key: 'GET /movie/{movieId}',
      params: { path: { movieId: '603' } },
    });
    expect(await invoke(plugin, 'GET /movie/{movieId}', { path: { movieId: '603' } })).toEqual({
      id: 603,
      title: 'The Matrix',
    });
    expect(fake.specFetches).toEqual(['v3.4.1']);
  });
});
