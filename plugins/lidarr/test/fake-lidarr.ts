import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Lidarr v3: X-Api-Key auth on /api/v1, the spec served the way GitHub serves it (under /spec/<ref>/…),
 * generic CRUD for the stored resources the tests touch, and results holding secrets an upstream that stopped
 * masking them would return. */

export const FAKE_API_KEY = 'fake-lidarr-api-key-abcdef';
export const CREDENTIALS = { apiKey: FAKE_API_KEY };
export const VERSION = '3.1.6.5078';
export const TAG = `v${VERSION}`;
export const INSTANCE = 'Home Lidarr';
export const SPEC_FILE = 'src/Lidarr.Api.V1/openapi.json';

export const SPEC_TEXT = readFileSync(new URL('./fixtures/lidarr-openapi.json', import.meta.url), 'utf8');

export const SECRETS = {
  clientPassword: 'qbit-password-111111',
  indexerApiKey: 'indexer-api-key-222222',
  webhookToken: 'discord-webhook-token-333333',
  hostApiKey: 'lidarr-host-api-key-444444',
  proxyPassword: 'proxy-password-555555',
  releaseApiKey: 'release-url-apikey-666666',
  listApiKey: 'other-lidarr-api-key-777777',
  spotifyToken: 'spotify-refresh-token-131313',
  headerToken: 'webhook-header-token-888888',
  trackerPasskey: 'tracker-passkey-999999',
  trackerCookie: 'tracker-cookie-101010',
  magnetPasskey: 'EXAMPLE-magnet-passkey-181818',
  guidPasskey: 'EXAMPLE-guid-passkey-191919',
  infoPasskey: 'EXAMPLE-info-passkey-202020',
  grabPasskey: 'EXAMPLE-grab-passkey-212121',
  magnetGuidPasskey: 'EXAMPLE-magnet-guid-passkey-222222',
};

type Row = Record<string, unknown> & { id: number };

const field = (name: string, value: unknown, privacy = 'normal') => ({ name, value, privacy });

/** The stored rows every test starts from. */
export function seed(): Record<string, Row[]> {
  return {
    artist: [
      {
        id: 1,
        artistName: 'Radiohead',
        foreignArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
        path: '/music/Radiohead',
        monitored: true,
      },
      {
        id: 2,
        artistName: 'Björk',
        foreignArtistId: '87c5dedd-371d-4a53-9f7f-80522fb7f3cb',
        path: '/music/Björk',
        monitored: true,
      },
    ],
    album: [
      {
        id: 16,
        title: 'OK Computer',
        artistId: 1,
        foreignAlbumId: 'b1392450-e666-3926-a536-22c65f834433',
        artist: { id: 1, artistName: 'Radiohead' },
      },
    ],
    trackfile: [
      { id: 13, artistId: 1, albumId: 16, path: '/music/Radiohead/OK Computer (1997)/01 - Airbag.flac' },
      { id: 17, artistId: 1, albumId: 16, path: '/music/Radiohead/OK Computer (1997)/02 - Paranoid Android.flac' },
    ],
    metadataprofile: [{ id: 18, name: 'Standard' }],
    tag: [{ id: 3, label: 'kids' }],
    qualityprofile: [{ id: 4, name: 'HD-1080p' }],
    rootfolder: [{ id: 5, name: 'Music', path: '/music', freeSpace: 1 }],
    downloadclient: [
      {
        id: 6,
        name: 'qBit',
        implementation: 'QBittorrent',
        enable: true,
        fields: [
          field('host', 'qbittorrent.lan'),
          field('port', 8080),
          field('useSsl', false),
          field('username', 'lidarr', 'userName'),
          field('password', SECRETS.clientPassword, 'password'),
        ],
      },
    ],
    indexer: [
      {
        id: 7,
        name: 'NZBgeek',
        implementation: 'Newznab',
        fields: [field('baseUrl', 'https://api.nzbgeek.info'), field('apiKey', SECRETS.indexerApiKey, 'apiKey')],
      },
      {
        id: 15,
        name: 'Tracker',
        implementation: 'TorrentRssIndexer',
        fields: [
          field('baseUrl', `https://tracker.example/rss/${SECRETS.trackerPasskey}`),
          field('cookie', SECRETS.trackerCookie),
        ],
      },
    ],
    importlist: [
      {
        id: 8,
        name: 'Lidarr Lossless',
        implementation: 'LidarrImport',
        fields: [field('baseUrl', 'http://lidarr-flac.lan:8686'), field('apiKey', SECRETS.listApiKey, 'apiKey')],
      },
      {
        id: 19,
        name: 'Spotify',
        implementation: 'SpotifySavedAlbums',
        fields: [field('accessToken', 'x'), field('refreshToken', SECRETS.spotifyToken), field('expires', '')],
      },
    ],
    notification: [
      {
        id: 9,
        name: 'Discord',
        implementation: 'Discord',
        fields: [field('webHookUrl', `https://discord.com/api/webhooks/42/${SECRETS.webhookToken}`)],
      },
      {
        id: 14,
        name: 'Hook',
        implementation: 'Webhook',
        fields: [
          field('url', 'https://hooks.example.com/lidarr'),
          field('headers', [{ key: 'Authorization', value: `Bearer ${SECRETS.headerToken}` }]),
        ],
      },
    ],
    metadata: [{ id: 10, name: 'Kodi (XBMC) / Emby', implementation: 'XbmcMetadata', fields: [] }],
    customformat: [{ id: 11, name: 'x265' }],
    importlistexclusion: [{ id: 12, artistName: 'Nickelback', foreignId: '0f1dd3a4-27e4-4e5e-8aab-8e8f50bfe4b6' }],
    blocklist: [{ id: 61, artistId: 1, sourceTitle: 'Radiohead-OK.Computer-WEB-1997' }],
  };
}

export interface FakeLidarr extends FakeHttp {
  store: Map<string, Map<number, Row>>;
  /** Base URL for the plugin's `specBaseUrl`. */
  specUrl: string;
  /** Git refs that have a spec; others 404. */
  specRefs: Set<string>;
  specFetches: string[];
  /** Replaces the served spec (to test validation). */
  specText?: string;
  /** The version /system/status reports. */
  version: string;
  /** Paths answered 403. */
  denied: Set<string>;
  commands: Row[];
  reset(): void;
}

const API = '/api/v1';

export async function startFakeLidarr(): Promise<FakeLidarr> {
  const store = new Map<string, Map<number, Row>>();
  const commands: Row[] = [];
  const reset = () => {
    store.clear();
    for (const [name, rows] of Object.entries(seed())) store.set(name, new Map(rows.map((r) => [r.id, { ...r }])));
    commands.length = 0;
  };
  reset();
  let nextId = 100;
  const table = (name: string) => store.get(name) ?? store.set(name, new Map()).get(name)!;
  const row = (req: FakeRequest) => table(req.params.resource ?? '').get(Number(req.params.id));
  const notFound: FakeResponse = { status: 404, body: { message: 'NotFound' } };
  const backups = [{ id: 21, name: 'lidarr_backup_v3.1.6.5078_2026.10.14_10.00.00.zip', type: 'scheduled' }];
  const metadataProvider = { id: 1, metadataSource: '', writeAudioTags: 'no', scrubAudioTags: false };
  let host: Record<string, unknown> = {
    id: 1,
    bindAddress: '*',
    port: 8686,
    urlBase: '',
    instanceName: INSTANCE,
    authenticationMethod: 'forms',
    username: 'admin',
    password: 'hashed-password',
    apiKey: SECRETS.hostApiKey,
    proxyPassword: SECRETS.proxyPassword,
  };

  const state = {
    specRefs: new Set(['develop', TAG]),
    specFetches: [] as string[],
    specText: undefined as string | undefined,
    version: VERSION,
    denied: new Set<string>(),
  };

  const fake = await startFakeHttp({
    guard: (req) => {
      if (req.path.startsWith('/spec/')) return undefined;
      if (req.headers['x-api-key'] !== FAKE_API_KEY) return { status: 401, body: { message: 'Unauthorized' } };
      return state.denied.has(req.path) ? { status: 403, body: { message: 'Forbidden' } } : undefined;
    },
    routes: {
      [`GET /spec/{ref}/${SPEC_FILE}`]: ({ params }) => {
        state.specFetches.push(params.ref ?? '');
        if (!state.specRefs.has(params.ref ?? '')) return { status: 404, body: '404: Not Found' };
        return { body: state.specText ?? SPEC_TEXT, headers: { 'content-type': 'text/plain' } };
      },
      [`GET ${API}/system/status`]: () => ({
        body: { appName: 'Lidarr', instanceName: INSTANCE, version: state.version, urlBase: '' },
      }),
      [`POST ${API}/system/shutdown`]: () => ({ body: {} }),
      [`POST ${API}/system/restart`]: () => ({ body: {} }),
      [`GET ${API}/system/backup`]: () => ({ body: backups }),
      [`DELETE ${API}/system/backup/{id}`]: () => ({ body: {} }),
      [`POST ${API}/system/backup/restore/{id}`]: () => ({ body: { restartRequired: true } }),
      [`GET ${API}/config/host`]: () => ({ body: host }),
      [`GET ${API}/config/host/{id}`]: () => ({ body: host }),
      [`PUT ${API}/config/host/{id}`]: (req) => {
        host = { ...host, ...(req.body as object) };
        return { status: 202, body: host };
      },
      [`GET ${API}/artist/lookup`]: (req) => ({
        body: [
          {
            artistName: 'Portishead',
            foreignArtistId: '8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11',
            searchTerm: req.query.get('term'),
          },
        ],
      }),
      [`PUT ${API}/artist/editor`]: () => ({ status: 202, body: [] }),
      [`DELETE ${API}/artist/editor`]: () => ({ body: {} }),
      [`DELETE ${API}/trackfile/bulk`]: () => ({ body: {} }),
      [`GET ${API}/config/mediamanagement`]: () => ({
        body: { id: 1, useScriptImport: false, scriptImportPath: '/config/scripts/import.sh' },
      }),
      [`PUT ${API}/config/mediamanagement/{id}`]: (req) => ({ status: 202, body: req.body }),
      [`GET ${API}/config/metadataprovider`]: () => ({ body: metadataProvider }),
      [`PUT ${API}/config/metadataprovider/{id}`]: (req) => ({
        status: 202,
        body: { ...metadataProvider, ...(req.body as object) },
      }),
      [`POST ${API}/command`]: (req) => {
        const name = (req.body as { name?: unknown } | undefined)?.name;
        const cmd = { id: commands.length + 31, name, status: 'queued' };
        commands.push(cmd);
        return { status: 201, body: cmd };
      },
      [`GET ${API}/command/{id}`]: (req) => {
        const cmd = commands.find((c) => c.id === Number(req.params.id));
        return cmd ? { body: { ...cmd, status: 'completed' } } : notFound;
      },
      [`GET ${API}/queue`]: () => ({ body: { page: 1, pageSize: 10, totalRecords: 1, records: [{ id: 41 }] } }),
      [`GET ${API}/queue/details`]: () => ({
        body: [{ id: 41, title: 'Radiohead-OK.Computer-OKNOTOK-24BIT-WEB-FLAC-2017', artistId: 1 }],
      }),
      [`DELETE ${API}/queue/{id}`]: () => ({ body: {} }),
      [`DELETE ${API}/queue/bulk`]: () => ({ body: {} }),
      [`GET ${API}/release`]: () => ({
        body: [
          {
            guid: 'nzbgeek-1',
            title: 'Radiohead-OK.Computer-1997-FLAC',
            indexerId: 7,
            downloadUrl: `https://api.nzbgeek.info/api?t=get&id=1&apikey=${SECRETS.releaseApiKey}`,
          },
          {
            guid: `https://tracker.example/download.php?id=9&passkey=${SECRETS.guidPasskey}`,
            title: 'Radiohead-OK.Computer-1997-24bit',
            indexerId: 15,
            protocol: 'torrent',
            infoUrl: `https://tracker.example/details/9?passkey=${SECRETS.infoPasskey}`,
            commentUrl: 'https://tracker.example/comments/9',
            downloadUrl: `https://tracker.example/download.php?id=9&passkey=${SECRETS.guidPasskey}`,
            magnetUrl: `magnet:?xt=urn:btih:EXAMPLE&tr=https://tracker.example/announce?passkey=${SECRETS.magnetPasskey}`,
          },
          {
            guid: `magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=EXAMPLE&tr=https%3A%2F%2Ftracker.example%2Fannounce%2F${SECRETS.magnetGuidPasskey}`,
            title: 'Radiohead-OK.Computer-1997-MP3',
            indexerId: 15,
            protocol: 'torrent',
          },
        ],
      }),
      [`POST ${API}/release/push`]: () => ({ body: [{ approved: true }] }),
      [`GET ${API}/calendar`]: () => ({ body: [{ id: 16, title: 'OK Computer', releaseDate: '1997-05-21' }] }),
      [`GET ${API}/wanted/missing`]: () => ({
        body: { page: 1, pageSize: 10, totalRecords: 1, records: [{ id: 16 }] },
      }),
      [`GET ${API}/history`]: () => ({
        body: {
          page: 1,
          records: [
            {
              id: 51,
              eventType: 'grabbed',
              data: {
                indexer: 'Tracker',
                downloadUrl: `https://tracker.example/download.php?id=9&passkey=${SECRETS.guidPasskey}`,
                guid: `https://tracker.example/download.php?id=9&passkey=${SECRETS.guidPasskey}`,
                nzbInfoUrl: `https://tracker.example/details/9?passkey=${SECRETS.infoPasskey}`,
              },
            },
            {
              id: 52,
              eventType: 'grabbed',
              // An upstream that stopped camel-casing dictionary keys.
              data: {
                Indexer: 'Tracker',
                DownloadUrl: `https://tracker.example/dl/${SECRETS.grabPasskey}`,
                InfoUrl: `https://tracker.example/details/8?passkey=${SECRETS.infoPasskey}`,
              },
            },
            {
              id: 53,
              eventType: 'grabbed',
              data: {
                indexer: 'Tracker',
                guid: `magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=EXAMPLE&tr=https%3A%2F%2Ftracker.example%2Fannounce%2F${SECRETS.magnetGuidPasskey}`,
              },
            },
          ],
        },
      }),
      [`POST ${API}/{resource}/test`]: () => ({ body: {} }),
      [`POST ${API}/{resource}/testall`]: () => ({ body: [] }),
      [`POST ${API}/{resource}/action/{name}`]: () => ({ body: { options: [] } }),
      [`DELETE ${API}/{resource}/bulk`]: () => ({ body: {} }),
      [`GET ${API}/{resource}`]: (req) => ({ body: [...table(req.params.resource ?? '').values()] }),
      [`POST ${API}/{resource}`]: (req) => {
        const created = { ...(req.body as object), id: nextId++ };
        table(req.params.resource ?? '').set(created.id, created);
        return { status: 201, body: created };
      },
      [`GET ${API}/{resource}/{id}`]: (req) => {
        const r = row(req);
        return r ? { body: r } : notFound;
      },
      [`PUT ${API}/{resource}/{id}`]: (req) => {
        const r = row(req);
        if (!r) return notFound;
        const updated = { ...r, ...(req.body as object), id: r.id };
        table(req.params.resource ?? '').set(r.id, updated);
        return { status: 202, body: updated };
      },
      [`DELETE ${API}/{resource}/{id}`]: (req) => {
        const r = row(req);
        if (!r) return notFound;
        table(req.params.resource ?? '').delete(r.id);
        return { body: {} };
      },
    },
  });

  // Tests change `state` in place (version, specText, denied), so it is the object returned.
  return Object.assign(state, {
    url: fake.url,
    requests: fake.requests,
    close: () => fake.close(),
    store,
    commands,
    reset,
    specUrl: `${fake.url}/spec`,
  });
}
