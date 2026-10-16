import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProfilarrPlugin, settings } from '../src/plugin.js';
import { CREDENTIALS, SPEC_TEXT, startFakeProfilarr, VERSION } from './fake-profilarr.js';
import type { FakeProfilarr } from './fake-profilarr.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

let fake: FakeProfilarr;
const plugin = createProfilarrPlugin();

beforeAll(async () => {
  fake = await startFakeProfilarr();
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const connection = () => ({ instanceId: 'profilarr', config: { baseUrl: fake.url }, secrets: { ...CREDENTIALS } });

describe('Profilarr plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: plugin,
      init: connection(),
      samples: [
        { fn: 'request', args: [{ path: '/arr' }], expectKey: 'GET /arr' },
        { fn: 'request', args: [{ method: 'DELETE', path: '/databases/1' }], expectKey: 'DELETE /databases/{id}' },
      ],
      rejects: [
        { fn: 'request', args: [{ path: '/openapi.json' }] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('syncs the served spec and reports the version from /status', async () => {
    await plugin.init({ ...connection(), sdkVersion: '1' });
    const { upstreamVersion, operations } = await plugin.syncCatalog();
    expect(upstreamVersion).toBe(VERSION);
    expect(operations).toHaveLength(17);
    expect(fake.requests.some((r) => r.path === '/api/v1/openapi.json')).toBe(true);
  });

  it('resolves paths with or without the /api/v1 prefix, and refuses excluded ones', async () => {
    for (const path of ['/databases/3', '/api/v1/databases/3'])
      await expect(plugin.resolveOperation({ fn: 'request', args: [{ path }] })).resolves.toEqual({
        key: 'GET /databases/{id}',
        params: { path: { id: '3' } },
      });
    await expect(
      plugin.resolveOperation({ fn: 'request', args: [{ path: '/backups/backup-1.tar.gz' }] }),
    ).rejects.toMatchObject({ code: ErrorCodes.UnknownOperation });
  });

  it('names the stored database in a locked call, and falls back to the id when the lookup fails', async () => {
    const summary = (id: string, body?: unknown) =>
      plugin.summarize({ key: 'PATCH /databases/{id}', params: { path: { id }, body }, targets: [] });
    // The literal comes from the stored database, not from a name in the body.
    await expect(summary('1', { name: 'Renamed' })).resolves.toMatchObject({ confirmLiteral: 'Dictionarry' });
    await expect(summary('404')).resolves.toMatchObject({ confirmLiteral: '404' });
  });

  it('names the stored database and its repository as the target of non-GET database calls', async () => {
    const targets = (key: string, id: string) => plugin.resolveTargets!({ key, params: { path: { id } } });
    const dictionarry = {
      kind: 'database',
      id: '1',
      name: 'Dictionarry (https://github.com/Dictionarry-Hub/database)',
    };
    await expect(targets('POST /databases/{id}/sync', '1')).resolves.toEqual([dictionarry]);
    await expect(targets('GET /databases/{id}', '1')).resolves.toEqual([]);
    await expect(targets('DELETE /databases/{id}', '404')).resolves.toEqual([]);
    expect(
      await plugin.summarize({ key: 'DELETE /databases/{id}', params: { path: { id: '1' } }, targets: [dictionarry] }),
    ).toEqual({
      text: 'Profilarr DELETE /databases/1 on Dictionarry (https://github.com/Dictionarry-Hub/database)',
      confirmLiteral: 'Dictionarry',
    });
  });

  it('escapes bidi and zero-width characters in the database target and the approval text', async () => {
    fake.databases.set(2, {
      id: 2,
      name: 'Evil\u202egnp',
      repository_url: 'https://example.com/\u2066repo',
      auto_pull: 0,
      personal_access_token: '',
    });
    const targets = await plugin.resolveTargets!({ key: 'POST /databases/{id}/sync', params: { path: { id: '2' } } });
    expect(targets).toEqual([{ kind: 'database', id: '2', name: 'Evil\\u202egnp (https://example.com/\\u2066repo)' }]);
    const { text } = await plugin.summarize({
      key: 'POST /databases/{id}/sync',
      params: { path: { id: '2' }, body: { note: 'a\u200bb' } },
      targets,
    });
    expect(text).not.toMatch(/[\u200b\u202e\u2066]/);
    expect(text).toContain('on Evil\\u202egnp');
    fake.databases.delete(2);
  });

  it('reports a rejected key without throwing', async () => {
    const bad = createProfilarrPlugin();
    await bad.init({ ...connection(), secrets: { apiKey: 'wrong' }, sdkVersion: '1' });
    expect(await bad.testConnection()).toMatchObject({ ok: false });
    await bad.shutdown?.();
  });

  it('refuses a served spec that is not an OpenAPI document, a truncated one, or one missing a lock', async () => {
    const spec = JSON.parse(SPEC_TEXT) as { paths: Record<string, unknown> };
    const { '/databases/{id}/sync': _sync, ...withoutSync } = spec.paths;
    for (const bad of [
      { error: 'Not Found' },
      { openapi: '3.1.0', paths: { '/health': { get: {} } } },
      { ...spec, paths: withoutSync },
    ]) {
      fake.serveSpec(bad);
      await expect(plugin.syncCatalog()).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
    }
    fake.serveSpec(spec);
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ upstreamVersion: VERSION });
  });

  it('refuses a connection without a base URL', async () => {
    await expect(createProfilarrPlugin().init({ ...connection(), config: {}, sdkVersion: '1' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });
});
