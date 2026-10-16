import { INSTANCE } from './fake-plex.js';

/** One call per locked key (every key plugin.yaml locks by name, every split twin, and a sample of the deletes the
 * `DELETE *` rule locks), and the literal an approver must type for it against the fake Plex. */
export interface LockCase {
  /** Unique label; the resolved key unless one key has several cases. */
  name: string;
  key: string;
  request: { method: string; path: string; query?: Record<string, unknown> };
  confirm: string;
}

const lock = (key: string, request: LockCase['request'], confirm: string, name = key): LockCase => ({
  name,
  key,
  request,
  confirm,
});

export const LOCK_CASES: LockCase[] = [
  lock('DELETE /library/sections/{sectionId}', { method: 'DELETE', path: '/library/sections/1' }, 'Movies'),
  ...(['GET', 'POST', 'PUT'] as const).map((method) =>
    lock(
      `${method} /library/sections/{sectionId}/emptyTrash`,
      { method, path: '/library/sections/1/emptyTrash' },
      'Movies',
    ),
  ),
  lock('PUT /library/sections/{sectionId}/analyze', { method: 'PUT', path: '/library/sections/2/analyze' }, 'TV Shows'),
  lock('GET /library/sections/{sectionId}/unmatch', { method: 'GET', path: '/library/sections/1/unmatch' }, 'Movies'),
  ...(['GET', 'POST'] as const).map((method) =>
    lock(
      `${method} /library/sections/{sectionId}/optimize`,
      { method, path: '/library/sections/1/optimize' },
      'Movies',
    ),
  ),
  ...(['GET', 'POST', 'PUT'] as const).map((method) =>
    lock(`${method} /library/optimize`, { method, path: '/library/optimize' }, INSTANCE),
  ),
  lock('PUT /library/clean/bundles', { method: 'PUT', path: '/library/clean/bundles' }, INSTANCE),
  lock(
    'POST /library/sections/all',
    {
      method: 'POST',
      path: '/library/sections/all',
      query: { name: 'Kids', type: 'movie', agent: 'tv.plex.agents.movie', language: 'en-US', location: '/media/kids' },
    },
    'Kids',
  ),
  lock(
    'PUT /library/sections/{sectionId}',
    { method: 'PUT', path: '/library/sections/1', query: { agent: 'tv.plex.agents.movie', location: '/elsewhere' } },
    'Movies',
  ),
  lock(
    'PUT /library/sections/{sectionId}/all',
    { method: 'PUT', path: '/library/sections/1/all', query: { type: 1, 'contentRating.value': 'G' } },
    'Movies',
  ),
  lock('DELETE /library/metadata/{ids}', { method: 'DELETE', path: '/library/metadata/101' }, 'Inception'),
  lock(
    'DELETE /library/metadata/{ids}',
    { method: 'DELETE', path: '/library/metadata/101,102' },
    '2 items',
    'DELETE /library/metadata/{ids} (two items)',
  ),
  lock(
    'DELETE /library/metadata/{ids}/media/{mediaItem}',
    { method: 'DELETE', path: '/library/metadata/101/media/5' },
    'Inception',
  ),
  lock(
    'POST /library/metadata/{ids}/extras',
    {
      method: 'POST',
      path: '/library/metadata/101/extras',
      query: { url: 'https://trailers.example/t.mp4?sig=trailer-signature-888888', extraType: 1 },
    },
    'Inception',
  ),
  lock(
    'POST /library/metadata/{ids}/{element}',
    { method: 'POST', path: '/library/metadata/101/poster', query: { url: 'https://images.example/p.jpg' } },
    'Inception',
  ),
  lock(
    'PUT /library/metadata/{ids}/{element}',
    { method: 'PUT', path: '/library/metadata/301/thumb', query: { url: 'upload://posters/abc' } },
    'Good News About Hell',
  ),
  lock(
    'PUT /:/prefs',
    { method: 'PUT', path: '/:/prefs', query: { FriendlyName: 'Renamed', allowedNetworks: '0.0.0.0/0' } },
    INSTANCE,
  ),
  lock('PUT /updater/apply', { method: 'PUT', path: '/updater/apply' }, INSTANCE),
  lock('POST /butler', { method: 'POST', path: '/butler' }, INSTANCE),
  lock('POST /butler/{butlerTask}', { method: 'POST', path: '/butler/BackupDatabase' }, 'BackupDatabase'),
  lock(
    'POST /status/sessions/terminate',
    { method: 'POST', path: '/status/sessions/terminate', query: { sessionId: 'sess-1', reason: 'Maintenance' } },
    'Arrival',
  ),
  lock('DELETE /playlists', { method: 'DELETE', path: '/playlists', query: { ratingKey: 401 } }, 'Road Trip'),
  lock('DELETE /playlists/{playlistId}', { method: 'DELETE', path: '/playlists/401' }, 'Road Trip'),
  lock('DELETE /playlists/{playlistId}/items', { method: 'DELETE', path: '/playlists/401/items' }, 'Road Trip'),
  lock(
    'POST /media/providers',
    { method: 'POST', path: '/media/providers', query: { url: 'https://provider.example/p?key=provider-key-999999' } },
    INSTANCE,
  ),
  lock(
    'POST /media/grabbers/devices',
    { method: 'POST', path: '/media/grabbers/devices', query: { uri: 'http://10.0.0.5/tuner?key=tuner-key-141414' } },
    INSTANCE,
  ),
  lock(
    'GET /library/metadata/{ids}#refresh',
    { method: 'GET', path: '/library/metadata/101', query: { asyncRefreshAnalysis: 1 } },
    'Inception',
  ),
  lock(
    'GET /library/sections/{sectionId}/all#refresh',
    { method: 'GET', path: '/library/sections/1/all', query: { asyncAugmentMetadata: true } },
    'Movies',
  ),
  lock('DELETE /butler', { method: 'DELETE', path: '/butler' }, INSTANCE),
  lock('DELETE /library/caches', { method: 'DELETE', path: '/library/caches' }, INSTANCE),
  lock(
    'DELETE /library/sections/{sectionId}/collection/{collectionId}',
    { method: 'DELETE', path: '/library/sections/1/collection/201' },
    'Nolan Films',
  ),
  lock('DELETE /activities/{activityId}', { method: 'DELETE', path: '/activities/act-123' }, 'act-123'),
  lock(
    'GET /library/metadata/{ids}/subtitles',
    {
      method: 'GET',
      path: '/library/metadata/101/subtitles',
      query: { url: 'https://subs.example/inception.srt?key=subtitle-key-131313', language: 'en' },
    },
    'Inception',
  ),
  lock(
    'GET /library/metadata/{ids}#refresh',
    { method: 'GET', path: '/library/metadata/101', query: { checkFiles: 1 } },
    'Inception',
    'GET /library/metadata/{ids}#refresh (checkFiles)',
  ),
  lock(
    'GET /library/sections/{sectionId}/all#refresh',
    { method: 'GET', path: '/library/sections/1/all', query: { refreshAnalysis: 'true' } },
    'Movies',
    'GET /library/sections/{sectionId}/all#refresh (refreshAnalysis)',
  ),
  lock('GET /playQueues/{playQueueId}#own', { method: 'GET', path: '/playQueues/55', query: { own: 1 } }, '55'),
  ...(['move', 'edit', 'prefs'] as const).map((action) =>
    lock(
      `PUT /library/sections/{sectionId}/${action}`,
      { method: 'PUT', path: `/library/sections/2/${action}`, query: action === 'move' ? { location: '/new' } : {} },
      'TV Shows',
    ),
  ),
  lock('PUT /livetv/dvrs/{dvrId}', { method: 'PUT', path: '/livetv/dvrs/7' }, '7'),
  lock('PATCH /livetv/dvrs/{dvrId}', { method: 'PATCH', path: '/livetv/dvrs/7' }, '7'),
  lock(
    'PUT /livetv/dvrs/{dvrId}/lineups',
    { method: 'PUT', path: '/livetv/dvrs/7/lineups', query: { lineup: 'x' } },
    '7',
  ),
  lock(
    'PUT /livetv/dvrs/{dvrId}/prefs',
    { method: 'PUT', path: '/livetv/dvrs/7/prefs', query: { name: 'a', value: 'b' } },
    '7',
  ),
  lock('PUT /livetv/dvrs/{dvrId}/devices/{deviceId}', { method: 'PUT', path: '/livetv/dvrs/7/devices/dev-1' }, '7'),
  lock(
    'PUT /media/grabbers/devices/{deviceId}',
    { method: 'PUT', path: '/media/grabbers/devices/dev-1', query: { enabled: 0 } },
    'dev-1',
  ),
  ...(['prefs', 'channelmap'] as const).map((action) =>
    lock(
      `PUT /media/grabbers/devices/{deviceId}/${action}`,
      { method: 'PUT', path: `/media/grabbers/devices/dev-1/${action}` },
      'dev-1',
    ),
  ),
];
