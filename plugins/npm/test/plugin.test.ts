import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNpmPlugin, settings } from '../src/plugin.js';
import { CREDENTIALS, EMAIL, PASSWORD, PROXY_HOST, SPEC_TEXT, startFakeNpm } from './fake-npm.js';
import type { FakeNpm } from './fake-npm.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

let fake: FakeNpm;
const plugin = createNpmPlugin();

beforeAll(async () => {
  fake = await startFakeNpm();
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const connection = () => ({
  instanceId: 'npm',
  config: { baseUrl: fake.url, email: EMAIL },
  secrets: { password: PASSWORD },
});
const context = { callId: 'test', deadlineMs: 5000 };

describe('Nginx Proxy Manager plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: plugin,
      init: connection(),
      samples: [
        { fn: 'request', args: [{ path: '/nginx/proxy-hosts' }], expectKey: 'GET /nginx/proxy-hosts' },
        {
          fn: 'request',
          args: [{ method: 'DELETE', path: '/nginx/proxy-hosts/1' }],
          expectKey: 'DELETE /nginx/proxy-hosts/{hostID}',
        },
      ],
      rejects: [
        { fn: 'request', args: [{ path: '/proxy-hosts' }] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('syncs the served spec and reports the version from the health check', async () => {
    await plugin.init({ ...connection(), sdkVersion: '1' });
    const { upstreamVersion, operations } = await plugin.syncCatalog();
    expect(upstreamVersion).toBe('2.16.0');
    expect(operations).toHaveLength(64);
    expect(fake.requests.some((r) => r.path === '/api/schema')).toBe(true);
  });

  it('signs in with the email and password and sends the JWT as a bearer token', async () => {
    const signIn = fake.requests.find((r) => r.method === 'POST' && r.path === '/api/tokens');
    expect(signIn?.body).toEqual({ identity: EMAIL, secret: PASSWORD });
    const read = await plugin.invoke({
      key: 'GET /nginx/proxy-hosts/{hostID}',
      params: { path: { hostID: '1' } },
      context,
    });
    expect(read).toMatchObject({ forward_host: PROXY_HOST.forward_host });
    expect(fake.requests.at(-1)?.headers.authorization).toMatch(/^Bearer jwt-\d+$/);
  });

  it('signs in again once when the token expires, and before it runs out', async () => {
    const before = fake.signIns;
    fake.expireToken();
    await plugin.invoke({ key: 'GET /users', params: {}, context });
    expect(fake.signIns).toBe(before + 1);
    await plugin.invoke({ key: 'GET /users', params: {}, context });
    expect(fake.signIns).toBe(before + 1);

    fake.tokenLifetimeMs = 60_000;
    fake.expireToken();
    await plugin.invoke({ key: 'GET /users', params: {}, context });
    await plugin.invoke({ key: 'GET /users', params: {}, context });
    expect(fake.signIns).toBe(before + 3);
    fake.tokenLifetimeMs = 24 * 60 * 60_000;
  });

  it('resolves paths with or without the /api prefix, and takes the locked twin for raw nginx config', async () => {
    await expect(
      plugin.resolveOperation({ fn: 'request', args: [{ path: '/api/nginx/proxy-hosts/1' }] }),
    ).resolves.toEqual({
      key: 'GET /nginx/proxy-hosts/{hostID}',
      params: { path: { hostID: '1' } },
    });
    await expect(
      plugin.resolveOperation({
        fn: 'request',
        args: [{ method: 'POST', path: '/nginx/dead-hosts', body: { domain_names: ['a.example'] } }],
      }),
    ).resolves.toMatchObject({ key: 'POST /nginx/dead-hosts' });
    await expect(
      plugin.resolveOperation({
        fn: 'request',
        args: [{ method: 'PUT', path: '/nginx/dead-hosts/1', body: { advanced_config: 'return 200;' } }],
      }),
    ).resolves.toMatchObject({ key: 'PUT /nginx/dead-hosts/{hostID}#advanced' });
    await expect(
      plugin.resolveOperation({ fn: 'request', args: [{ path: '/tokens', method: 'POST' }] }),
    ).rejects.toMatchObject({ code: ErrorCodes.UnknownOperation });
  });

  it('names the stored domain in a locked update and shows where traffic would go', async () => {
    expect(
      await plugin.summarize({
        key: 'PUT /nginx/proxy-hosts/{hostID}',
        params: {
          path: { hostID: '1' },
          body: { advanced_config: 'x'.repeat(600), forward_host: '10.6.6.6', forward_port: 80 },
        },
        targets: [],
      }),
    ).toMatchObject({ confirmLiteral: 'app.home.example', text: expect.stringMatching(/\[→ 10\.6\.6\.6:80\]$/) });
    expect(
      await plugin.summarize({
        key: 'DELETE /nginx/proxy-hosts/{hostID}',
        params: { path: { hostID: '404' } },
        targets: [],
      }),
    ).toMatchObject({ confirmLiteral: '404' });
  });

  it('reports a rejected password, and a user with 2FA, without throwing', async () => {
    const bad = createNpmPlugin();
    await bad.init({ ...connection(), secrets: { password: 'wrong' }, sdkVersion: '1' });
    const result = await bad.testConnection();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('wrong');
    fake.twoFactor = true;
    const twoFactor = createNpmPlugin();
    await twoFactor.init({ ...connection(), sdkVersion: '1' });
    expect(await twoFactor.testConnection()).toMatchObject({
      ok: false,
      message: expect.stringContaining('two-factor'),
    });
    fake.twoFactor = false;
    await twoFactor.shutdown?.();
    await bad.shutdown?.();
  });

  it('refuses a served spec that is not OpenAPI, truncated, or missing a locked operation', async () => {
    const renamed = JSON.parse(SPEC_TEXT) as { paths: Record<string, unknown> };
    delete renamed.paths['/users/{userID}/permissions'];
    for (const bad of [{ error: 'Not Found' }, { openapi: '3.1.0', paths: { '/': { get: {} } } }, renamed]) {
      fake.serveSpec(bad);
      await expect(plugin.syncCatalog()).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
    }
    fake.serveSpec(JSON.parse(SPEC_TEXT));
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ upstreamVersion: '2.16.0' });
  });

  it('refuses a connection without a base URL or password', async () => {
    await expect(
      createNpmPlugin().init({ ...connection(), config: { email: EMAIL }, sdkVersion: '1' }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    await expect(createNpmPlugin().init({ ...connection(), secrets: {}, sdkVersion: '1' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
    expect(CREDENTIALS.password).toBe(PASSWORD);
  });
});
