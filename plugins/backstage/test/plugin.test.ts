import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBackstagePlugin, settings } from '../src/plugin.js';
import { parseEntityRef } from '../src/targets.js';
import {
  CREDENTIALS,
  LOCATION_ID,
  LOCATION_TARGET,
  PETSTORE_UID,
  SPECS,
  startFakeBackstage,
  TASK_ID,
  VERSION,
} from './fake-backstage.js';
import type { FakeBackstage } from './fake-backstage.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

let fake: FakeBackstage;
const plugin = createBackstagePlugin();

beforeAll(async () => {
  fake = await startFakeBackstage();
});
beforeEach(() => fake.reset());
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const connection = (config: Record<string, unknown> = {}) => ({
  instanceId: 'backstage',
  config: { baseUrl: fake.url, ...config },
  secrets: { ...CREDENTIALS },
});

describe('Backstage plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: plugin,
      init: connection(),
      samples: [
        { fn: 'request', args: [{ path: '/api/catalog/entities' }], expectKey: 'GET /api/catalog/entities' },
        {
          fn: 'request',
          args: [{ method: 'DELETE', path: `/api/catalog/locations/${LOCATION_ID}` }],
          expectKey: 'DELETE /api/catalog/locations/{id}',
        },
      ],
      rejects: [
        { fn: 'request', args: [{ path: '/api/catalog/openapi.json' }] },
        { fn: 'request', args: [{ path: '/api/notifications/abc' }] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('merges every plugin spec and reports the catalog spec version', async () => {
    await plugin.init({ ...connection(), sdkVersion: '1' });
    const { upstreamVersion, operations } = await plugin.syncCatalog();
    expect(upstreamVersion).toBe(VERSION);
    expect(operations).toHaveLength(41);
    for (const id of ['catalog', 'scaffolder', 'search', 'events', 'notifications'])
      expect(fake.requests.some((r) => r.path === `/api/${id}/openapi.json`)).toBe(true);
  });

  it('loads only the configured plugins', async () => {
    const some = createBackstagePlugin();
    await some.init({ ...connection({ pluginIds: ['search', 'catalog'] }), sdkVersion: '1' });
    const { operations } = await some.syncCatalog();
    expect(new Set(operations.map((o) => o.key.split('/')[2]))).toEqual(new Set(['catalog', 'search']));
    await some.shutdown?.();
  });

  it('skips a plugin that is not installed, but fails when none serves a spec', async () => {
    fake.missing.add('events');
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ upstreamVersion: VERSION });
    expect((await plugin.syncCatalog()).operations.some((o) => o.key.includes('/api/events/'))).toBe(false);
    for (const id of ['catalog', 'scaffolder', 'search', 'notifications']) fake.missing.add(id);
    expect(await plugin.testConnection()).toMatchObject({ ok: false });
    await expect(plugin.syncCatalog()).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
    fake.missing.clear();
  });

  it('refuses plugin IDs that are not plain names', async () => {
    for (const pluginIds of [['../auth'], ['catalog/x'], [], 'catalog', [1]])
      await expect(
        createBackstagePlugin().init({ ...connection({ pluginIds }), sdkVersion: '1' }),
      ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
  });

  it('refuses a served spec that is not OpenAPI, strays outside its plugin, or lost a lock', async () => {
    const catalog = JSON.parse(SPECS.catalog!) as { paths: Record<string, Record<string, unknown>> };
    const { delete: _gone, ...rest } = catalog.paths['/api/catalog/entities/by-uid/{uid}']!;
    const search = JSON.parse(SPECS.search!) as { paths: Record<string, unknown> };
    for (const [id, bad] of [
      ['catalog', { error: 'Not Found' }],
      ['catalog', { ...catalog, paths: { ...catalog.paths, '/api/catalog/entities/by-uid/{uid}': rest } }],
      ['search', { ...search, paths: { ...search.paths, '/api/scaffolder/v2/x': { get: {} } } }],
    ] as const) {
      fake.serveSpec(id, bad);
      await expect(plugin.syncCatalog()).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
      fake.serveSpec(id, JSON.parse(SPECS[id]!));
    }
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ upstreamVersion: VERSION });
  });

  it('confirms against the stored entity, location and task, and a create against its visible body field', async () => {
    const literal = async (key: string, path: Record<string, string>, body?: unknown) =>
      (await plugin.summarize({ key, params: { path, body }, targets: [] })).confirmLiteral;
    expect(await literal('DELETE /api/catalog/entities/by-uid/{uid}', { uid: PETSTORE_UID })).toBe('petstore');
    expect(
      await literal('PUT /api/catalog/locations/{id}', { id: LOCATION_ID }, { type: 'url', target: 'https://x' }),
    ).toBe(LOCATION_TARGET);
    expect(await literal('POST /api/scaffolder/v2/tasks/{taskId}/cancel', { taskId: TASK_ID })).toBe('react-app');
    // A create has nothing stored: the literal is the body field the approver sees.
    expect(await literal('POST /api/scaffolder/v2/tasks', {}, { templateRef: 'template:default/x' })).toBe(
      'template:default/x',
    );
    expect(await literal('POST /api/catalog/locations', {}, { type: 'url', target: 'https://x/a.yaml' })).toBe(
      'https://x/a.yaml',
    );
    // A lookup that finds nothing falls back to the id in the path.
    expect(await literal('DELETE /api/catalog/locations/{id}', { id: 'gone' })).toBe('gone');
  });

  it('names the stored entity, location, task or template as the target', async () => {
    const targets = (key: string, params: unknown) => plugin.resolveTargets!({ key, params });
    await expect(
      targets('DELETE /api/catalog/entities/by-uid/{uid}', { path: { uid: PETSTORE_UID } }),
    ).resolves.toEqual([{ kind: 'entity', id: PETSTORE_UID, name: 'component:default/petstore' }]);
    await expect(targets('DELETE /api/catalog/locations/{id}', { path: { id: LOCATION_ID } })).resolves.toEqual([
      { kind: 'location', id: LOCATION_ID, name: `url:${LOCATION_TARGET}` },
    ]);
    await expect(
      targets('POST /api/scaffolder/v2/tasks/{taskId}/retry', { path: { taskId: TASK_ID } }),
    ).resolves.toEqual([{ kind: 'task', id: TASK_ID, name: 'template:default/react-app (task processing)' }]);
    await expect(
      targets('POST /api/scaffolder/v2/tasks', { body: { templateRef: 'react-app', values: {} } }),
    ).resolves.toEqual([
      { kind: 'template', id: 'template:default/react-app', name: 'template:default/react-app (React app)' },
    ]);
    await expect(
      targets('POST /api/catalog/locations', { body: { type: 'url', target: 'https://x/a.yaml' } }),
    ).resolves.toEqual([{ kind: 'location', id: 'https://x/a.yaml', name: 'url:https://x/a.yaml' }]);
    const register = await plugin.summarize({
      key: 'POST /api/catalog/locations',
      params: { body: { type: 'url', target: 'https://x/a.yaml' } },
      targets: [{ kind: 'location', id: 'https://x/a.yaml', name: 'url:https://x/a.yaml' }],
    });
    expect(register.text).toMatch(/^Backstage POST \/api\/catalog\/locations from url:https:\/\/x\/a\.yaml: \{/);
    // Unknown templates, other kinds and reads get no target.
    for (const [key, params] of [
      ['POST /api/scaffolder/v2/tasks', { body: { templateRef: 'template:default/nope' } }],
      ['POST /api/scaffolder/v2/tasks', { body: { templateRef: 'component:default/petstore' } }],
      ['POST /api/scaffolder/v2/tasks', { body: { templateRef: '../../x' } }],
      ['GET /api/catalog/locations/{id}', { path: { id: LOCATION_ID } }],
      ['DELETE /api/catalog/locations/{id}', { path: { id: 'gone' } }],
    ] as const)
      await expect(targets(key, params), key).resolves.toEqual([]);
  });

  it('escapes bidi and zero-width characters in target names and the approval text', async () => {
    const target = 'https://x/a\u202elmay.exe\u200b';
    const [t] = await plugin.resolveTargets!({
      key: 'POST /api/catalog/locations',
      params: { body: { type: 'url', target } },
    });
    expect(t).toEqual({ kind: 'location', id: target, name: 'url:https://x/a\\u202elmay.exe\\u200b' });
    const { text } = await plugin.summarize({
      key: 'POST /api/catalog/locations',
      params: { body: { type: 'url', target } },
      targets: [t!],
    });
    expect(text).toMatch(
      /^Backstage POST \/api\/catalog\/locations from url:https:\/\/x\/a\\u202elmay\.exe\\u200b: \{/,
    );
    expect(text).not.toMatch(/[\u200b\u202e]/);
  });

  it('parses entity refs with Backstage defaults', () => {
    expect(parseEntityRef('react-app', 'template')).toEqual({
      kind: 'template',
      namespace: 'default',
      name: 'react-app',
    });
    expect(parseEntityRef('template:ops/x', 'template')).toEqual({ kind: 'template', namespace: 'ops', name: 'x' });
    expect(parseEntityRef('a:b:c', 'template')).toBeUndefined();
  });

  it('reports a rejected token without throwing', async () => {
    const bad = createBackstagePlugin();
    await bad.init({ ...connection(), secrets: { token: 'wrong' }, sdkVersion: '1' });
    expect(await bad.testConnection()).toMatchObject({ ok: false });
    await bad.shutdown?.();
  });

  it('refuses a connection without a base URL or token', async () => {
    await expect(createBackstagePlugin().init({ ...connection(), config: {}, sdkVersion: '1' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
    await expect(createBackstagePlugin().init({ ...connection(), secrets: {}, sdkVersion: '1' })).rejects.toMatchObject(
      { code: ErrorCodes.InvalidParams },
    );
  });
});
