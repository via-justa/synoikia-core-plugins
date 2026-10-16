import { INSTANCE } from './fake-sonarr.js';

/** One call per locked key (every key plugin.yaml locks by name, every split twin, and a sample of the deletes the
 * `DELETE *` rule locks), and the literal an approver must type for it against the fake Sonarr. */
export interface LockCase {
  key: string;
  request: { method: string; path: string; body?: unknown; query?: Record<string, unknown> };
  confirm: string;
}

const BACKUP = 'sonarr_backup_v4.0.20.3014_2026.10.14_10.00.00.zip';
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

export const LOCK_CASES: LockCase[] = [
  { key: 'DELETE /api/v3/series/{id}', request: { method: 'DELETE', path: '/api/v3/series/1' }, confirm: 'Severance' },
  {
    key: 'DELETE /api/v3/series/{id}#delete-files',
    request: { method: 'DELETE', path: '/api/v3/series/1', query: { deleteFiles: true } },
    confirm: 'Severance',
  },
  {
    key: 'PUT /api/v3/series/{id}#move-files',
    request: {
      method: 'PUT',
      path: '/api/v3/series/2',
      query: { moveFiles: true },
      body: { id: 2, title: 'Not The Expanse', path: '/elsewhere/The Expanse' },
    },
    confirm: 'The Expanse',
  },
  {
    key: 'PUT /api/v3/series/editor',
    request: { method: 'PUT', path: '/api/v3/series/editor', body: { seriesIds: [1, 2], monitored: false } },
    confirm: '2 series',
  },
  {
    key: 'DELETE /api/v3/series/editor',
    request: { method: 'DELETE', path: '/api/v3/series/editor', body: { seriesIds: [2], deleteFiles: false } },
    confirm: '1 series',
  },
  {
    key: 'DELETE /api/v3/series/editor#delete-files',
    request: { method: 'DELETE', path: '/api/v3/series/editor', body: { seriesIds: [1, 2], deleteFiles: true } },
    confirm: '2 series',
  },
  {
    key: 'POST /api/v3/seasonpass',
    request: {
      method: 'POST',
      path: '/api/v3/seasonpass',
      body: { series: [{ id: 1, monitored: false }, { id: 2 }], monitoringOptions: { monitor: 'none' } },
    },
    confirm: '2 series',
  },
  {
    key: 'DELETE /api/v3/episodefile/{id}',
    request: { method: 'DELETE', path: '/api/v3/episodefile/13' },
    confirm: 'Season 01/Severance - S01E01.mkv',
  },
  {
    key: 'DELETE /api/v3/episodefile/bulk',
    request: { method: 'DELETE', path: '/api/v3/episodefile/bulk', body: { episodeFileIds: [13, 16] } },
    confirm: '2 items',
  },
  {
    key: 'PUT /api/v3/config/host/{id}',
    request: { method: 'PUT', path: '/api/v3/config/host/1', body: { id: 1, bindAddress: '*', urlBase: '/sonarr' } },
    confirm: INSTANCE,
  },
  {
    key: 'PUT /api/v3/config/mediamanagement/{id}',
    request: {
      method: 'PUT',
      path: '/api/v3/config/mediamanagement/1',
      body: { id: 1, useScriptImport: true, scriptImportPath: '/tmp/evil.sh' },
    },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v3/rootfolder',
    request: { method: 'POST', path: '/api/v3/rootfolder', body: { path: '/' } },
    confirm: '/',
  },
  {
    key: 'POST /api/v3/system/shutdown',
    request: { method: 'POST', path: '/api/v3/system/shutdown' },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v3/system/restart',
    request: { method: 'POST', path: '/api/v3/system/restart' },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v3/system/backup/restore/{id}',
    request: { method: 'POST', path: '/api/v3/system/backup/restore/21' },
    confirm: BACKUP,
  },
  {
    key: 'DELETE /api/v3/system/backup/{id}',
    request: { method: 'DELETE', path: '/api/v3/system/backup/21' },
    confirm: BACKUP,
  },
  {
    key: 'POST /api/v3/downloadclient',
    request: {
      method: 'POST',
      path: '/api/v3/downloadclient',
      body: provider('SAB', 'Sabnzbd', [
        field('host', 'sab.lan'),
        field('port', 8085),
        field('apiKey', 'sab-key-777777', 'apiKey'),
      ]),
    },
    confirm: 'SAB',
  },
  {
    key: 'PUT /api/v3/downloadclient/{id}',
    request: { method: 'PUT', path: '/api/v3/downloadclient/6', body: provider('Renamed', 'QBittorrent', EVIL, 6) },
    confirm: 'qBit',
  },
  {
    key: 'POST /api/v3/indexer',
    request: {
      method: 'POST',
      path: '/api/v3/indexer',
      body: provider('Geek2', 'Newznab', [
        field('baseUrl', 'https://api.example.org'),
        field('apiKey', 'idx-key-888888', 'apiKey'),
      ]),
    },
    confirm: 'Geek2',
  },
  {
    key: 'PUT /api/v3/indexer/{id}',
    request: {
      method: 'PUT',
      path: '/api/v3/indexer/7',
      body: provider('NZBgeek', 'Newznab', [field('baseUrl', 'https://collector.example')], 7),
    },
    confirm: 'NZBgeek',
  },
  {
    key: 'POST /api/v3/importlist',
    request: {
      method: 'POST',
      path: '/api/v3/importlist',
      body: provider('My list', 'SonarrImport', [field('baseUrl', 'http://other-sonarr:8989')]),
    },
    confirm: 'My list',
  },
  {
    key: 'PUT /api/v3/importlist/{id}',
    request: { method: 'PUT', path: '/api/v3/importlist/8', body: provider('Sonarr 4K', 'SonarrImport', [], 8) },
    confirm: 'Sonarr 4K',
  },
  {
    key: 'POST /api/v3/notification',
    request: {
      method: 'POST',
      path: '/api/v3/notification',
      body: provider('Hook', 'Webhook', [field('url', 'https://hooks.example.com/t/secret-hook-999999')]),
    },
    confirm: 'Hook',
  },
  {
    key: 'PUT /api/v3/notification/{id}',
    request: { method: 'PUT', path: '/api/v3/notification/9', body: provider('Discord', 'Discord', [], 9) },
    confirm: 'Discord',
  },
  {
    key: 'POST /api/v3/notification/test',
    request: {
      method: 'POST',
      path: '/api/v3/notification/test',
      body: provider('Discord', 'Discord', [field('webHookUrl', 'https://collector.example/x')], 9),
    },
    confirm: 'Discord',
  },
  {
    key: 'POST /api/v3/notification/testall',
    request: { method: 'POST', path: '/api/v3/notification/testall' },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v3/notification/action/{name}',
    request: {
      method: 'POST',
      path: '/api/v3/notification/action/getDevices',
      body: provider('New', 'Gotify', [field('server', 'https://gotify.example')]),
    },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v3/release/push',
    request: {
      method: 'POST',
      path: '/api/v3/release/push',
      body: {
        title: 'Some.Show.S01E01.1080p',
        downloadUrl: 'https://tracker.example/dl/1?passkey=pk-123456',
        protocol: 'torrent',
      },
    },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v3/command#heavy',
    request: { method: 'POST', path: '/api/v3/command', body: { name: 'RenameFiles', seriesId: 1, files: [13] } },
    confirm: 'RenameFiles',
  },
  ...(['downloadclient', 'indexer', 'importlist'] as const).flatMap((resource) => {
    const [id, name] = { downloadclient: [6, 'qBit'], indexer: [7, 'NZBgeek'], importlist: [8, 'Sonarr 4K'] }[
      resource
    ] as [number, string];
    const body = provider(name, 'Any', EVIL, id);
    return [
      {
        key: `POST /api/v3/${resource}/test#stored`,
        request: { method: 'POST', path: `/api/v3/${resource}/test`, body },
        confirm: name,
      },
      {
        key: `POST /api/v3/${resource}/action/{name}#stored`,
        request: { method: 'POST', path: `/api/v3/${resource}/action/getCategories`, body },
        confirm: name,
      },
    ];
  }),
  { key: 'DELETE /api/v3/tag/{id}', request: { method: 'DELETE', path: '/api/v3/tag/3' }, confirm: 'kids' },
  {
    key: 'DELETE /api/v3/importlistexclusion/{id}',
    request: { method: 'DELETE', path: '/api/v3/importlistexclusion/12' },
    confirm: 'Cats',
  },
  {
    key: 'DELETE /api/v3/downloadclient/{id}',
    request: { method: 'DELETE', path: '/api/v3/downloadclient/6' },
    confirm: 'qBit',
  },
  {
    key: 'DELETE /api/v3/queue/{id}',
    request: { method: 'DELETE', path: '/api/v3/queue/41', query: { removeFromClient: true } },
    confirm: 'Severance.S01E02.1080p.WEB',
  },
  {
    key: 'DELETE /api/v3/queue/bulk',
    request: { method: 'DELETE', path: '/api/v3/queue/bulk', body: { ids: [41] } },
    confirm: '1 item',
  },
  { key: 'DELETE /api/v3/blocklist/{id}', request: { method: 'DELETE', path: '/api/v3/blocklist/61' }, confirm: '61' },
];
