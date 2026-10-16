import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../src/catalog.js';
import { maskTokens } from '../src/mask.js';
import { createPlexPlugin } from '../src/plugin.js';
import { withTargets } from '../src/targets.js';
import {
  CREDENTIALS,
  FAKE_TOKEN,
  INSTANCE,
  SECRETS,
  SPEC_REF,
  SPEC_SHA256,
  SPEC_TEXT,
  startFakePlex,
  VERSION,
} from './fake-plex.js';
import type { FakePlex } from './fake-plex.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const context = { callId: 'unit', deadlineMs: 5000 };

let fake: FakePlex;
const plugin = createPlexPlugin();

function connection() {
  return {
    instanceId: 'plex-1',
    config: { baseUrl: fake.url, specBaseUrl: fake.specUrl },
    secrets: { ...CREDENTIALS },
  };
}

// The fake serves the reduced fixture, so the in-process plugin expects its digest (test only).
const PINNED_SHA256 = settings.plugin.spec.sha256;

beforeAll(async () => {
  settings.plugin.spec.sha256 = SPEC_SHA256;
  fake = await startFakePlex();
  await plugin.init({ ...connection(), sdkVersion: '1' });
});
afterAll(async () => {
  settings.plugin.spec.sha256 = PINNED_SHA256;
  await plugin.shutdown?.();
  await fake?.close();
});
beforeEach(() => {
  fake.reset();
  fake.version = VERSION;
  fake.specText = undefined;
});

const resolve = (request: object) => plugin.resolveOperation({ fn: 'request', args: [request] });

describe('Plex plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: createPlexPlugin(),
      init: connection(),
      samples: [
        { fn: 'request', args: [{ path: '/library/sections/all' }], expectKey: 'GET /library/sections/all' },
        { fn: 'request', args: [{ method: 'PUT', path: '/:/scrobble' }], expectKey: 'PUT /:/scrobble' },
        {
          fn: 'request',
          args: [{ method: 'DELETE', path: '/playlists/401' }],
          expectKey: 'DELETE /playlists/{playlistId}',
        },
      ],
      rejects: [
        { fn: 'request', args: [{ path: '/services/browse' }] },
        { fn: 'request', args: [{ path: '/users/account.json' }] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('syncs the spec at the pinned commit, without the token, and reports the server version', async () => {
    fake.specFetches.length = 0;
    const result = await plugin.syncCatalog();
    expect(result).toMatchObject({ upstreamVersion: VERSION, sourceRef: SPEC_REF });
    expect(result.operations).toHaveLength(306);
    expect(fake.specFetches).toEqual([{ ref: SPEC_REF, token: undefined }]);
  });

  it('sends the token, JSON accept and a stable client identifier', async () => {
    fake.requests.length = 0;
    await plugin.invoke({ ...(await resolve({ path: '/library/sections/all' })), context });
    expect(fake.requests.at(-1)!.headers).toMatchObject({
      'x-plex-token': FAKE_TOKEN,
      accept: 'application/json',
      'x-plex-client-identifier': 'synoikia-plex-1',
    });
  });

  it('pins the upstream file digest in plugin.yaml, not the fixture one', () => {
    expect(PINNED_SHA256).toBe('ff8801eb6c7904e6298215dd789521750e4af0f18b5fde0999bb544d15335070');
    expect(SPEC_SHA256).not.toBe(PINNED_SHA256);
  });

  it('refuses a spec that is not the pinned file, from GitHub or a mirror', async () => {
    expect(SPEC_TEXT.includes('\n  /:/prefs:\n')).toBe(true);
    for (const text of [
      'openapi: 3.1.0\npaths: {}\n',
      SPEC_TEXT.replace('\n  /:/prefs:\n', '\n  /:/prefz:\n'),
      `${SPEC_TEXT}\n`,
    ]) {
      fake.specText = text;
      await expect(plugin.syncCatalog()).rejects.toMatchObject({
        code: ErrorCodes.UpstreamError,
        message: expect.stringMatching(/not the pinned file/),
      });
    }
  });

  it('reports a rejected token without throwing', async () => {
    const bad = createPlexPlugin();
    await bad.init({ ...connection(), secrets: { token: 'wrong' }, sdkVersion: '1' });
    expect(await bad.testConnection()).toMatchObject({ ok: false });
    await bad.shutdown?.();
  });

  it('refuses a connection without a base URL or token', async () => {
    await expect(createPlexPlugin().init({ ...connection(), config: {}, sdkVersion: '1' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
    await expect(createPlexPlugin().init({ ...connection(), secrets: {}, sdkVersion: '1' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });
});

describe('request keys', () => {
  it('renames the keys the rules read to Plex spelling', async () => {
    const r = await resolve({ method: 'DELETE', path: '/playlists', query: { RatingKey: 401 } });
    expect((r.params as { query?: unknown }).query).toEqual({ ratingKey: 401 });
  });

  it('takes the locked twin for a flag in any case', async () => {
    const r = await resolve({ path: '/library/metadata/101', query: { AsyncRefreshAnalysis: 1 } });
    expect(r.key).toBe('GET /library/metadata/{ids}#refresh');
  });

  it('refuses keys that differ only in case, a token, and masked values', async () => {
    for (const request of [
      { method: 'POST', path: '/status/sessions/terminate', query: { sessionId: 'a', SessionId: 'b' } },
      { path: '/library/sections/all', query: { 'x-plex-token': 'other' } },
      { method: 'PUT', path: '/:/prefs', query: { PlexOnlineToken: '[REDACTED]' } },
      {
        method: 'POST',
        path: '/library/metadata/101/extras',
        query: { url: ['https://a.example', 'https://b.example'] },
      },
      { method: 'POST', path: '/media/grabbers/devices', query: { uri: { href: 'http://10.0.0.5' } } },
      { path: '/library/metadata/101', query: { checkFiles: [0, 1] } },
    ])
      await expect(resolve(request), JSON.stringify(request)).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
      });
  });
});

describe('summaries and targets', () => {
  it('names the session, its user and player, and confirms on what it plays', async () => {
    const r = await resolve({ method: 'POST', path: '/status/sessions/terminate', query: { sessionId: 'sess-1' } });
    const targets = (await plugin.resolveTargets?.(r)) ?? [];
    expect(targets[0]?.name).toBe('alice playing Arrival (2016) [movie] on Living Room TV');
    const summary = await plugin.summarize({ ...r, targets });
    expect(summary.confirmLiteral).toBe('Arrival');
    expect(summary.text).toMatch(/^Plex POST \/status\/sessions\/terminate on alice playing/);
  });

  it('shows the settings a prefs write changes, and only the origin of a URL Plex fetches', async () => {
    const prefs = await resolve({
      method: 'PUT',
      path: '/:/prefs',
      query: { FriendlyName: 'x', allowedNetworks: '0.0.0.0/0' },
    });
    expect((await plugin.resolveTargets?.(prefs))?.[0]?.name).toBe('settings FriendlyName, allowedNetworks');
    const extras = await resolve({
      method: 'POST',
      path: '/library/metadata/101/extras',
      query: { url: 'https://u:p@trailers.example/t.mp4?sig=abc' },
    });
    const names = ((await plugin.resolveTargets?.(extras)) ?? []).map((t) => t.name);
    expect(names).toEqual(['Inception (2010) [movie]', 'fetches https://trailers.example']);
  });

  it('lists several items and confirms on the count', async () => {
    const r = await resolve({ method: 'DELETE', path: '/library/metadata/101,301' });
    const targets = (await plugin.resolveTargets?.(r)) ?? [];
    expect(targets.map((t) => t.name)).toEqual([
      'Inception (2010) [movie]',
      'Severance – Good News About Hell [episode]',
    ]);
    expect((await plugin.summarize({ ...r, targets })).confirmLiteral).toBe('2 items');
  });

  it('falls back to the id when a lookup fails, and the instance name when nothing else names it', async () => {
    const r = await resolve({ method: 'DELETE', path: '/library/sections/9' });
    const targets = (await plugin.resolveTargets?.(r)) ?? [];
    expect(targets[0]?.name).toBe('library 9');
    expect((await plugin.summarize({ ...r, targets })).confirmLiteral).toBe('9');
    const apply = await resolve({ method: 'PUT', path: '/updater/apply' });
    expect((await plugin.summarize({ ...apply, targets: [] })).confirmLiteral).toBe(INSTANCE);
  });

  it('gives reads no targets', async () => {
    expect(await plugin.resolveTargets?.(await resolve({ path: '/library/metadata/101' }))).toEqual([]);
  });

  it('places targets ahead of the query', () => {
    expect(withTargets('Plex PUT /:/prefs?a=1 (note)', [{ kind: 's', id: 'p', name: 'settings a' }])).toBe(
      'Plex PUT /:/prefs on settings a ?a=1 (note)',
    );
  });
});

describe('result masking', () => {
  it('masks tokens in URLs and secret server settings', async () => {
    const prefs = await plugin.invoke({ ...(await resolve({ path: '/:/prefs' })), context });
    const text = JSON.stringify(prefs);
    expect(text).not.toContain(SECRETS.onlineToken);
    expect(text).not.toContain(SECRETS.certKey);
    expect(text).toContain(INSTANCE);
    expect(
      maskTokens({
        a: 'https://h/x?X-Plex-Token=abc&b=1',
        b: '/t?x-plex-token=abc',
        c: 'see /p;token=abc',
        d: { id: 'PlexOnlineToken', value: '' },
      }),
    ).toEqual({
      a: 'https://h/x?X-Plex-Token=[REDACTED]&b=1',
      b: '/t?x-plex-token=[REDACTED]',
      c: 'see /p;token=[REDACTED]',
      d: { id: 'PlexOnlineToken', value: '' },
    });
  });
});
