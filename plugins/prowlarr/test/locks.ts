import { INSTANCE } from './fake-prowlarr.js';

/** One call per locked key (every key plugin.yaml locks by name, every split twin, and a sample of the deletes the
 * `DELETE *` rule locks), and the literal an approver must type for it against the fake Prowlarr. */
export interface LockCase {
  key: string;
  request: { method: string; path: string; body?: unknown; query?: Record<string, unknown> };
  confirm: string;
}

/** Secrets the lock-case bodies carry; no approval text may show them. */
export const BODY_SECRETS = ['sab-key-777777', 'idx-key-888888', 'secret-hook-999999', 'radarr-key-131313'];

const BACKUP = 'prowlarr_backup_v2.6.5.5623_2026.10.15_10.00.00.zip';
const field = (name: string, value: unknown, privacy = 'normal') => ({ name, value, privacy });
const provider = (name: string, implementation: string, fields: unknown[], id?: number) => ({
  ...(id ? { id } : {}),
  name,
  implementation,
  enable: true,
  fields,
});
const EVIL = [
  field('host', 'collector.example'),
  field('port', 443),
  field('useSsl', true),
  field('password', '********', 'password'),
];
const RADARR = [
  field('prowlarrUrl', 'http://prowlarr.lan:9696'),
  field('baseUrl', 'http://radarr.lan:7878'),
  field('apiKey', 'radarr-key-131313', 'apiKey'),
];

export const LOCK_CASES: LockCase[] = [
  {
    key: 'PUT /api/v1/config/host/{id}',
    request: { method: 'PUT', path: '/api/v1/config/host/1', body: { id: 1, bindAddress: '*', urlBase: '/prowlarr' } },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/system/shutdown',
    request: { method: 'POST', path: '/api/v1/system/shutdown' },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/system/restart',
    request: { method: 'POST', path: '/api/v1/system/restart' },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/system/backup/restore/{id}',
    request: { method: 'POST', path: '/api/v1/system/backup/restore/21' },
    confirm: BACKUP,
  },
  {
    key: 'DELETE /api/v1/system/backup/{id}',
    request: { method: 'DELETE', path: '/api/v1/system/backup/21' },
    confirm: BACKUP,
  },
  {
    key: 'POST /api/v1/downloadclient',
    request: {
      method: 'POST',
      path: '/api/v1/downloadclient',
      body: provider('SAB', 'Sabnzbd', [
        field('host', 'sab.lan'),
        field('port', 8085),
        field('apiKey', 'sab-key-777777', 'apiKey'),
      ]),
    },
    confirm: 'SAB',
  },
  {
    key: 'PUT /api/v1/downloadclient/{id}',
    request: { method: 'PUT', path: '/api/v1/downloadclient/6', body: provider('Renamed', 'QBittorrent', EVIL, 6) },
    confirm: 'qBit',
  },
  {
    key: 'POST /api/v1/indexer',
    request: {
      method: 'POST',
      path: '/api/v1/indexer',
      body: provider('Geek2', 'Newznab', [
        field('baseUrl', 'https://api.example.org'),
        field('apiKey', 'idx-key-888888', 'apiKey'),
      ]),
    },
    confirm: 'Geek2',
  },
  {
    key: 'PUT /api/v1/indexer/{id}',
    request: {
      method: 'PUT',
      path: '/api/v1/indexer/1',
      body: provider('Not NZBgeek', 'Newznab', [field('baseUrl', 'https://collector.example')], 1),
    },
    confirm: 'NZBgeek',
  },
  {
    key: 'PUT /api/v1/indexer/bulk',
    request: { method: 'PUT', path: '/api/v1/indexer/bulk', body: { ids: [1, 2], tags: [12], applyTags: 'add' } },
    confirm: '2 indexers',
  },
  {
    key: 'POST /api/v1/indexerproxy',
    request: {
      method: 'POST',
      path: '/api/v1/indexerproxy',
      body: { ...provider('Collector', 'Http', [field('host', 'collector.example'), field('port', 3128)]), tags: [] },
    },
    confirm: 'Collector',
  },
  {
    key: 'PUT /api/v1/indexerproxy/{id}',
    request: {
      method: 'PUT',
      path: '/api/v1/indexerproxy/5',
      body: provider('FlareSolverr', 'FlareSolverr', [field('host', 'https://collector.example/v1')], 5),
    },
    confirm: 'FlareSolverr',
  },
  {
    key: 'POST /api/v1/notification',
    request: {
      method: 'POST',
      path: '/api/v1/notification',
      body: provider('Hook', 'Webhook', [field('url', 'https://hooks.example.com/t/secret-hook-999999')]),
    },
    confirm: 'Hook',
  },
  {
    key: 'PUT /api/v1/notification/{id}',
    request: { method: 'PUT', path: '/api/v1/notification/9', body: provider('Discord', 'Discord', [], 9) },
    confirm: 'Discord',
  },
  {
    key: 'POST /api/v1/applications',
    request: {
      method: 'POST',
      path: '/api/v1/applications',
      body: { ...provider('Radarr', 'Radarr', RADARR), syncLevel: 'fullSync' },
    },
    confirm: 'Radarr',
  },
  {
    key: 'PUT /api/v1/applications/{id}',
    request: {
      method: 'PUT',
      path: '/api/v1/applications/4',
      body: provider('Renamed', 'Sonarr', [field('baseUrl', 'https://collector.example')], 4),
    },
    confirm: 'Sonarr',
  },
  {
    key: 'PUT /api/v1/applications/bulk',
    request: { method: 'PUT', path: '/api/v1/applications/bulk', body: { ids: [4], syncLevel: 'fullSync' } },
    confirm: '1 application',
  },
  {
    key: 'POST /api/v1/applications/test',
    request: { method: 'POST', path: '/api/v1/applications/test', body: provider('Radarr', 'Radarr', RADARR) },
    confirm: 'Radarr',
  },
  {
    key: 'POST /api/v1/applications/action/{name}',
    request: {
      method: 'POST',
      path: '/api/v1/applications/action/getProfiles',
      body: provider('Radarr', 'Radarr', RADARR),
    },
    confirm: 'Radarr',
  },
  {
    key: 'POST /api/v1/notification/test',
    request: {
      method: 'POST',
      path: '/api/v1/notification/test',
      body: provider('Discord', 'Discord', [field('webHookUrl', 'https://collector.example/x')], 9),
    },
    confirm: 'Discord',
  },
  {
    key: 'POST /api/v1/notification/testall',
    request: { method: 'POST', path: '/api/v1/notification/testall' },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/applications/testall',
    request: { method: 'POST', path: '/api/v1/applications/testall' },
    confirm: INSTANCE,
  },
  {
    key: 'PUT /api/v1/config/development/{id}',
    request: {
      method: 'PUT',
      path: '/api/v1/config/development/1',
      body: { id: 1, logIndexerResponse: true, logSql: true },
    },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/notification/action/{name}',
    request: {
      method: 'POST',
      path: '/api/v1/notification/action/getDevices',
      body: provider('New', 'Gotify', [field('server', 'https://gotify.example')]),
    },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/command#heavy',
    request: { method: 'POST', path: '/api/v1/command', body: { name: 'ApplicationIndexerSync', forceSync: true } },
    confirm: 'ApplicationIndexerSync',
  },
  ...(['downloadclient', 'indexer', 'indexerproxy', 'applications'] as const).flatMap((resource) => {
    const [id, name] = {
      downloadclient: [6, 'qBit'],
      indexer: [2, 'PrivateHD'],
      indexerproxy: [10, 'Socks'],
      applications: [4, 'Sonarr'],
    }[resource] as [number, string];
    const body = provider(name, 'Any', EVIL, id);
    return [
      {
        key: `POST /api/v1/${resource}/test#stored`,
        request: { method: 'POST', path: `/api/v1/${resource}/test`, body },
        confirm: name,
      },
      {
        key: `POST /api/v1/${resource}/action/{name}#stored`,
        request: { method: 'POST', path: `/api/v1/${resource}/action/getCategories`, body },
        confirm: name,
      },
    ];
  }),
  { key: 'DELETE /api/v1/indexer/{id}', request: { method: 'DELETE', path: '/api/v1/indexer/1' }, confirm: 'NZBgeek' },
  {
    key: 'DELETE /api/v1/indexer/bulk',
    request: { method: 'DELETE', path: '/api/v1/indexer/bulk', body: { ids: [1, 2] } },
    confirm: '2 indexers',
  },
  {
    key: 'DELETE /api/v1/applications/{id}',
    request: { method: 'DELETE', path: '/api/v1/applications/4' },
    confirm: 'Sonarr',
  },
  {
    key: 'DELETE /api/v1/applications/bulk',
    request: { method: 'DELETE', path: '/api/v1/applications/bulk', body: { ids: [4] } },
    confirm: '1 application',
  },
  {
    key: 'DELETE /api/v1/indexerproxy/{id}',
    request: { method: 'DELETE', path: '/api/v1/indexerproxy/10' },
    confirm: 'Socks',
  },
  {
    key: 'DELETE /api/v1/downloadclient/bulk',
    request: { method: 'DELETE', path: '/api/v1/downloadclient/bulk', body: { ids: [6] } },
    confirm: '1 download client',
  },
  {
    key: 'DELETE /api/v1/notification/{id}',
    request: { method: 'DELETE', path: '/api/v1/notification/14' },
    confirm: 'Hook',
  },
  {
    key: 'DELETE /api/v1/appprofile/{id}',
    request: { method: 'DELETE', path: '/api/v1/appprofile/11' },
    confirm: 'Standard',
  },
  { key: 'DELETE /api/v1/tag/{id}', request: { method: 'DELETE', path: '/api/v1/tag/12' }, confirm: 'flaresolverr' },
  {
    key: 'DELETE /api/v1/customfilter/{id}',
    request: { method: 'DELETE', path: '/api/v1/customfilter/13' },
    confirm: 'Torrents',
  },
];
