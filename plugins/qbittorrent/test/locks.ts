import { expect } from 'vitest';
import { FEED, HASH, NAMES, TRACKER } from './fake-qbittorrent.js';
import type { FakeQbittorrent } from './fake-qbittorrent.js';

/** One call per locked key (every lock, every split twin, and several selections), the literal an approver must
 * type against the fake qBittorrent, text the approval must show, and the effect on the fake once approved. */
export interface LockCase {
  /** Unique label; the resolved key unless one key has several cases. */
  name: string;
  /** The key the call resolves to (a twin where a split applies). */
  key: string;
  /** What the sandbox calls. */
  call: { key: string; params?: Record<string, unknown> };
  confirm: string;
  /** Text the approval shows. */
  shows: string;
  effect(fake: FakeQbittorrent): void;
}

/** The fake listens on 127.0.0.1, so instance-wide locks confirm against that host name. */
export const HOST = '127.0.0.1';
/** Secrets the calls themselves carry; they must stay out of approvals and the audit log. */
export const CALL_SECRETS = [
  'EXAMPLEPASSKEY0004',
  'EXAMPLE-new-proxy-password',
  'EXAMPLE-new-feed-key',
  'EXAMPLE-new-tracker-key',
];

const lock = (
  name: string,
  key: string,
  call: LockCase['call'],
  confirm: string,
  shows: string,
  effect: LockCase['effect'],
): LockCase => ({ name, key, call, confirm, shows, effect });
const same = (
  key: string,
  params: Record<string, unknown> | undefined,
  confirm: string,
  shows: string,
  effect: LockCase['effect'],
) => lock(key, key, { key, params }, confirm, shows, effect);
const lastCall = (fake: FakeQbittorrent, path: string) => fake.calls.filter((c) => c.path === path).at(-1);

const MAGNET = `magnet:?xt=urn:btih:${'dd'.repeat(20)}&dn=Fedora%2042&tr=${encodeURIComponent('https://private.example/EXAMPLEPASSKEY0004/announce')}`;

export const LOCK_CASES: LockCase[] = [
  same(
    'torrents.delete',
    { hashes: HASH.ubuntu, deleteFiles: false },
    NAMES.ubuntu,
    `on torrent "${NAMES.ubuntu}": remove, keep the downloaded files`,
    (f) => {
      expect(f.torrents.has(HASH.ubuntu)).toBe(false);
      expect(f.state.deletedFiles).toEqual([]);
    },
  ),
  lock(
    'torrents.delete#with-files',
    'torrents.delete#with-files',
    { key: 'torrents.delete', params: { hashes: HASH.debian, deleteFiles: true } },
    NAMES.debian,
    'remove, deleting the downloaded files',
    (f) => expect(f.state.deletedFiles).toEqual([NAMES.debian]),
  ),
  lock(
    'torrents.delete (two torrents)',
    'torrents.delete',
    { key: 'torrents.delete', params: { hashes: `${HASH.ubuntu}|${HASH.bunny}`, deleteFiles: false } },
    '2 torrents',
    `2 torrents: "${NAMES.ubuntu}", "${NAMES.bunny}"`,
    (f) => expect([...f.torrents.keys()]).toEqual([HASH.debian]),
  ),
  lock(
    'torrents.delete (all)',
    'torrents.delete',
    { key: 'torrents.delete', params: { hashes: 'all', deleteFiles: false } },
    'all 3 torrents',
    'on all 3 torrents',
    (f) => expect(f.torrents.size).toBe(0),
  ),
  same(
    'torrents.add',
    { urls: MAGNET, category: 'linux', tags: 'iso' },
    HOST,
    'into "/downloads" (the default save path) on qBittorrent at 127.0.0.1: 1 source(s): magnet "Fedora 42"; magnet trackers, sources, peers and DHT nodes: https://private.example',
    (f) => {
      expect(f.torrents.get('dd'.repeat(20))).toMatchObject({ name: 'Fedora 42', category: 'linux' });
      expect(lastCall(f, 'torrents/add')?.fields.urls).toBe(MAGNET);
    },
  ),
  lock(
    'torrents.add (automatic management)',
    'torrents.add',
    {
      key: 'torrents.add',
      params: {
        urls: `magnet:?xt=urn:btih:${'ee'.repeat(20)}&dn=Show`,
        category: 'tv/shows',
        savepath: '/elsewhere',
        autoTMM: true,
      },
    },
    HOST,
    'into "/downloads/tv/shows" (automatic management, category "tv/shows"; savepath "/elsewhere" is ignored)',
    (f) => expect(lastCall(f, 'torrents/add')?.fields).toMatchObject({ autoTMM: 'true', category: 'tv/shows' }),
  ),
  same(
    'torrents.setLocation',
    { hashes: HASH.ubuntu, location: '/archive' },
    NAMES.ubuntu,
    'to "/archive" for torrent',
    (f) => expect(f.torrents.get(HASH.ubuntu)).toMatchObject({ save_path: '/archive', auto_tmm: false }),
  ),
  same(
    'torrents.setSavePath',
    { id: HASH.bunny, path: '/media/films' },
    NAMES.bunny,
    'to "/media/films" for torrent',
    (f) => expect(f.torrents.get(HASH.bunny)?.save_path).toBe('/media/films'),
  ),
  same(
    'torrents.editCategory',
    { category: 'linux', savePath: '/srv/linux' },
    'linux',
    'on category "linux": save path "/srv/linux"',
    (f) => expect(f.categories.get('linux')?.savePath).toBe('/srv/linux'),
  ),
  lock(
    'torrents.createCategory#paths',
    'torrents.createCategory#paths',
    { key: 'torrents.createCategory', params: { category: 'archive', savePath: '/srv/archive' } },
    HOST,
    'on category "archive": create with save path "/srv/archive"',
    (f) => expect(f.categories.get('archive')?.savePath).toBe('/srv/archive'),
  ),
  same('torrents.removeCategories', { categories: 'movies' }, 'movies', 'on category "movies": delete', (f) =>
    expect(f.categories.has('movies')).toBe(false),
  ),
  same('torrents.deleteTags', { tags: 'iso' }, 'iso', 'on tag "iso"', (f) => expect(f.tags.has('iso')).toBe(false)),
  same(
    'torrents.addTrackers',
    { hash: HASH.ubuntu, urls: 'https://new.example/announce?passkey=EXAMPLEPASSKEY0004' },
    NAMES.ubuntu,
    'add trackers https://new.example',
    (f) =>
      expect(f.torrents.get(HASH.ubuntu)?.trackers).toContain(
        'https://new.example/announce?passkey=EXAMPLEPASSKEY0004',
      ),
  ),
  same(
    'torrents.editTracker',
    { hash: HASH.ubuntu, url: TRACKER.udp, newUrl: 'https://other.example/announce?key=EXAMPLE-new-tracker-key' },
    NAMES.ubuntu,
    'tracker udp://open.example:1337 to https://other.example',
    (f) =>
      expect(f.torrents.get(HASH.ubuntu)?.trackers).toEqual([
        TRACKER.public,
        'https://other.example/announce?key=EXAMPLE-new-tracker-key',
      ]),
  ),
  same(
    'torrents.removeTrackers',
    { hash: HASH.debian, urls: TRACKER.private },
    NAMES.debian,
    'remove trackers https://private.example',
    (f) => expect(f.torrents.get(HASH.debian)?.trackers).toEqual([]),
  ),
  lock(
    'torrents.setShareLimits#remove',
    'torrents.setShareLimits#remove',
    {
      key: 'torrents.setShareLimits',
      params: {
        hashes: HASH.ubuntu,
        ratioLimit: 2,
        seedingTimeLimit: -2,
        inactiveSeedingTimeLimit: -2,
        shareLimitAction: 'RemoveWithContent',
      },
    },
    NAMES.ubuntu,
    'then RemoveWithContent',
    (f) => expect(lastCall(f, 'torrents/setShareLimits')?.fields.shareLimitAction).toBe('RemoveWithContent'),
  ),
  lock(
    'torrents.stop#all',
    'torrents.stop#all',
    { key: 'torrents.stop', params: { hashes: 'all' } },
    'all 3 torrents',
    'on all 3 torrents',
    (f) => expect([...f.torrents.values()].every((t) => t.state === 'stoppedUP')).toBe(true),
  ),
  lock(
    'torrents.setCategory#all',
    'torrents.setCategory#all',
    { key: 'torrents.setCategory', params: { hashes: 'all', category: 'movies' } },
    'all 3 torrents',
    'move to "/downloads/movies"',
    (f) => expect([...f.torrents.values()].every((t) => t.category === 'movies')).toBe(true),
  ),
  lock(
    'torrents.setDownloadLimit#all',
    'torrents.setDownloadLimit#all',
    { key: 'torrents.setDownloadLimit', params: { hashes: 'all', limit: 1000 } },
    'all 3 torrents',
    'download limit 1000 B/s',
    (f) => expect([...f.torrents.values()].every((t) => t.dl_limit === 1000)).toBe(true),
  ),
  same(
    'app.setPreferences',
    {
      json: {
        web_ui_port: 8081,
        autorun_program: '/scripts/run.sh "%N"',
        proxy_password: 'EXAMPLE-new-proxy-password',
      },
    },
    HOST,
    'web_ui_port=8081 (changes WebUI access), autorun_program="/scripts/run.sh \\"%N\\"" (runs a program), proxy_password=[REDACTED]',
    (f) => expect(f.preferences).toMatchObject({ web_ui_port: 8081, proxy_password: 'EXAMPLE-new-proxy-password' }),
  ),
  same('app.shutdown', undefined, HOST, 'shut qBittorrent down', (f) => expect(f.state.shutdown).toBe(true)),
  same(
    'rss.addFeed',
    { url: 'https://new-feed.example/rss?key=EXAMPLE-new-feed-key', path: 'New feed' },
    HOST,
    'subscribe "New feed" to https://new-feed.example',
    (f) =>
      expect(f.rssItems['New feed']).toMatchObject({ url: 'https://new-feed.example/rss?key=EXAMPLE-new-feed-key' }),
  ),
  same(
    'rss.setFeedURL',
    { path: 'Public', url: 'https://mirror.example/feed.xml' },
    'Public',
    'on feed "Public": URL to https://mirror.example',
    (f) => expect(f.rssItems.Public).toMatchObject({ url: 'https://mirror.example/feed.xml' }),
  ),
  same('rss.removeItem', { path: 'Linux ISOs' }, 'Linux ISOs', 'remove the folder and its 1 feed(s)', (f) =>
    expect(f.rssItems['Linux ISOs']).toBeUndefined(),
  ),
  same(
    'rss.setRule',
    {
      ruleName: 'Ubuntu',
      ruleDef: {
        enabled: true,
        mustContain: 'noble',
        affectedFeeds: [FEED.public],
        torrentParams: { save_path: '/downloads/linux', category: 'linux' },
      },
    },
    'Ubuntu',
    'on rule "Ubuntu" (replaced): saves to "/downloads/linux", category "linux", from feeds https://public.example',
    (f) => expect(f.rssRules.Ubuntu).toMatchObject({ mustContain: 'noble', affectedFeeds: [FEED.public] }),
  ),
  lock(
    'rss.setRule (new rule)',
    'rss.setRule',
    {
      key: 'rss.setRule',
      params: { ruleName: 'Debian', ruleDef: { enabled: true, mustContain: 'debian', affectedFeeds: [FEED.keyed] } },
    },
    HOST,
    'on new rule "Debian" on qBittorrent at 127.0.0.1: saves to "/downloads" (the default save path), from feeds https://feeds.example',
    (f) => expect(f.rssRules.Debian).toMatchObject({ affectedFeeds: [FEED.keyed] }),
  ),
  same('rss.removeRule', { ruleName: 'Ubuntu' }, 'Ubuntu', 'on rule "Ubuntu": delete', (f) =>
    expect(f.rssRules.Ubuntu).toBeUndefined(),
  ),
  same(
    'search.start',
    { pattern: 'ubuntu', plugins: 'enabled', category: 'all' },
    HOST,
    'search "ubuntu" in category "all" with plugins "example" (runs',
    (f) =>
      expect(lastCall(f, 'search/start')?.fields).toEqual({ pattern: 'ubuntu', plugins: 'enabled', category: 'all' }),
  ),
  lock(
    'search.start (all plugins)',
    'search.start',
    { key: 'search.start', params: { pattern: 'debian', plugins: 'all', category: 'all' } },
    HOST,
    'with plugins "example"; including disabled: "legacy"',
    (f) => expect(lastCall(f, 'search/start')?.fields.plugins).toBe('all'),
  ),
  same(
    'search.installPlugin',
    { sources: 'https://plugins.example/nova/example.py' },
    HOST,
    'install search plugins from https://plugins.example',
    (f) => expect(f.state.installed).toEqual(['https://plugins.example/nova/example.py']),
  ),
  same('search.uninstallPlugin', { names: 'example' }, 'example', 'on plugin "example": uninstall', (f) =>
    expect(f.plugins.map((p) => p.name)).toEqual(['legacy']),
  ),
  same('search.enablePlugin', { names: 'example', enable: false }, 'example', 'on plugin "example": disable', (f) =>
    expect(f.plugins[0]?.enabled).toBe(false),
  ),
  same('search.updatePlugins', undefined, HOST, 'update every search plugin', (f) => expect(f.state.updated).toBe(1)),
];
