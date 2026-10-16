import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../src/catalog.js';
import { cutLinksDeep, destinations, maskProviderFields, redactKeysDeep } from '../src/fields.js';
import { createLidarrPlugin } from '../src/plugin.js';
import { CREDENTIALS, SECRETS, startFakeLidarr, TAG, VERSION } from './fake-lidarr.js';
import type { FakeLidarr } from './fake-lidarr.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const context = { callId: 'unit', deadlineMs: 5000 };

let fake: FakeLidarr;
const plugin = createLidarrPlugin();

beforeAll(async () => {
  fake = await startFakeLidarr();
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
    instanceId: 'lidarr',
    config: { baseUrl: fake.url, specBaseUrl: fake.specUrl },
    secrets: { ...CREDENTIALS },
  };
}
const resolve = (request: object) => plugin.resolveOperation({ fn: 'request', args: [request] });

describe('Lidarr plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: createLidarrPlugin(),
      init: connection(),
      samples: [
        { fn: 'request', args: [{ path: '/api/v1/artist' }], expectKey: 'GET /api/v1/artist' },
        { fn: 'request', args: [{ method: 'DELETE', path: '/api/v1/tag/3' }], expectKey: 'DELETE /api/v1/tag/{id}' },
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
      count: 225,
    });
    expect(fake.specFetches).toEqual([TAG]);
    expect(fake.requests.filter((r) => r.path.startsWith('/spec/')).every((r) => !r.headers['x-api-key'])).toBe(true);
  });

  it('falls back to develop for an untagged build or a version that is not a release', async () => {
    fake.version = '3.2.0.5100';
    fake.specFetches.length = 0;
    await expect(plugin.syncCatalog()).resolves.toMatchObject({ sourceRef: 'develop' });
    expect(fake.specFetches).toEqual(['v3.2.0.5100', 'develop']);
    fake.version = '3.2.0-nightly';
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
    await expect(resolve({ path: '/api/v1/artist/1' })).resolves.toEqual({
      key: 'GET /api/v1/artist/{id}',
      params: { path: { id: '1' } },
    });
    for (const path of [
      '/artist/1',
      '/api/v1/filesystem',
      '/api/v1/log/file/lidarr.txt',
      '/api/v1/log/file/update',
      '/ping',
    ])
      await expect(resolve({ path }), path).rejects.toMatchObject({ code: ErrorCodes.UnknownOperation });
    await expect(
      resolve({ method: 'POST', path: '/api/v1/manualimport', body: [{ path: '/etc' }] }),
    ).rejects.toMatchObject({
      code: ErrorCodes.UnknownOperation,
    });
  });

  it('picks the locked twins from the call', async () => {
    const key = async (request: object) => (await resolve(request)).key;
    expect(await key({ method: 'DELETE', path: '/api/v1/artist/1' })).toBe('DELETE /api/v1/artist/{id}');
    expect(await key({ method: 'DELETE', path: '/api/v1/artist/1', query: { deleteFiles: true } })).toBe(
      'DELETE /api/v1/artist/{id}#delete-files',
    );
    expect(await key({ method: 'DELETE', path: '/api/v1/album/16', query: { deleteFiles: true } })).toBe(
      'DELETE /api/v1/album/{id}#delete-files',
    );
    expect(await key({ method: 'PUT', path: '/api/v1/album/16', body: { id: 16, monitored: true } })).toBe(
      'PUT /api/v1/album/{id}',
    );
    expect(await key({ method: 'POST', path: '/api/v1/command', body: { name: 'RssSync' } })).toBe(
      'POST /api/v1/command',
    );
    expect(await key({ method: 'POST', path: '/api/v1/command', body: { name: 'RetagArtist', artistIds: [1] } })).toBe(
      'POST /api/v1/command#heavy',
    );
    expect(await key({ method: 'POST', path: '/api/v1/indexer/test', body: { name: 'x', fields: [] } })).toBe(
      'POST /api/v1/indexer/test',
    );
    expect(await key({ method: 'POST', path: '/api/v1/indexer/test', body: { id: 7, name: 'x', fields: [] } })).toBe(
      'POST /api/v1/indexer/test#stored',
    );
  });

  it('refuses a write carrying a masked value from an earlier result', async () => {
    await expect(
      resolve({ method: 'PUT', path: '/api/v1/config/host/1', body: { id: 1, password: '[REDACTED]' } }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    const fields = [{ name: 'webHookUrl', value: 'https://discord.com/[REDACTED]' }];
    await expect(
      resolve({ method: 'PUT', path: '/api/v1/notification/9', body: { id: 9, name: 'Discord', fields } }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    // Lidarr's own mask keeps the stored secret, so it passes.
    const kept = [{ name: 'password', value: '********', privacy: 'password' }];
    await expect(
      resolve({ method: 'PUT', path: '/api/v1/downloadclient/6', body: { id: 6, name: 'qBit', fields: kept } }),
    ).resolves.toMatchObject({ key: 'PUT /api/v1/downloadclient/{id}' });
  });

  it('names the artists, albums, track files, connections and release source a call acts on', async () => {
    const targets = (key: string, params: object) => plugin.resolveTargets!({ key, params });
    await expect(targets('DELETE /api/v1/artist/{id}#delete-files', { path: { id: '1' } })).resolves.toEqual([
      { kind: 'artist', id: '1', name: 'Radiohead at /music/Radiohead' },
    ]);
    await expect(targets('DELETE /api/v1/artist/{id}', { path: { id: '404' } })).resolves.toEqual([
      { kind: 'artist', id: '404', name: 'artist 404' },
    ]);
    const editor = await targets('PUT /api/v1/artist/editor', { body: { artistIds: [1, 2, ...Array(11).fill(9)] } });
    expect(editor.map((t) => t.name).slice(0, 2)).toEqual(['Radiohead at /music/Radiohead', 'Björk at /music/Björk']);
    expect(editor.at(-1)).toEqual({ kind: 'artist', id: 'more', name: '3 more artists' });
    await expect(
      targets('PUT /api/v1/artist/{id}#move-files', { path: { id: '2' }, body: { path: '/x/Björk' } }),
    ).resolves.toEqual([{ kind: 'artist', id: '2', name: 'Björk at /music/Björk → /x/Björk' }]);
    const moved = await targets('PUT /api/v1/artist/editor', { body: { artistIds: [1], rootFolderPath: '/flac' } });
    expect(moved.at(-1)).toEqual({ kind: 'folder', id: 'rootFolderPath', name: 'into /flac' });
    await expect(targets('DELETE /api/v1/album/{id}#delete-files', { path: { id: '16' } })).resolves.toEqual([
      { kind: 'album', id: '16', name: 'OK Computer by Radiohead' },
    ]);
    await expect(targets('DELETE /api/v1/trackfile/bulk', { body: { trackFileIds: [13, 99] } })).resolves.toEqual([
      { kind: 'trackfile', id: '13', name: '/music/Radiohead/OK Computer (1997)/01 - Airbag.flac' },
      { kind: 'trackfile', id: '99', name: 'track file 99' },
    ]);
    await expect(
      targets('PUT /api/v1/config/mediamanagement/{id}', {
        body: { id: 1, useScriptImport: true, scriptImportPath: '/config/run.sh\u202e' },
      }),
    ).resolves.toEqual([{ kind: 'script', id: 'scriptImportPath', name: 'import script on: /config/run.sh\\u202e' }]);
    await expect(
      targets('PUT /api/v1/config/mediamanagement/{id}', { body: { id: 1, recycleBin: '/bin' } }),
    ).resolves.toEqual([]);
    for (const scriptImportPath of [null, ''])
      await expect(
        targets('PUT /api/v1/config/mediamanagement/{id}', {
          body: { id: 1, useScriptImport: true, scriptImportPath },
        }),
      ).resolves.toEqual([
        { kind: 'script', id: 'scriptImportPath', name: 'import script on: /config/scripts/import.sh' },
      ]);
    await expect(targets('POST /api/v1/rootfolder', { body: { name: 'All', path: '/' } })).resolves.toEqual([
      { kind: 'folder', id: 'path', name: 'root folder /' },
    ]);
    await expect(targets('DELETE /api/v1/downloadclient/{id}', { path: { id: '6' } })).resolves.toEqual([
      { kind: 'downloadclient', id: '6', name: 'downloadclient qBit (QBittorrent) → http://qbittorrent.lan:8080' },
    ]);
    const body = {
      id: 9,
      name: 'Discord‮',
      implementation: 'Discord',
      fields: [{ name: 'webHookUrl', value: `https://discord.com/api/webhooks/42/${SECRETS.webhookToken}` }],
    };
    await expect(targets('POST /api/v1/notification/test', { body })).resolves.toEqual([
      { kind: 'notification', id: '9', name: 'notification Discord\\u202e (Discord) → https://discord.com' },
    ]);
    await expect(
      targets('POST /api/v1/release/push', { body: { title: 'X', downloadUrl: 'https://t.example/dl?passkey=pk' } }),
    ).resolves.toEqual([{ kind: 'release', id: 'push', name: 'X from https://t.example' }]);
    await expect(targets('GET /api/v1/movie/{id}', { path: { id: '1' } })).resolves.toEqual([]);
  });

  it('puts the destination ahead of a long body in the approval text', async () => {
    const targets = [{ kind: 'downloadclient', id: 'new', name: 'downloadclient X (Sabnzbd) → http://sab.lan:8085' }];
    const { text, confirmLiteral } = await plugin.summarize({
      key: 'POST /api/v1/downloadclient',
      params: { body: { name: 'X', padding: 'p'.repeat(2000), fields: '[REDACTED]' } },
      targets,
    });
    expect(text).toMatch(
      /^Lidarr POST \/api\/v1\/downloadclient on downloadclient X \(Sabnzbd\) → http:\/\/sab\.lan:8085 \{/,
    );
    expect(confirmLiteral).toBe('X');
  });

  it('masks provider secrets in results the way Lidarr does, and webhook URLs to their origin', async () => {
    await plugin.syncCatalog();
    const invoke = async (path: string) => {
      const { key, params } = await resolve({ path });
      return JSON.stringify(await plugin.invoke({ key, params, context }));
    };
    const clients = await invoke('/api/v1/downloadclient');
    expect(clients).not.toContain(SECRETS.clientPassword);
    expect(clients).toContain('"value":"********"');
    expect(clients).toContain('qbittorrent.lan');
    expect(clients).toContain('"value":"lidarr"');
    expect(await invoke('/api/v1/indexer/7')).not.toContain(SECRETS.indexerApiKey);
    const hooks = await invoke('/api/v1/notification');
    expect(hooks).not.toContain(SECRETS.webhookToken);
    expect(hooks).toContain('"value":"https://discord.com/[REDACTED]"');
  });

  it('hides release and history links in any case, and cuts link-shaped guids and info links to their origin', async () => {
    await plugin.syncCatalog();
    const invoke = async (request: object) => {
      const { key, params } = await resolve(request);
      return JSON.stringify(await plugin.invoke({ key, params, context }));
    };
    const releases = await invoke({ path: '/api/v1/release', query: { albumId: 16 } });
    for (const secret of [
      SECRETS.releaseApiKey,
      SECRETS.magnetPasskey,
      SECRETS.guidPasskey,
      SECRETS.infoPasskey,
      SECRETS.magnetGuidPasskey,
    ])
      expect(releases).not.toContain(secret);
    expect(releases).toContain('"guid":"magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567"');
    expect(releases).toContain('"guid":"nzbgeek-1"');
    expect(releases).toContain('"guid":"https://tracker.example/[REDACTED]"');
    expect(releases).toContain('"magnetUrl":"[REDACTED]"');
    const history = await invoke({ path: '/api/v1/history' });
    for (const secret of [SECRETS.guidPasskey, SECRETS.infoPasskey, SECRETS.grabPasskey, SECRETS.magnetGuidPasskey])
      expect(history).not.toContain(secret);
    expect(history).toContain('"DownloadUrl":"[REDACTED]"');
    expect(history).toContain('"nzbInfoUrl":"https://tracker.example/[REDACTED]"');
    expect(history).toContain('"InfoUrl":"https://tracker.example/[REDACTED]"');
  });

  it('reports a rejected key without throwing', async () => {
    const bad = createLidarrPlugin();
    await bad.init({ ...connection(), secrets: { apiKey: 'wrong' }, sdkVersion: '1' });
    expect(await bad.testConnection()).toMatchObject({ ok: false });
    await bad.shutdown?.();
  });
});

describe('provider fields', () => {
  it('keeps hosts, cuts every URL to its origin, hides secret-named values and key/value entries', () => {
    const fields = [
      { name: 'baseUrl', value: 'https://user:pw@idx.example/api?apikey=k', privacy: 'normal' },
      { name: 'url', value: 'https://tracker.example/rss/0123-passkey-uuid', privacy: 'normal' },
      { name: 'plain', value: 'https://idx.example/', privacy: 'normal' },
      { name: 'apiPath', value: '/api', privacy: 'normal' },
      { name: 'botToken', value: 'abc', privacy: 'normal' },
      { name: 'cookie', value: 'uid=1; pass=2', privacy: 'normal' },
      { name: 'authUser', value: 'me', privacy: 'normal' },
      { name: 'seedKey', value: 'k', privacy: 'normal' },
      { name: 'headers', value: [{ key: 'Authorization', value: 'Bearer hdr-secret' }], privacy: 'normal' },
      { name: 'extra', value: { token: 'obj-secret', note: 'x' }, privacy: 'normal' },
      { name: 'categories', value: [2000, 2010], privacy: 'normal' },
    ];
    expect(maskProviderFields({ fields })).toEqual({
      fields: [
        { name: 'baseUrl', value: 'https://idx.example/[REDACTED]', privacy: 'normal' },
        { name: 'url', value: 'https://tracker.example/[REDACTED]', privacy: 'normal' },
        { name: 'plain', value: 'https://idx.example/', privacy: 'normal' },
        { name: 'apiPath', value: '/api', privacy: 'normal' },
        { name: 'botToken', value: '[REDACTED]', privacy: 'normal' },
        { name: 'cookie', value: '[REDACTED]', privacy: 'normal' },
        { name: 'authUser', value: '[REDACTED]', privacy: 'normal' },
        { name: 'seedKey', value: '[REDACTED]', privacy: 'normal' },
        { name: 'headers', value: [{ key: 'Authorization', value: '[REDACTED]' }], privacy: 'normal' },
        { name: 'extra', value: { token: '[REDACTED]', note: '[REDACTED]' }, privacy: 'normal' },
        { name: 'categories', value: [2000, 2010], privacy: 'normal' },
      ],
    });
  });

  it('lists hosts, URL origins and recipients by exact name, first match first, never a secret field', () => {
    expect(
      destinations({
        fields: [
          { name: 'server', value: 'smtp.example' },
          { name: 'to', value: ['a@example.com', 'b@example.com'] },
          { name: 'apiKey', value: 'https://secret.example/' },
          { name: 'url', value: 'https://hooks.example/t/x' },
        ],
      }),
    ).toEqual(['smtp.example', 'a@example.com', 'b@example.com', 'https://hooks.example']);
    expect(destinations({ fields: [{ name: 'Host', value: 'decoy.example' }] })).toEqual([]);
    expect(
      destinations({
        fields: [
          { name: 'host', value: 'real.example' },
          { name: 'host', value: 'decoy.example' },
        ],
      }),
    ).toEqual(['http://real.example']);
  });

  it('hides password-typed fields whatever their name', () => {
    const field = { name: 'pid', value: 'p-123', privacy: 'normal', type: 'Password' };
    expect(maskProviderFields({ fields: [field] })).toEqual({ fields: [{ ...field, value: '[REDACTED]' }] });
  });

  it('lists a URL-shaped host by its origin, without its userinfo', () => {
    expect(destinations({ fields: [{ name: 'host', value: 'http://user:pw@proxy.example:8191/v1' }] })).toEqual([
      'http://proxy.example:8191',
    ]);
  });

  it('cuts a magnet link under a guid, info or comment key to its info hash', () => {
    const keys = ['guid', 'infoUrl', 'commentUrl'];
    expect(
      cutLinksDeep(
        [
          {
            guid: ' magnet:?dn=x&xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=https%3A%2F%2Ft.example%2Fa%2FPASSKEY&xs=y&as=z',
          },
          { InfoURL: 'MAGNET:?tr=https://t.example/a?passkey=PASSKEY' },
          { commentUrl: 'magnet:?xt=urn:btih:ABC&xt=https://t.example/PASSKEY' },
          { guid: 'magnet%3A%3Fxt%3Durn%3Abtih%3AABC%26tr%3Dhttps%3A%2F%2Ft.example%2FPASSKEY' },
          { infoUrl: 'xt=urn:btih:ABC&tr=https://t.example/PASSKEY' },
        ],
        keys,
      ),
    ).toEqual([
      { guid: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' },
      { InfoURL: 'magnet:?[REDACTED]' },
      { commentUrl: 'magnet:?[REDACTED]' },
      { guid: '[REDACTED]' },
      { infoUrl: '[REDACTED]' },
    ]);
  });

  it('lists a host without a scheme without its userinfo', () => {
    expect(
      destinations({
        fields: [
          { name: 'host', value: 'user:pw@nas.lan' },
          { name: 'port', value: 8080 },
        ],
      }),
    ).toEqual(['http://nas.lan:8080']);
  });

  it('drops host userinfo only before the first delimiter, so a fragment or path cannot fake the host', () => {
    const host = (value: string) => destinations({ fields: [{ name: 'host', value }] });
    expect(host('user:pw@nas.lan')).toEqual(['http://nas.lan']);
    for (const value of ['evil.example#@good.example', 'evil.example?@good.example', 'evil.example/@good.example'])
      expect(host(value)[0], value).toMatch(/^http:\/\/evil\.example/);
  });

  it('hides link keys in any case, at any depth', () => {
    expect(
      redactKeysDeep({ records: [{ data: { Url: 'u', DownloadURL: 'v', url: '', title: 't' } }] }, [
        'url',
        'downloadUrl',
      ]),
    ).toEqual({
      records: [{ data: { Url: '[REDACTED]', DownloadURL: '[REDACTED]', url: '', title: 't' } }],
    });
  });

  it('cuts link-shaped guids, info and comment links to their origin in any case, and keeps the others', () => {
    const keys = ['guid', 'infoUrl', 'commentUrl', 'nzbInfoUrl'];
    expect(
      cutLinksDeep(
        [
          { guid: 'https://t.example/download.php?id=1&passkey=EXAMPLE', title: 'a' },
          {
            guid: 'abc-123',
            CommentURL: 'https://t.example/c/1',
            data: { NzbInfoUrl: 'https://t.example/d?passkey=EXAMPLE' },
          },
        ],
        keys,
      ),
    ).toEqual([
      { guid: 'https://t.example/[REDACTED]', title: 'a' },
      {
        guid: 'abc-123',
        CommentURL: 'https://t.example/[REDACTED]',
        data: { NzbInfoUrl: 'https://t.example/[REDACTED]' },
      },
    ]);
  });
});

describe('case-insensitive binding', () => {
  const key = async (request: object) => (await resolve(request)).key;
  const refused = (request: object) =>
    expect(resolve(request)).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });

  it('takes the locked twin whatever the case of the flag or id', async () => {
    const moved = await resolve({ method: 'PUT', path: '/api/v1/artist/1', query: { MoveFiles: 'true' }, body: {} });
    expect(moved).toMatchObject({
      key: 'PUT /api/v1/artist/{id}#move-files',
      params: { query: { moveFiles: 'true' } },
    });
    expect(await key({ method: 'DELETE', path: '/api/v1/artist/1', query: { DELETEFILES: 'True' } })).toBe(
      'DELETE /api/v1/artist/{id}#delete-files',
    );
    expect(
      await key({ method: 'DELETE', path: '/api/v1/artist/editor', body: { ArtistIds: [1], DeleteFiles: true } }),
    ).toBe('DELETE /api/v1/artist/editor#delete-files');
    const stored = await resolve({
      method: 'POST',
      path: '/api/v1/downloadclient/test',
      body: { Id: 5, Name: 'x', Fields: [] },
    });
    expect(stored).toMatchObject({
      key: 'POST /api/v1/downloadclient/test#stored',
      params: { body: { id: 5, name: 'x', fields: [] } },
    });
  });

  it('checks the command name whatever its case, and refuses two spellings', async () => {
    expect(await key({ method: 'POST', path: '/api/v1/command', body: { Name: 'RenameArtist' } })).toBe(
      'POST /api/v1/command#heavy',
    );
    expect(await key({ method: 'POST', path: '/api/v1/command', body: { NAME: 'rsssync' } })).toBe(
      'POST /api/v1/command',
    );
    await refused({ method: 'POST', path: '/api/v1/command', body: { name: 'RssSync', Name: 'RenameArtist' } });
  });

  it('refuses keys that differ only in case in the query, the body, body lists and provider fields', async () => {
    await refused({ method: 'DELETE', path: '/api/v1/artist/1', query: { deleteFiles: false, DeleteFiles: true } });
    await refused({ method: 'PUT', path: '/api/v1/qualitydefinition/update', body: [{ id: 1, Id: 2 }] });
    const fields = (f: unknown[]) => ({
      method: 'POST',
      path: '/api/v1/downloadclient',
      body: { name: 'x', fields: f },
    });
    await refused(
      fields([
        { name: 'host', value: 'a' },
        { name: 'Host', value: 'b' },
      ]),
    );
    await refused(fields([{ name: 'host', value: 'a', Value: 'b' }]));
  });

  it('reads the import script switch whatever its case', async () => {
    const { params } = await resolve({
      method: 'PUT',
      path: '/api/v1/config/mediamanagement/1',
      body: { Id: 1, USESCRIPTIMPORT: true, ScriptImportPath: '/x.sh' },
    });
    expect(params).toMatchObject({ body: { id: 1, useScriptImport: true, scriptImportPath: '/x.sh' } });
  });

  it('spells provider field keys as Lidarr does, so pointers and destinations see them', async () => {
    const { params } = await resolve({
      method: 'POST',
      path: '/api/v1/downloadclient',
      body: { Name: 'x', Fields: [{ Name: 'host', Value: 'sab.lan' }] },
    });
    const { body } = params as { body: unknown };
    expect(body).toEqual({ name: 'x', fields: [{ name: 'host', value: 'sab.lan' }] });
    expect(destinations(body)).toEqual(['http://sab.lan']);
  });
});
