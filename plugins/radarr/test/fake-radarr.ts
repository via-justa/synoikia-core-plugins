import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Radarr v6: X-Api-Key auth on /api/v3, the spec served the way GitHub serves it (under /spec/<ref>/…),
 * generic CRUD for the stored resources the tests touch, and results holding secrets an upstream that stopped
 * masking them would return. */

export const FAKE_API_KEY = 'fake-radarr-api-key-abcdef';
export const CREDENTIALS = { apiKey: FAKE_API_KEY };
export const VERSION = '6.4.4.10685';
export const TAG = `v${VERSION}`;
export const INSTANCE = 'Home Radarr';
export const SPEC_FILE = 'src/Radarr.Api.V3/openapi.json';

export const SPEC_TEXT = readFileSync(new URL('./fixtures/radarr-openapi.json', import.meta.url), 'utf8');

export const SECRETS = {
  clientPassword: 'qbit-password-111111',
  indexerApiKey: 'indexer-api-key-222222',
  webhookToken: 'discord-webhook-token-333333',
  hostApiKey: 'radarr-host-api-key-444444',
  proxyPassword: 'proxy-password-555555',
  releaseApiKey: 'release-url-apikey-666666',
  listApiKey: 'other-radarr-api-key-777777',
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
    movie: [
      { id: 1, title: 'Inception', year: 2010, tmdbId: 27205, path: '/movies/Inception (2010)', monitored: true },
      { id: 2, title: 'Arrival', year: 2016, tmdbId: 329865, path: '/movies/Arrival (2016)', monitored: true },
    ],
    tag: [{ id: 3, label: 'kids' }],
    qualityprofile: [{ id: 4, name: 'HD-1080p' }],
    rootfolder: [{ id: 5, path: '/movies', freeSpace: 1 }],
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
          field('username', 'radarr', 'userName'),
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
        name: 'Radarr 4K',
        implementation: 'RadarrImport',
        fields: [field('baseUrl', 'http://radarr-4k.lan:7878'), field('apiKey', SECRETS.listApiKey, 'apiKey')],
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
          field('url', 'https://hooks.example.com/radarr'),
          field('headers', [{ key: 'Authorization', value: `Bearer ${SECRETS.headerToken}` }]),
        ],
      },
    ],
    metadata: [{ id: 10, name: 'Kodi (XBMC) / Emby', implementation: 'XbmcMetadata', fields: [] }],
    customformat: [{ id: 11, name: 'x265' }],
    exclusions: [{ id: 12, movieTitle: 'Cats', tmdbId: 536869 }],
    moviefile: [{ id: 13, movieId: 1, relativePath: 'Inception (2010).mkv' }],
    blocklist: [{ id: 61, movieId: 1, sourceTitle: 'Inception.2010.CAM' }],
  };
}

export interface FakeRadarr extends FakeHttp {
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

const API = '/api/v3';

export async function startFakeRadarr(): Promise<FakeRadarr> {
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
  const backups = [{ id: 21, name: 'radarr_backup_v6.4.4.10685_2026.10.14_10.00.00.zip', type: 'scheduled' }];
  let media: Record<string, unknown> = {
    id: 1,
    useScriptImport: false,
    scriptImportPath: '/config/scripts/import.sh',
    recycleBin: '',
  };
  let host: Record<string, unknown> = {
    id: 1,
    bindAddress: '*',
    port: 7878,
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
        body: { appName: 'Radarr', instanceName: INSTANCE, version: state.version, urlBase: '' },
      }),
      [`POST ${API}/system/shutdown`]: () => ({ body: {} }),
      [`POST ${API}/system/restart`]: () => ({ body: {} }),
      [`GET ${API}/system/backup`]: () => ({ body: backups }),
      [`DELETE ${API}/system/backup/{id}`]: () => ({ body: {} }),
      [`POST ${API}/system/backup/restore/{id}`]: () => ({ body: { restartRequired: true } }),
      [`GET ${API}/config/host`]: () => ({ body: host }),
      [`GET ${API}/config/mediamanagement`]: () => ({ body: media }),
      [`PUT ${API}/config/mediamanagement/{id}`]: (req) => {
        media = { ...media, ...(req.body as object) };
        return { status: 202, body: media };
      },
      [`GET ${API}/config/host/{id}`]: () => ({ body: host }),
      [`PUT ${API}/config/host/{id}`]: (req) => {
        host = { ...host, ...(req.body as object) };
        return { status: 202, body: host };
      },
      [`GET ${API}/movie/lookup`]: (req) => ({
        body: [{ title: 'Dune', year: 2021, tmdbId: 438631, searchTerm: req.query.get('term') }],
      }),
      [`PUT ${API}/movie/editor`]: () => ({ status: 202, body: {} }),
      [`DELETE ${API}/movie/editor`]: () => ({ body: {} }),
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
      [`GET ${API}/queue/details`]: () => ({ body: [{ id: 41, title: 'Inception.2010.1080p.BluRay', movieId: 1 }] }),
      [`DELETE ${API}/queue/{id}`]: () => ({ body: {} }),
      [`DELETE ${API}/queue/bulk`]: () => ({ body: {} }),
      [`GET ${API}/release`]: () => ({
        body: [
          {
            guid: 'nzbgeek-1',
            title: 'Inception.2010.1080p',
            indexerId: 7,
            downloadUrl: `https://api.nzbgeek.info/api?t=get&id=1&apikey=${SECRETS.releaseApiKey}`,
          },
          {
            guid: `https://tracker.example/download.php?id=9&passkey=${SECRETS.guidPasskey}`,
            title: 'Inception.2010.2160p',
            indexerId: 15,
            protocol: 'torrent',
            infoUrl: `https://tracker.example/details/9?passkey=${SECRETS.infoPasskey}`,
            commentUrl: 'https://tracker.example/comments/9',
            downloadUrl: `https://tracker.example/download.php?id=9&passkey=${SECRETS.guidPasskey}`,
            magnetUrl: `magnet:?xt=urn:btih:EXAMPLE&tr=https://tracker.example/announce?passkey=${SECRETS.magnetPasskey}`,
          },
          {
            guid: `magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=EXAMPLE&tr=https%3A%2F%2Ftracker.example%2Fannounce%2F${SECRETS.magnetGuidPasskey}`,
            title: 'Inception.2010.720p',
            indexerId: 15,
            protocol: 'torrent',
          },
        ],
      }),
      [`POST ${API}/release/push`]: () => ({ body: [{ approved: true }] }),
      [`GET ${API}/calendar`]: () => ({ body: [{ id: 2, title: 'Arrival', inCinemas: '2016-11-11' }] }),
      [`GET ${API}/wanted/missing`]: () => ({ body: { page: 1, pageSize: 10, totalRecords: 1, records: [{ id: 2 }] } }),
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
