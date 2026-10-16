import { INSTANCE } from './fake-lidarr.js';

/** One call per locked key (every key plugin.yaml locks by name, every split twin, and a sample of the deletes the
 * `DELETE *` rule locks), and the literal an approver must type for it against the fake Lidarr. */
export interface LockCase {
  key: string;
  request: { method: string; path: string; body?: unknown; query?: Record<string, unknown> };
  confirm: string;
}

const BACKUP = 'lidarr_backup_v3.1.6.5078_2026.10.14_10.00.00.zip';
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
  {
    key: 'DELETE /api/v1/artist/{id}',
    request: { method: 'DELETE', path: '/api/v1/artist/1' },
    confirm: 'Radiohead',
  },
  {
    key: 'DELETE /api/v1/artist/{id}#delete-files',
    request: { method: 'DELETE', path: '/api/v1/artist/1', query: { deleteFiles: true } },
    confirm: 'Radiohead',
  },
  {
    key: 'PUT /api/v1/artist/{id}#move-files',
    request: {
      method: 'PUT',
      path: '/api/v1/artist/2',
      query: { moveFiles: true },
      body: { id: 2, artistName: 'Not Björk', path: '/elsewhere/Björk' },
    },
    confirm: 'Björk',
  },
  {
    key: 'PUT /api/v1/artist/editor',
    request: { method: 'PUT', path: '/api/v1/artist/editor', body: { artistIds: [1, 2], monitored: false } },
    confirm: '2 artists',
  },
  {
    key: 'DELETE /api/v1/artist/editor',
    request: { method: 'DELETE', path: '/api/v1/artist/editor', body: { artistIds: [2], deleteFiles: false } },
    confirm: '1 artist',
  },
  {
    key: 'DELETE /api/v1/artist/editor#delete-files',
    request: { method: 'DELETE', path: '/api/v1/artist/editor', body: { artistIds: [1, 2], deleteFiles: true } },
    confirm: '2 artists',
  },
  {
    key: 'DELETE /api/v1/album/{id}',
    request: { method: 'DELETE', path: '/api/v1/album/16', query: { addImportListExclusion: true } },
    confirm: 'OK Computer',
  },
  {
    key: 'DELETE /api/v1/album/{id}#delete-files',
    request: { method: 'DELETE', path: '/api/v1/album/16', query: { deleteFiles: 'true' } },
    confirm: 'OK Computer',
  },
  {
    key: 'DELETE /api/v1/trackfile/{id}',
    request: { method: 'DELETE', path: '/api/v1/trackfile/13' },
    confirm: '/music/Radiohead/OK Computer (1997)/01 - Airbag.flac',
  },
  {
    key: 'DELETE /api/v1/trackfile/bulk',
    request: { method: 'DELETE', path: '/api/v1/trackfile/bulk', body: { trackFileIds: [13, 17] } },
    confirm: '2 track files',
  },
  {
    key: 'PUT /api/v1/config/metadataprovider/{id}',
    request: {
      method: 'PUT',
      path: '/api/v1/config/metadataprovider/1',
      body: { id: 1, metadataSource: 'https://metadata.example/api', writeAudioTags: 'allFiles' },
    },
    confirm: INSTANCE,
  },
  {
    key: 'PUT /api/v1/config/mediamanagement/{id}',
    request: {
      method: 'PUT',
      path: '/api/v1/config/mediamanagement/1',
      body: { id: 1, useScriptImport: true, scriptImportPath: '/config/import.sh', chmodFolder: '777' },
    },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/rootfolder',
    request: { method: 'POST', path: '/api/v1/rootfolder', body: { name: 'Everything', path: '/' } },
    confirm: '/',
  },
  {
    key: 'PUT /api/v1/rootfolder/{id}',
    request: { method: 'PUT', path: '/api/v1/rootfolder/5', body: { id: 5, name: 'Music', path: '/etc' } },
    confirm: '/etc',
  },
  {
    key: 'PUT /api/v1/config/host/{id}',
    request: { method: 'PUT', path: '/api/v1/config/host/1', body: { id: 1, bindAddress: '*', urlBase: '/lidarr' } },
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
      path: '/api/v1/indexer/7',
      body: provider('NZBgeek', 'Newznab', [field('baseUrl', 'https://collector.example')], 7),
    },
    confirm: 'NZBgeek',
  },
  {
    key: 'POST /api/v1/importlist',
    request: {
      method: 'POST',
      path: '/api/v1/importlist',
      body: provider('My list', 'LidarrImport', [field('baseUrl', 'http://other-lidarr:8686')]),
    },
    confirm: 'My list',
  },
  {
    key: 'PUT /api/v1/importlist/{id}',
    request: { method: 'PUT', path: '/api/v1/importlist/8', body: provider('Lidarr Lossless', 'LidarrImport', [], 8) },
    confirm: 'Lidarr Lossless',
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
    key: 'POST /api/v1/notification/action/{name}',
    request: {
      method: 'POST',
      path: '/api/v1/notification/action/getDevices',
      body: provider('New', 'Gotify', [field('server', 'https://gotify.example')]),
    },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/release/push',
    request: {
      method: 'POST',
      path: '/api/v1/release/push',
      body: {
        title: 'Some.Artist-Some.Album-2020-FLAC',
        downloadUrl: 'https://tracker.example/dl/1?passkey=pk-123456',
        protocol: 'torrent',
      },
    },
    confirm: INSTANCE,
  },
  {
    key: 'POST /api/v1/command#heavy',
    request: { method: 'POST', path: '/api/v1/command', body: { name: 'RetagFiles', artistId: 1, files: [13] } },
    confirm: 'RetagFiles',
  },
  ...(['downloadclient', 'indexer', 'importlist'] as const).flatMap((resource) => {
    const [id, name] = { downloadclient: [6, 'qBit'], indexer: [7, 'NZBgeek'], importlist: [8, 'Lidarr Lossless'] }[
      resource
    ] as [number, string];
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
  { key: 'DELETE /api/v1/tag/{id}', request: { method: 'DELETE', path: '/api/v1/tag/3' }, confirm: 'kids' },
  {
    key: 'DELETE /api/v1/downloadclient/{id}',
    request: { method: 'DELETE', path: '/api/v1/downloadclient/6' },
    confirm: 'qBit',
  },
  {
    key: 'DELETE /api/v1/queue/{id}',
    request: { method: 'DELETE', path: '/api/v1/queue/41', query: { removeFromClient: true } },
    confirm: 'Radiohead-OK.Computer-OKNOTOK-24BIT-WEB-FLAC-2017',
  },
  {
    key: 'DELETE /api/v1/queue/bulk',
    request: { method: 'DELETE', path: '/api/v1/queue/bulk', body: { ids: [41] } },
    confirm: '1 item',
  },
  { key: 'DELETE /api/v1/blocklist/{id}', request: { method: 'DELETE', path: '/api/v1/blocklist/61' }, confirm: '61' },
  {
    key: 'DELETE /api/v1/metadataprofile/{id}',
    request: { method: 'DELETE', path: '/api/v1/metadataprofile/18' },
    confirm: 'Standard',
  },
  {
    key: 'DELETE /api/v1/importlistexclusion/{id}',
    request: { method: 'DELETE', path: '/api/v1/importlistexclusion/12' },
    confirm: 'Nickelback',
  },
];
