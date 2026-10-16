import { readFileSync } from 'node:fs';
import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake Prowlarr v2: X-Api-Key auth on /api/v1, the spec served the way GitHub serves it (under /spec/<ref>/…),
 * generic CRUD for the stored resources the tests touch, and results holding secrets an upstream returns unmasked
 * (Cardigann settings, search links, history URLs) or would if it stopped masking them. */

export const FAKE_API_KEY = 'fake-prowlarr-api-key-abcdef';
export const CREDENTIALS = { apiKey: FAKE_API_KEY };
export const VERSION = '2.6.5.5623';
export const TAG = `v${VERSION}`;
export const INSTANCE = 'Home Prowlarr';
export const SPEC_FILE = 'src/Prowlarr.Api.V1/openapi.json';

export const SPEC_TEXT = readFileSync(new URL('./fixtures/prowlarr-openapi.json', import.meta.url), 'utf8');

export const SECRETS = {
  clientPassword: 'qbit-password-111111',
  indexerApiKey: 'indexer-api-key-222222',
  webhookToken: 'discord-webhook-token-333333',
  hostApiKey: 'prowlarr-host-api-key-444444',
  proxyPassword: 'proxy-password-555555',
  appApiKey: 'sonarr-api-key-666666',
  cardigannPassword: 'tracker-password-777777',
  headerToken: 'webhook-header-token-888888',
  trackerPasskey: 'tracker-passkey-999999',
  trackerCookie: 'tracker-cookie-101010',
  twoFactor: 'two-factor-424242',
  socksPassword: 'socks-password-121212',
  trackerPid: 'tracker-pid-151515',
  grabPasskey: 'grab-passkey-161616',
  infoPasskey: 'info-passkey-171717',
  magnetGuidPasskey: 'EXAMPLE-magnet-guid-passkey-222222',
};

type Row = Record<string, unknown> & { id: number };

const field = (name: string, value: unknown, privacy = 'normal', type = 'textbox') => ({ name, value, privacy, type });

/** The stored rows every test starts from. */
export function seed(): Record<string, Row[]> {
  return {
    indexer: [
      {
        id: 1,
        name: 'NZBgeek',
        implementation: 'Newznab',
        protocol: 'usenet',
        privacy: 'private',
        enable: true,
        fields: [
          field('baseUrl', 'https://api.nzbgeek.info'),
          field('apiPath', '/api'),
          field('apiKey', SECRETS.indexerApiKey, 'apiKey'),
        ],
      },
      {
        id: 2,
        name: 'PrivateHD',
        implementation: 'Cardigann',
        definitionName: 'privatehd',
        protocol: 'torrent',
        privacy: 'private',
        enable: true,
        fields: [
          field('definitionFile', 'privatehd'),
          field('baseUrl', `https://privatehd.example/?passkey=${SECRETS.trackerPasskey}`, 'normal', 'select'),
          field('username', 'me'),
          field('password', SECRETS.cardigannPassword, 'normal', 'password'),
          field('cookie', SECRETS.trackerCookie),
          field('passkey', SECRETS.trackerPasskey),
          field('2facode', SECRETS.twoFactor),
          field('pid', SECRETS.trackerPid),
          field('freeleech', false, 'normal', 'checkbox'),
          field('sort', 2, 'normal', 'select'),
        ],
        downloadClientId: 6,
      },
      {
        id: 3,
        name: 'Tracker RSS',
        implementation: 'TorrentRssIndexer',
        protocol: 'torrent',
        privacy: 'private',
        enable: false,
        fields: [field('baseUrl', `https://tracker.example/rss/${SECRETS.trackerPasskey}`)],
      },
    ],
    applications: [
      {
        id: 4,
        name: 'Sonarr',
        implementation: 'Sonarr',
        syncLevel: 'fullSync',
        fields: [
          field('prowlarrUrl', 'http://prowlarr:9696'),
          field('baseUrl', 'http://sonarr:8989'),
          field('apiKey', SECRETS.appApiKey, 'apiKey'),
          field('syncCategories', [5000, 5040]),
        ],
      },
    ],
    indexerproxy: [
      {
        id: 5,
        name: 'FlareSolverr',
        implementation: 'FlareSolverr',
        tags: [12],
        fields: [field('host', 'http://flaresolverr:8191/'), field('requestTimeout', 60)],
      },
      {
        id: 10,
        name: 'Socks',
        implementation: 'Socks5',
        tags: [],
        fields: [
          field('host', 'socks.lan'),
          field('port', 1080),
          field('username', 'prowlarr', 'userName'),
          field('password', SECRETS.socksPassword, 'password'),
        ],
      },
    ],
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
          field('username', 'prowlarr', 'userName'),
          field('password', SECRETS.clientPassword, 'password'),
        ],
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
          field('url', 'https://hooks.example.com/prowlarr'),
          field('headers', [{ key: 'Authorization', value: `Bearer ${SECRETS.headerToken}` }]),
        ],
      },
    ],
    appprofile: [{ id: 11, name: 'Standard', enableRss: true, enableInteractiveSearch: true }],
    tag: [{ id: 12, label: 'flaresolverr' }],
    customfilter: [{ id: 13, type: 'indexers', label: 'Torrents', filters: [] }],
  };
}

export interface FakeProwlarr extends FakeHttp {
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
const proxyLink = (indexerId: number, title: string) =>
  `http://prowlarr:9696/${indexerId}/download?apikey=${SECRETS.hostApiKey}&link=ENCRYPTED&file=${title}`;

export async function startFakeProwlarr(): Promise<FakeProwlarr> {
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
  const backups = [{ id: 21, name: 'prowlarr_backup_v2.6.5.5623_2026.10.15_10.00.00.zip', type: 'scheduled' }];
  let host: Record<string, unknown> = {
    id: 1,
    bindAddress: '*',
    port: 9696,
    urlBase: '',
    instanceName: INSTANCE,
    authenticationMethod: 'forms',
    username: 'admin',
    password: 'hashed-password',
    apiKey: SECRETS.hostApiKey,
    proxyPassword: SECRETS.proxyPassword,
  };
  const releases = [
    {
      guid: `https://privatehd.example/download.php?id=7&passkey=${SECRETS.trackerPasskey}`,
      indexerId: 2,
      indexer: 'PrivateHD',
      title: 'Dune.2021.2160p',
      protocol: 'torrent',
      seeders: 40,
      infoUrl: 'https://privatehd.example/details/7',
      commentUrl: `https://privatehd.example/comments/7?passkey=${SECRETS.trackerPasskey}`,
      downloadUrl: proxyLink(2, 'Dune.2021.2160p'),
      magnetUrl: proxyLink(2, 'Dune.2021.2160p-magnet'),
    },
    {
      guid: 'nzbgeek-guid-1',
      indexerId: 1,
      indexer: 'NZBgeek',
      title: 'Dune.2021.1080p',
      protocol: 'usenet',
      downloadUrl: proxyLink(1, 'Dune.2021.1080p'),
    },
    {
      guid: `magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=EXAMPLE&tr=https%3A%2F%2Ftracker.example%2Fannounce%2F${SECRETS.magnetGuidPasskey}`,
      indexerId: 2,
      indexer: 'PrivateHD',
      title: 'Dune.2021.720p',
      protocol: 'torrent',
    },
  ];

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
        body: { appName: 'Prowlarr', instanceName: INSTANCE, version: state.version, urlBase: '' },
      }),
      [`POST ${API}/system/shutdown`]: () => ({ body: {} }),
      [`POST ${API}/system/restart`]: () => ({ body: {} }),
      [`GET ${API}/system/backup`]: () => ({ body: backups }),
      [`DELETE ${API}/system/backup/{id}`]: () => ({ body: {} }),
      [`POST ${API}/system/backup/restore/{id}`]: () => ({ body: { restartRequired: true } }),
      [`GET ${API}/config/development`]: () => ({ body: { id: 1, logIndexerResponse: false, logSql: false } }),
      [`GET ${API}/config/development/{id}`]: () => ({ body: { id: 1, logIndexerResponse: false, logSql: false } }),
      [`PUT ${API}/config/development/{id}`]: (req) => ({ status: 202, body: req.body }),
      [`GET ${API}/config/host`]: () => ({ body: host }),
      [`GET ${API}/config/host/{id}`]: () => ({ body: host }),
      [`PUT ${API}/config/host/{id}`]: (req) => {
        host = { ...host, ...(req.body as object) };
        return { status: 202, body: host };
      },
      [`GET ${API}/search`]: (req) => ({
        body: releases.filter((r) => !req.query.get('indexerIds') || req.query.get('indexerIds') === `${r.indexerId}`),
      }),
      [`POST ${API}/search`]: (req) => ({ body: req.body }),
      [`POST ${API}/search/bulk`]: (req) => ({ body: req.body }),
      [`GET ${API}/history`]: () => ({
        body: {
          page: 1,
          pageSize: 10,
          totalRecords: 3,
          records: [
            {
              id: 51,
              indexerId: 1,
              eventType: 'indexerQuery',
              successful: true,
              data: {
                query: 'dune',
                url: `https://api.nzbgeek.info/api?t=search&q=dune&apikey=${SECRETS.indexerApiKey}`,
              },
            },
            {
              id: 52,
              indexerId: 2,
              eventType: 'releaseGrabbed',
              successful: true,
              data: {
                grabTitle: 'Dune.2021.2160p',
                url: `https://privatehd.example/download.php?id=7&passkey=${SECRETS.trackerPasskey}`,
              },
            },
            {
              id: 53,
              indexerId: 2,
              eventType: 'releaseGrabbed',
              successful: true,
              // An upstream that stopped camel-casing dictionary keys.
              data: {
                GrabTitle: 'Dune.2021.720p',
                Url: `https://privatehd.example/dl/${SECRETS.grabPasskey}`,
                InfoUrl: `https://privatehd.example/details/8?passkey=${SECRETS.infoPasskey}`,
              },
            },
          ],
        },
      }),
      [`GET ${API}/indexerstats`]: () => ({
        body: { indexers: [{ indexerId: 1, indexerName: 'NZBgeek', numberOfQueries: 12, numberOfGrabs: 3 }] },
      }),
      [`GET ${API}/indexerstatus`]: () => ({ body: [{ id: 1, indexerId: 3, disabledTill: '2026-10-15T12:00:00Z' }] }),
      [`GET ${API}/health`]: () => ({ body: [{ source: 'IndexerStatusCheck', type: 'warning', message: '1 down' }] }),
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
      [`POST ${API}/{resource}/test`]: () => ({ body: {} }),
      [`POST ${API}/{resource}/testall`]: () => ({ body: [] }),
      [`POST ${API}/{resource}/action/{name}`]: () => ({ body: { options: [] } }),
      [`PUT ${API}/{resource}/bulk`]: () => ({ status: 202, body: [] }),
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
