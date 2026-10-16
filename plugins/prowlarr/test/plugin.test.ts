import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../src/catalog.js';
import { cutLinksDeep, destinations, maskProviderFields, redactKeysDeep } from '../src/fields.js';
import { createProwlarrPlugin } from '../src/plugin.js';
import { CREDENTIALS, SECRETS, startFakeProwlarr, TAG, VERSION } from './fake-prowlarr.js';
import type { FakeProwlarr } from './fake-prowlarr.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const context = { callId: 'unit', deadlineMs: 5000 };

let fake: FakeProwlarr;
const plugin = createProwlarrPlugin();

beforeAll(async () => {
  fake = await startFakeProwlarr();
  await plugin.init({ ...connection(), sdkVersion: '1' });
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});
beforeEach(() => {
  fake.reset();
  fake.version = VERSION;
  fake.specText = undefined;
  fake.specRefs = new Set(['develop', TAG]);
});

function connection() {
  return {
    instanceId: 'prowlarr',
    config: { baseUrl: fake.url, specBaseUrl: fake.specUrl },
    secrets: { ...CREDENTIALS },
  };
}
const resolve = (request: object) => plugin.resolveOperation({ fn: 'request', args: [request] });
const invoke = async (request: object) => {
  const { key, params } = await resolve(request);
  return JSON.stringify(await plugin.invoke({ key, params, context }));
};

describe('Prowlarr plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: createProwlarrPlugin(),
      init: connection(),
      samples: [
        { fn: 'request', args: [{ path: '/api/v1/indexer' }], expectKey: 'GET /api/v1/indexer' },
        { fn: 'request', args: [{ method: 'DELETE', path: '/api/v1/tag/12' }], expectKey: 'DELETE /api/v1/tag/{id}' },
      ],
      rejects: [
        { fn: 'request', args: [{ path: '/api/v1/filesystem' }] },
        { fn: 'other', args: [] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('syncs the spec from the tag of the instance version, without credentials', async () => {
    fake.specFetches.length = 0;
    const { upstreamVersion, sourceRef, operations } = await plugin.syncCatalog();
    expect({ upstreamVersion, sourceRef, count: operations.length }).toEqual({
      upstreamVersion: VERSION,
      sourceRef: TAG,
      count: 118,
    });
    expect(fake.specFetches).toEqual([TAG]);
    expect(fake.requests.filter((r) => r.path.startsWith('/spec/')).every((r) => !r.headers['x-api-key'])).toBe(true);
  });

  it('falls back to develop for an untagged build or a version that is not a release', async () => {
    fake.version = '2.7.0.5700';
    fake.specFetches.length = 0;
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ sourceRef: 'develop' });
    expect(fake.specFetches).toEqual(['v2.7.0.5700', 'develop']);
    fake.version = '2.7.0-nightly';
    fake.specFetches.length = 0;
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ sourceRef: 'develop' });
    expect(fake.specFetches).toEqual(['develop']);
  });

  it('refuses a fetched spec that is not usable, or missing everywhere', async () => {
    fake.specText = '{"openapi":"3.0.4","paths":{}}';
    await expect(plugin.syncCatalog()).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
    fake.specText = undefined;
    fake.specRefs = new Set();
    await expect(plugin.syncCatalog()).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
  });

  it('resolves full /api/v1 paths, and refuses excluded or unknown ones', async () => {
    await expect(resolve({ path: '/api/v1/indexer/1' })).resolves.toEqual({
      key: 'GET /api/v1/indexer/{id}',
      params: { path: { id: '1' } },
    });
    for (const path of [
      '/indexer/1',
      '/api/v1/filesystem',
      '/api/v1/log/file/prowlarr.txt',
      '/api/v1/indexer/1/newznab',
      '/api/v1/indexer/1/download',
      '/1/download',
      '/1/api',
      '/ping',
    ])
      await expect(resolve({ path }), path).rejects.toMatchObject({ code: ErrorCodes.UnknownOperation });
  });

  it('picks the locked twins from the call', async () => {
    const key = async (request: object) => (await resolve(request)).key;
    expect(await key({ method: 'POST', path: '/api/v1/command', body: { name: 'CheckHealth' } })).toBe(
      'POST /api/v1/command',
    );
    for (const name of ['ApplicationIndexerSync', 'ApplicationUpdateCheck'])
      expect(await key({ method: 'POST', path: '/api/v1/command', body: { name } }), name).toBe(
        'POST /api/v1/command#heavy',
      );
    expect(await key({ method: 'POST', path: '/api/v1/indexer/test', body: { name: 'x', fields: [] } })).toBe(
      'POST /api/v1/indexer/test',
    );
    expect(await key({ method: 'POST', path: '/api/v1/indexer/test', body: { id: 1, name: 'x', fields: [] } })).toBe(
      'POST /api/v1/indexer/test#stored',
    );
    expect(await key({ method: 'POST', path: '/api/v1/applications/test', body: { Id: 4, Fields: [] } })).toBe(
      'POST /api/v1/applications/test#stored',
    );
  });

  it('refuses a write carrying a masked value from an earlier result', async () => {
    await expect(
      resolve({ method: 'PUT', path: '/api/v1/config/host/1', body: { id: 1, password: '[REDACTED]' } }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    const fields = [{ name: 'password', value: '[REDACTED]', type: 'password' }];
    await expect(
      resolve({ method: 'PUT', path: '/api/v1/indexer/2', body: { id: 2, name: 'PrivateHD', fields } }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    await expect(
      resolve({ method: 'POST', path: '/api/v1/search', body: { guid: 'https://privatehd.example/[REDACTED]' } }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    // Prowlarr's own mask keeps the stored secret, so it passes.
    const kept = [{ name: 'apiKey', value: '********', privacy: 'apiKey' }];
    await expect(
      resolve({ method: 'PUT', path: '/api/v1/applications/4', body: { id: 4, name: 'Sonarr', fields: kept } }),
    ).resolves.toMatchObject({ key: 'PUT /api/v1/applications/{id}' });
  });

  it('names the connections and destinations a call acts on', async () => {
    const targets = (key: string, params: object) => plugin.resolveTargets!({ key, params });
    await expect(targets('DELETE /api/v1/applications/{id}', { path: { id: '4' } })).resolves.toEqual([
      {
        kind: 'applications',
        id: '4',
        name: 'applications Sonarr (Sonarr) → http://prowlarr:9696, http://sonarr:8989',
      },
    ]);
    await expect(targets('PUT /api/v1/indexerproxy/{id}', { path: { id: '5' }, body: {} })).resolves.toEqual([
      { kind: 'indexerproxy', id: '5', name: 'indexerproxy FlareSolverr (FlareSolverr) → http://flaresolverr:8191' },
    ]);
    await expect(targets('DELETE /api/v1/indexerproxy/{id}', { path: { id: '10' } })).resolves.toEqual([
      { kind: 'indexerproxy', id: '10', name: 'indexerproxy Socks (Socks5) → http://socks.lan:1080' },
    ]);
    await expect(targets('DELETE /api/v1/indexer/{id}', { path: { id: '404' } })).resolves.toEqual([
      { kind: 'indexer', id: '404', name: 'indexer 404' },
    ]);
    const many = await targets('PUT /api/v1/indexer/bulk', { body: { ids: [1, 2, ...Array(10).fill(3)] } });
    expect(many.slice(0, 2).map((t) => t.name)).toEqual(['indexer NZBgeek (Newznab)', 'indexer PrivateHD (Cardigann)']);
    expect(many.at(-1)).toEqual({ kind: 'indexer', id: 'more', name: '2 more' });
    const body = {
      id: 2,
      name: 'PrivateHD‮',
      implementation: 'Cardigann',
      fields: [{ name: 'baseUrl', value: 'https://collector.example/x' }],
    };
    await expect(targets('POST /api/v1/indexer/test#stored', { body })).resolves.toEqual([
      { kind: 'indexer', id: '2', name: 'indexer PrivateHD\\u202e (Cardigann) → https://collector.example' },
    ]);
    await expect(targets('GET /api/v1/indexer/{id}', { path: { id: '1' } })).resolves.toEqual([]);
  });

  it('puts the destination ahead of a long body in the approval text', async () => {
    const targets = [{ kind: 'applications', id: 'new', name: 'applications X (Radarr) → http://radarr.lan:7878' }];
    const { text, confirmLiteral } = await plugin.summarize({
      key: 'POST /api/v1/applications',
      params: { body: { name: 'X', padding: 'p'.repeat(2000), fields: '[REDACTED]' } },
      targets,
    });
    expect(text).toMatch(
      /^Prowlarr POST \/api\/v1\/applications on applications X \(Radarr\) → http:\/\/radarr\.lan:7878 \{/,
    );
    expect(confirmLiteral).toBe('X');
  });

  it('masks provider and Cardigann secrets in results, and link-shaped release guids', async () => {
    await plugin.syncCatalog();
    const indexers = await invoke({ path: '/api/v1/indexer' });
    for (const secret of [
      SECRETS.indexerApiKey,
      SECRETS.cardigannPassword,
      SECRETS.trackerCookie,
      SECRETS.twoFactor,
      SECRETS.trackerPid,
      SECRETS.trackerPasskey,
    ])
      expect(indexers).not.toContain(secret);
    expect(indexers).toContain('"value":"/api"');
    expect(indexers).not.toContain('"value":"me"');
    const apps = await invoke({ path: '/api/v1/applications' });
    expect(apps).not.toContain(SECRETS.appApiKey);
    expect(apps).toContain('"value":"********"');
    expect(apps).toContain('http://sonarr:8989');
    const hits = await invoke({ path: '/api/v1/search', query: { query: 'dune' } });
    expect(hits).not.toContain(SECRETS.trackerPasskey);
    expect(hits).toContain('"guid":"https://privatehd.example/[REDACTED]"');
    expect(hits).toContain('"guid":"nzbgeek-guid-1"');
    expect(hits).not.toContain(SECRETS.magnetGuidPasskey);
    expect(hits).toContain('"guid":"magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567"');
    expect(hits).toContain('"commentUrl":"https://privatehd.example/[REDACTED]"');
    const history = await invoke({ path: '/api/v1/history' });
    expect(history).not.toContain(SECRETS.grabPasskey);
    expect(history).toContain('"Url":"[REDACTED]"');
    expect(history).not.toContain(SECRETS.infoPasskey);
    expect(history).toContain('"InfoUrl":"https://privatehd.example/[REDACTED]"');
  });

  it('names the release, its indexer and the download client a grab sends it to', async () => {
    const targets = (key: string, params: object) => plugin.resolveTargets!({ key, params });
    await expect(
      targets('POST /api/v1/search', { body: { guid: 'g', indexerId: 1, title: 'Dune', downloadClientId: 6 } }),
    ).resolves.toEqual([
      { kind: 'release', id: 'g', name: 'release g ("Dune") → download client qBit (from NZBgeek)' },
    ]);
    await expect(targets('POST /api/v1/search', { body: { guid: 'g', indexerId: 1 } })).resolves.toEqual([
      { kind: 'release', id: 'g', name: 'release g → the default download client (from NZBgeek)' },
    ]);
    // Prowlarr binds `DownloadClientId` as `downloadClientId`; client 7 doesn't resolve, so its id shows.
    const { key, params } = await resolve({
      method: 'POST',
      path: '/api/v1/search',
      body: { Guid: 'g', IndexerId: 1, Title: 'Dune', DownloadClientId: 7 },
    });
    await expect(plugin.resolveTargets!({ key, params })).resolves.toEqual([
      { kind: 'release', id: 'g', name: 'release g ("Dune") → download client 7 (from NZBgeek)' },
    ]);
    const bulk = await targets('POST /api/v1/search/bulk', {
      body: [{ guid: 'a', indexerId: 2, title: 'A', downloadClientId: 99 }, ...Array(10).fill({ guid: 'b' })],
    });
    expect(bulk[0]).toEqual({
      kind: 'release',
      id: 'a',
      name: 'release a ("A") → download client qBit (from PrivateHD)',
    });
    expect(bulk.at(-1)).toEqual({ kind: 'release', id: 'more', name: '1 more releases' });
  });

  it('reports a rejected key without throwing', async () => {
    const bad = createProwlarrPlugin();
    await bad.init({ ...connection(), secrets: { apiKey: 'wrong' }, sdkVersion: '1' });
    expect(await bad.testConnection()).toMatchObject({ ok: false });
    await bad.shutdown?.();
  });
});

describe('provider fields', () => {
  it('hides password-typed and Cardigann secret fields, keeps hosts and cuts URLs to their origin', () => {
    const fields = [
      { name: 'baseUrl', value: 'https://user:pw@idx.example/api?apikey=k', privacy: 'normal' },
      { name: 'plain', value: 'https://idx.example/', privacy: 'normal' },
      { name: 'username', value: 'me', privacy: 'normal', type: 'textbox' },
      { name: 'secretWord', value: 's', privacy: 'normal', type: 'textbox' },
      { name: 'pid', value: 'p', privacy: 'normal', type: 'Password' },
      { name: '2facode', value: '123456', privacy: 'normal', type: 'textbox' },
      { name: 'pin', value: '1234', privacy: 'normal', type: 'textbox' },
      { name: 'rsskey', value: 'r', privacy: 'normal', type: 'textbox' },
      { name: 'cookie', value: 'uid=1; pass=2', privacy: 'normal' },
      { name: 'apiKey', value: 'k', privacy: 'apiKey' },
      { name: 'headers', value: [{ key: 'Authorization', value: 'Bearer hdr-secret' }], privacy: 'normal' },
      { name: 'syncCategories', value: [2000, 2010], privacy: 'normal' },
    ];
    expect(maskProviderFields({ fields })).toEqual({
      fields: [
        { name: 'baseUrl', value: 'https://idx.example/[REDACTED]', privacy: 'normal' },
        { name: 'plain', value: 'https://idx.example/', privacy: 'normal' },
        { name: 'username', value: 'me', privacy: 'normal', type: 'textbox' },
        { name: 'secretWord', value: '[REDACTED]', privacy: 'normal', type: 'textbox' },
        { name: 'pid', value: '[REDACTED]', privacy: 'normal', type: 'Password' },
        { name: '2facode', value: '[REDACTED]', privacy: 'normal', type: 'textbox' },
        { name: 'pin', value: '[REDACTED]', privacy: 'normal', type: 'textbox' },
        { name: 'rsskey', value: '[REDACTED]', privacy: 'normal', type: 'textbox' },
        { name: 'cookie', value: '[REDACTED]', privacy: 'normal' },
        { name: 'apiKey', value: '********', privacy: 'apiKey' },
        { name: 'headers', value: [{ key: 'Authorization', value: '[REDACTED]' }], privacy: 'normal' },
        { name: 'syncCategories', value: [2000, 2010], privacy: 'normal' },
      ],
    });
  });

  it('lists hosts, URL hosts and URL origins by exact name, first match first, never a secret field', () => {
    expect(destinations({ fields: [{ name: 'host', value: 'http://flaresolverr:8191/v1' }] })).toEqual([
      'http://flaresolverr:8191',
    ]);
    expect(
      destinations({
        fields: [
          { name: 'host', value: 'socks.lan' },
          { name: 'port', value: 1080 },
          { name: 'apiKey', value: 'https://secret.example/' },
        ],
      }),
    ).toEqual(['http://socks.lan:1080']);
    expect(destinations({ fields: [{ name: 'Host', value: 'decoy.example' }] })).toEqual([]);
  });

  it('fails closed on Cardigann settings: every string hidden but the site origin and select or checkbox values', () => {
    const field = (name: string, value: unknown, type = 'textbox', privacy = 'normal') => ({
      name,
      value,
      type,
      privacy,
    });
    expect(
      maskProviderFields({
        implementation: 'Cardigann',
        fields: [
          field('baseUrl', 'https://site.example/login?key=k', 'select'),
          field('pid', 'p-123'),
          field('username', 'me'),
          field('sort', 'seeders', 'select'),
          field('freeleech', true, 'checkbox'),
          field('apiKey', 'k', 'textbox', 'apiKey'),
          field('tags', ['a', 1]),
          field('limit', 50),
        ],
      }),
    ).toEqual({
      implementation: 'Cardigann',
      fields: [
        field('baseUrl', 'https://site.example/[REDACTED]', 'select'),
        field('pid', '[REDACTED]'),
        field('username', '[REDACTED]'),
        field('sort', 'seeders', 'select'),
        field('freeleech', true, 'checkbox'),
        field('apiKey', '********', 'textbox', 'apiKey'),
        field('tags', ['[REDACTED]', 1]),
        field('limit', 50),
      ],
    });
  });

  it('cuts a magnet guid to its info hash, and a host without a scheme loses its userinfo', () => {
    expect(
      cutLinksDeep(
        {
          guid: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x&tr=https%3A%2F%2Ft.example%2FPASSKEY',
        },
        ['guid'],
      ),
    ).toEqual({
      guid: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
    });
    expect(destinations({ fields: [{ name: 'host', value: 'user:pw@socks.lan' }] })).toEqual(['http://socks.lan']);
  });

  it('drops host userinfo only before the first delimiter, so a fragment or path cannot fake the host', () => {
    const host = (value: string) => destinations({ fields: [{ name: 'host', value }] });
    expect(host('user:pw@nas.lan')).toEqual(['http://nas.lan']);
    for (const value of ['evil.example#@good.example', 'evil.example?@good.example', 'evil.example/@good.example'])
      expect(host(value)[0], value).toMatch(/^http:\/\/evil\.example/);
  });

  it('hides link keys in any case, at any depth', () => {
    expect(redactKeysDeep({ records: [{ data: { Url: 'u', URL: 'v', url: '', title: 't' } }] }, ['url'])).toEqual({
      records: [{ data: { Url: '[REDACTED]', URL: '[REDACTED]', url: '', title: 't' } }],
    });
  });

  it('cuts link-shaped release guids, info and comment links to their origin in any case, and keeps the others', () => {
    expect(
      cutLinksDeep(
        { records: [{ data: { InfoUrl: 'https://t.example/d?passkey=pk', CommentURL: 'https://t.example/c/1' } }] },
        ['guid', 'infoUrl', 'commentUrl'],
      ),
    ).toEqual({
      records: [{ data: { InfoUrl: 'https://t.example/[REDACTED]', CommentURL: 'https://t.example/[REDACTED]' } }],
    });
    expect(
      cutLinksDeep(
        [
          { guid: 'https://t.example/download.php?id=1&passkey=pk', title: 'a' },
          { guid: 'https://t.example', title: 'b' },
          { guid: 'abc-123', title: 'c' },
          { title: 'd', infoUrl: 'https://t.example/details/1', commentUrl: 'https://t.example/c?passkey=pk' },
        ],
        ['guid', 'infoUrl', 'commentUrl'],
      ),
    ).toEqual([
      { guid: 'https://t.example/[REDACTED]', title: 'a' },
      { guid: 'https://t.example', title: 'b' },
      { guid: 'abc-123', title: 'c' },
      { title: 'd', infoUrl: 'https://t.example/[REDACTED]', commentUrl: 'https://t.example/[REDACTED]' },
    ]);
  });
});

describe('case-insensitive binding', () => {
  const key = async (request: object) => (await resolve(request)).key;
  const refused = (request: object) =>
    expect(resolve(request)).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });

  it('takes the locked twin whatever the case of the id or command name', async () => {
    const stored = await resolve({
      method: 'POST',
      path: '/api/v1/downloadclient/test',
      body: { Id: 6, Name: 'x', Fields: [] },
    });
    expect(stored).toMatchObject({
      key: 'POST /api/v1/downloadclient/test#stored',
      params: { body: { id: 6, name: 'x', fields: [] } },
    });
    expect(await key({ method: 'POST', path: '/api/v1/command', body: { Name: 'ApplicationIndexerSync' } })).toBe(
      'POST /api/v1/command#heavy',
    );
    expect(await key({ method: 'POST', path: '/api/v1/command', body: { NAME: 'checkhealth' } })).toBe(
      'POST /api/v1/command',
    );
  });

  it('refuses keys that differ only in case in the query, the body, body lists and provider fields', async () => {
    await refused({ method: 'POST', path: '/api/v1/command', body: { name: 'CheckHealth', Name: 'ResetApiKey' } });
    await refused({ path: '/api/v1/search', query: { query: 'a', Query: 'b' } });
    await refused({ method: 'POST', path: '/api/v1/search/bulk', body: [{ guid: 'a', Guid: 'b' }] });
    const fields = (f: unknown[]) => ({ method: 'POST', path: '/api/v1/indexerproxy', body: { name: 'x', fields: f } });
    await refused(
      fields([
        { name: 'host', value: 'a' },
        { name: 'Host', value: 'b' },
      ]),
    );
    await refused(fields([{ name: 'host', value: 'a', Value: 'b' }]));
  });
});
