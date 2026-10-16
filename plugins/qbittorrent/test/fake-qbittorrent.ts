import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp, FakeRequest, FakeResponse } from '@synoikia/core/testing';

/** A fake qBittorrent 5.x WebUI API: a form sign-in that sets the session cookie, POST-only actions that need a
 * urlencoded (or, for torrents/add, multipart) body, realistic response shapes, and secrets that must never reach
 * the sandbox, an approval or the audit log. */

export const CREDENTIALS = { username: 'admin', password: 'EXAMPLE-webui-password' };

export const HASH = { ubuntu: 'aa'.repeat(20), debian: 'bb'.repeat(20), bunny: 'cc'.repeat(20) } as const;
export const NAMES = { ubuntu: 'Ubuntu 24.04 Desktop', debian: 'Debian 12 Netinst', bunny: 'Big Buck Bunny' } as const;

/** Values that must stay out of results, approvals and the audit log. */
export const SECRETS = {
  passkey: 'EXAMPLEPASSKEY0001',
  privatePasskey: 'EXAMPLEPASSKEY0002',
  extraPasskey: 'EXAMPLEPASSKEY0003',
  apiKey: 'EXAMPLE-api-key',
  proxyPassword: 'EXAMPLE-proxy-password',
  mailPassword: 'EXAMPLE-mail-password',
  dyndnsPassword: 'EXAMPLE-dyndns-password',
  autorunKey: 'EXAMPLE-autorun-key',
  listKey: 'EXAMPLE-list-key',
  feedKey: 'EXAMPLE-feed-key',
  searchKey: 'EXAMPLE-search-key',
  webSeedKey: 'EXAMPLE-webseed-key',
  sslKey: 'EXAMPLE-ssl-private-key',
} as const;

export const TRACKER = {
  public: `https://tracker.example/announce?passkey=${SECRETS.passkey}`,
  udp: 'udp://open.example:1337/announce',
  private: `https://private.example/${SECRETS.privatePasskey}/announce`,
} as const;
export const FEED = {
  keyed: `https://feeds.example/rss?apikey=${SECRETS.feedKey}`,
  public: 'https://public.example/feed.xml',
} as const;
export const SEARCH_FILE_URL = `https://search.example/dl/42?apikey=${SECRETS.searchKey}`;

export interface FakeTorrent {
  hash: string;
  name: string;
  save_path: string;
  category: string;
  tags: string[];
  state: string;
  trackers: string[];
  dl_limit: number;
  auto_tmm: boolean;
}

export interface Call {
  method: string;
  path: string;
  contentType: string;
  fields: Record<string, string>;
}

export interface FakeOptions {
  /** 5.2+ answers a sign-in with 204 and `QBT_SID_<port>`; 5.0/5.1 with 200 `Ok.` and `SID`. */
  release?: '5.0' | '5.2';
  /** Host header validation that refuses every request (401 `Unauthorized`), as with a missing Server domain. */
  refuseHost?: boolean;
}

export interface FakeQbittorrent extends FakeHttp {
  torrents: Map<string, FakeTorrent>;
  categories: Map<string, { name: string; savePath: string }>;
  tags: Set<string>;
  preferences: Record<string, unknown>;
  rssItems: Record<string, unknown>;
  rssRules: Record<string, Record<string, unknown>>;
  plugins: { name: string; enabled: boolean; url: string }[];
  calls: Call[];
  logins: number;
  state: { shutdown: boolean; deletedFiles: string[]; speedLimitsMode: number; installed: string[]; updated: number };
  /** Ends every session, as an expiry or restart does. */
  expireSessions(): void;
  reset(): void;
  close(): Promise<void>;
}

const magnet = (t: FakeTorrent) =>
  `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.name)}${t.trackers.map((u) => `&tr=${encodeURIComponent(u)}`).join('')}`;

function initial() {
  const torrent = (key: keyof typeof HASH, extra: Partial<FakeTorrent>): FakeTorrent => ({
    hash: HASH[key],
    name: NAMES[key],
    save_path: '/downloads/linux',
    category: 'linux',
    tags: [],
    state: 'stalledUP',
    trackers: [],
    dl_limit: -1,
    auto_tmm: true,
    ...extra,
  });
  return {
    torrents: new Map(
      [
        torrent('ubuntu', { tags: ['iso'], trackers: [TRACKER.public, TRACKER.udp] }),
        torrent('debian', { trackers: [TRACKER.private], state: 'downloading' }),
        torrent('bunny', {
          save_path: '/downloads/movies',
          category: 'movies',
          auto_tmm: false,
          trackers: [TRACKER.udp],
        }),
      ].map((t) => [t.hash, t]),
    ),
    categories: new Map([
      ['linux', { name: 'linux', savePath: '/downloads/linux' }],
      ['movies', { name: 'movies', savePath: '/downloads/movies' }],
      // Implicit paths: `<default>/tv` and `<tv's path>/shows`.
      ['tv', { name: 'tv', savePath: '' }],
      ['tv/shows', { name: 'tv/shows', savePath: '' }],
      ['tv/odd:name?', { name: 'tv/odd:name?', savePath: '' }],
      // A subcategory whose parent has its own path: nested it is under /media/films, flat under /downloads.
      ['films', { name: 'films', savePath: '/media/films' }],
      ['films/x', { name: 'films/x', savePath: '' }],
    ]),
    tags: new Set(['iso', 'keep']),
    preferences: {
      save_path: '/downloads',
      auto_tmm_enabled: false,
      use_category_paths_in_manual_mode: false,
      use_subcategories: true,
      web_ui_port: 8080,
      web_ui_username: 'admin',
      web_ui_api_key: SECRETS.apiKey,
      bypass_auth_subnet_whitelist: '10.0.0.0/8',
      proxy_username: 'proxyuser',
      proxy_password: SECRETS.proxyPassword,
      mail_notification_password: SECRETS.mailPassword,
      dyndns_password: SECRETS.dyndnsPassword,
      autorun_enabled: true,
      autorun_program: `/scripts/notify.sh --key ${SECRETS.autorunKey} "%N"`,
      autorun_on_torrent_added_program: '',
      add_trackers_enabled: true,
      add_trackers: `https://extra.example/announce?passkey=${SECRETS.extraPasskey}`,
      add_trackers_url: `https://lists.example/trackers.txt?key=${SECRETS.listKey}`,
      add_trackers_url_list: `https://extra.example/announce?passkey=${SECRETS.extraPasskey}`,
      scan_dirs: { '/watch': 1 },
    } as Record<string, unknown>,
    rssItems: {
      'Linux ISOs': { 'Distro feed': { uid: '{00000000-0000-0000-0000-000000000001}', url: FEED.keyed } },
      Public: { uid: '{00000000-0000-0000-0000-000000000002}', url: FEED.public },
    } as Record<string, unknown>,
    rssRules: {
      Ubuntu: {
        enabled: true,
        mustContain: 'ubuntu',
        mustNotContain: '',
        affectedFeeds: [FEED.keyed],
        torrentParams: { save_path: '/downloads/linux', category: 'linux', ssl_private_key: SECRETS.sslKey },
      },
    } as Record<string, Record<string, unknown>>,
    plugins: [
      { name: 'example', enabled: true, url: 'https://search.example' },
      { name: 'legacy', enabled: false, url: 'https://legacy.example' },
    ],
  };
}

/** `a=1&b=2`, or the text fields of a multipart body. */
function parseFields(req: FakeRequest): { contentType: string; fields: Record<string, string> } | undefined {
  const contentType = String(req.headers['content-type'] ?? '');
  const text = typeof req.body === 'string' ? req.body : req.body === undefined ? '' : JSON.stringify(req.body);
  if (contentType === 'application/x-www-form-urlencoded')
    return { contentType: 'form', fields: Object.fromEntries(new URLSearchParams(text)) };
  const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(contentType)?.[1];
  if (boundary) {
    const fields: Record<string, string> = {};
    for (const part of text.split(`--${boundary}`).slice(1, -1)) {
      const m = /^\r\ncontent-disposition: form-data; name="([^"]*)"\r\n\r\n([\s\S]*)\r\n$/i.exec(part);
      if (!m) return undefined;
      fields[m[1]!] = m[2]!;
    }
    return { contentType: 'multipart', fields };
  }
  if (!text) return { contentType: 'none', fields: {} };
  return undefined;
}

const ok = (): FakeResponse => ({ status: 200, body: '' });
const conflict = (message: string): FakeResponse => ({ status: 409, body: message });
const split = (v: string | undefined, sep: string) => (v ?? '').split(sep).filter(Boolean);

export async function startFakeQbittorrent(opts: FakeOptions = {}): Promise<FakeQbittorrent> {
  const release = opts.release ?? '5.2';
  const cookieName = release === '5.2' ? 'QBT_SID_8080' : 'SID';
  const sessions = new Set<string>();
  let nextSession = 1;
  const state = initial();
  const counters = {
    shutdown: false,
    deletedFiles: [] as string[],
    speedLimitsMode: 0,
    installed: [] as string[],
    updated: 0,
  };
  const calls: Call[] = [];
  const self = { logins: 0 };

  const sid = (req: FakeRequest) =>
    String(req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([n]) => n === cookieName)?.[1];

  const pick = (spec: string | undefined): FakeTorrent[] =>
    spec === 'all'
      ? [...state.torrents.values()]
      : split(spec, '|').flatMap((h) => {
          const t = state.torrents.get(h.toLowerCase());
          return t ? [t] : [];
        });

  const info = (t: FakeTorrent) => ({
    hash: t.hash,
    name: t.name,
    magnet_uri: magnet(t),
    tracker: t.trackers[0] ?? '',
    trackers_count: t.trackers.length,
    save_path: t.save_path,
    content_path: `${t.save_path}/${t.name}`,
    category: t.category,
    tags: t.tags.join(', '),
    state: t.state,
    progress: t.state === 'downloading' ? 0.42 : 1,
    size: 6_114_656_256,
    dlspeed: t.state === 'downloading' ? 1_048_576 : 0,
    upspeed: 0,
    ratio: 1.5,
    dl_limit: t.dl_limit,
    auto_tmm: t.auto_tmm,
    added_on: 1_760_000_000,
    comment: `Seeded from ${TRACKER.public}`,
  });

  type Form = Record<string, string>;
  /** POST-only actions (webapplication.h m_allowedMethod), each with its effect on the fake's state. */
  const actions: Record<string, (f: Form) => FakeResponse> = {
    'torrents/stop': (f) => (pick(f.hashes).forEach((t) => (t.state = 'stoppedUP')), ok()),
    'torrents/start': (f) => (pick(f.hashes).forEach((t) => (t.state = 'stalledUP')), ok()),
    'torrents/recheck': (f) => (pick(f.hashes).forEach((t) => (t.state = 'checkingUP')), ok()),
    'torrents/reannounce': () => ok(),
    'torrents/topPrio': () => ok(),
    'torrents/bottomPrio': () => ok(),
    'torrents/setCategory': (f) => {
      if (f.category && !state.categories.has(f.category)) return conflict('Incorrect category name');
      pick(f.hashes).forEach((t) => (t.category = f.category ?? ''));
      return ok();
    },
    'torrents/addTags': (f) => {
      for (const tag of split(f.tags, ',')) {
        state.tags.add(tag);
        pick(f.hashes).forEach((t) => !t.tags.includes(tag) && t.tags.push(tag));
      }
      return ok();
    },
    'torrents/removeTags': (f) => {
      const tags = split(f.tags, ',');
      pick(f.hashes).forEach((t) => (t.tags = t.tags.filter((x) => !tags.includes(x))));
      return ok();
    },
    'torrents/setDownloadLimit': (f) => (pick(f.hashes).forEach((t) => (t.dl_limit = Number(f.limit))), ok()),
    'torrents/setUploadLimit': () => ok(),
    'torrents/setShareLimits': (f) =>
      f.ratioLimit === undefined || f.seedingTimeLimit === undefined
        ? { status: 400, body: 'Missing required parameters' }
        : ok(),
    'torrents/filePrio': () => ok(),
    'torrents/rename': (f) => {
      const t = state.torrents.get(f.hash ?? '');
      if (!t) return { status: 404, body: '' };
      t.name = f.name ?? t.name;
      return ok();
    },
    'torrents/renameFile': () => ok(),
    'torrents/renameFolder': () => ok(),
    'torrents/createCategory': (f) => {
      if (!f.category || state.categories.has(f.category)) return conflict('Unable to create category');
      state.categories.set(f.category, { name: f.category, savePath: f.savePath ?? '' });
      return ok();
    },
    'torrents/editCategory': (f) => {
      const c = state.categories.get(f.category ?? '');
      if (!c) return { status: 404, body: 'Category does not exist' };
      c.savePath = f.savePath ?? '';
      return ok();
    },
    'torrents/removeCategories': (f) => (split(f.categories, '\n').forEach((c) => state.categories.delete(c)), ok()),
    'torrents/createTags': (f) => (split(f.tags, ',').forEach((t) => state.tags.add(t)), ok()),
    'torrents/deleteTags': (f) => {
      for (const tag of split(f.tags, ',')) {
        state.tags.delete(tag);
        state.torrents.forEach((t) => (t.tags = t.tags.filter((x) => x !== tag)));
      }
      return ok();
    },
    'torrents/delete': (f) => {
      if (f.deleteFiles === undefined) return { status: 400, body: 'Missing required parameters: deleteFiles' };
      for (const t of pick(f.hashes)) {
        state.torrents.delete(t.hash);
        if (f.deleteFiles === 'true') counters.deletedFiles.push(t.name);
      }
      return ok();
    },
    'torrents/add': (f) => {
      const added: string[] = [];
      for (const url of split(f.urls, '\n')) {
        const xt = /xt=urn:btih:([0-9a-f]{40})/i.exec(url)?.[1]?.toLowerCase();
        const hash = xt ?? createHashLike(url);
        const name = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('dn') ?? url;
        const category = f.category ?? '';
        state.torrents.set(hash, {
          hash,
          name,
          save_path: f.savepath || state.categories.get(category)?.savePath || '/downloads',
          category,
          tags: split(f.tags, ','),
          state: f.stopped === 'true' ? 'stoppedDL' : 'metaDL',
          trackers: [],
          dl_limit: -1,
          auto_tmm: false,
        });
        added.push(hash);
      }
      return added.length
        ? { body: { success_count: added.length, failure_count: 0, pending_count: 0, added_torrent_ids: added } }
        : conflict('');
    },
    'torrents/setLocation': (f) => (
      pick(f.hashes).forEach((t) => ((t.save_path = f.location ?? ''), (t.auto_tmm = false))),
      ok()
    ),
    'torrents/setSavePath': (f) =>
      f.path === '/readonly'
        ? { status: 403, body: 'Cannot write to directory' }
        : (pick(f.id).forEach((t) => !t.auto_tmm && (t.save_path = f.path ?? '')), ok()),
    'torrents/addTrackers': (f) => (pick(f.hash).forEach((t) => t.trackers.push(...split(f.urls, '\n'))), ok()),
    'torrents/editTracker': (f) => {
      const t = state.torrents.get(f.hash ?? '');
      if (!t) return { status: 404, body: '' };
      const i = t.trackers.indexOf(f.url ?? '');
      if (i < 0) return conflict('Tracker not found');
      if (f.newUrl) t.trackers[i] = f.newUrl;
      return ok();
    },
    'torrents/removeTrackers': (f) => {
      const urls = split(f.urls, '|');
      pick(f.hash).forEach((t) => (t.trackers = t.trackers.filter((u) => !urls.includes(u))));
      return ok();
    },
    'transfer/setDownloadLimit': () => ok(),
    'transfer/setUploadLimit': () => ok(),
    'transfer/toggleSpeedLimitsMode': () => ((counters.speedLimitsMode = 1 - counters.speedLimitsMode), ok()),
    'app/setPreferences': (f) => {
      try {
        Object.assign(state.preferences, JSON.parse(f.json ?? '') as Record<string, unknown>);
      } catch {
        return { status: 400, body: 'Invalid json' };
      }
      return ok();
    },
    'app/shutdown': () => ((counters.shutdown = true), ok()),
    'rss/addFeed': (f) => {
      if (!f.url || !f.path) return { status: 400, body: '' };
      state.rssItems[f.path] = { uid: '{00000000-0000-0000-0000-000000000003}', url: f.url };
      return ok();
    },
    'rss/setFeedURL': (f) => {
      const item = lookupItem(f.path ?? '');
      if (!item || typeof item !== 'object' || !('url' in item)) return conflict('Feed not found');
      (item as { url: string }).url = f.url ?? '';
      return ok();
    },
    'rss/removeItem': (f) => (removeItem(f.path ?? '') ? ok() : conflict('Item not found')),
    'rss/setRule': (f) => {
      try {
        state.rssRules[f.ruleName ?? ''] = JSON.parse(f.ruleDef ?? '') as Record<string, unknown>;
      } catch {
        return { status: 400, body: 'Invalid ruleDef' };
      }
      return ok();
    },
    'rss/removeRule': (f) => (delete state.rssRules[f.ruleName ?? ''], ok()),
    'search/start': (f) => (f.pattern && f.plugins && f.category ? { body: { id: 7 } } : { status: 400, body: '' }),
    'search/stop': () => ok(),
    'search/delete': () => ok(),
    'search/installPlugin': (f) => (counters.installed.push(...split(f.sources, '|')), ok()),
    'search/uninstallPlugin': (f) => {
      const names = split(f.names, '|');
      state.plugins = state.plugins.filter((p) => !names.includes(p.name));
      return ok();
    },
    'search/enablePlugin': (f) => {
      const names = split(f.names, '|');
      state.plugins.forEach((p) => names.includes(p.name) && (p.enabled = f.enable === 'true'));
      return ok();
    },
    'search/updatePlugins': () => ((counters.updated += 1), ok()),
  };

  function lookupItem(path: string): unknown {
    let node: unknown = state.rssItems;
    for (const seg of path.split('\\'))
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined;
    return node;
  }
  function removeItem(path: string): boolean {
    const segs = path.split('\\');
    const last = segs.pop()!;
    const parent = segs.length ? lookupItem(segs.join('\\')) : state.rssItems;
    if (!parent || typeof parent !== 'object' || !(last in parent)) return false;
    delete (parent as Record<string, unknown>)[last];
    return true;
  }

  const reads: Record<string, (q: URLSearchParams) => FakeResponse> = {
    'app/version': () => ({ body: release === '5.2' ? 'v5.2.4' : 'v5.0.0' }),
    'app/webapiVersion': () => ({ body: release === '5.2' ? '2.15.1' : '2.11.2' }),
    'app/buildInfo': () => ({
      body: {
        qt: '6.8.2',
        libtorrent: '2.0.11.0',
        boost: '1.86.0',
        openssl: '3.4.1',
        zlib: '1.3.1',
        bitness: 64,
        platform: 'linux',
      },
    }),
    'app/preferences': () => ({ body: state.preferences }),
    'app/defaultSavePath': () => ({ body: '/downloads' }),
    'transfer/info': () => ({
      body: {
        dl_info_speed: 1_048_576,
        dl_info_data: 9_000_000,
        up_info_speed: 0,
        up_info_data: 1_000,
        dl_rate_limit: 0,
        up_rate_limit: 0,
        dht_nodes: 312,
        connection_status: 'connected',
      },
    }),
    'transfer/speedLimitsMode': () => ({ body: counters.speedLimitsMode }),
    'torrents/info': (q) => {
      let list = [...state.torrents.values()];
      const hashes = q.get('hashes');
      if (hashes) list = pick(hashes);
      const filter = q.get('filter');
      if (filter === 'downloading') list = list.filter((t) => t.state === 'downloading');
      const category = q.get('category');
      if (category !== null) list = list.filter((t) => t.category === category);
      return { body: list.map(info) };
    },
    'torrents/properties': (q) => {
      const t = state.torrents.get(q.get('hash') ?? '');
      return t
        ? {
            body: {
              hash: t.hash,
              name: t.name,
              save_path: t.save_path,
              comment: `Seeded from ${TRACKER.public}`,
              total_size: 6_114_656_256,
              share_ratio: 1.5,
            },
          }
        : { status: 404, body: '' };
    },
    'torrents/trackers': (q) => {
      const t = state.torrents.get(q.get('hash') ?? '');
      if (!t) return { status: 404, body: '' };
      return {
        body: [
          { url: '** [DHT] **', status: 2, tier: -1, num_peers: 30, msg: '' },
          ...t.trackers.map((url, i) => ({
            url,
            status: 2,
            tier: i,
            num_peers: 12,
            num_seeds: 8,
            num_leeches: 4,
            msg: i ? '' : `announce ok from ${url}`,
          })),
        ],
      };
    },
    'torrents/webseeds': () => ({ body: [{ url: `https://seed.example/files/?key=${SECRETS.webSeedKey}` }] }),
    'torrents/files': () => ({
      body: [{ index: 0, name: 'ubuntu.iso', size: 6_114_656_256, progress: 1, priority: 1, is_seed: true }],
    }),
    'torrents/pieceStates': () => ({ body: [2, 2, 1, 0] }),
    'torrents/categories': () => ({
      body: Object.fromEntries([...state.categories].map(([k, c]) => [k, { name: c.name, savePath: c.savePath }])),
    }),
    'torrents/tags': () => ({ body: [...state.tags] }),
    'sync/maindata': (q) => ({
      body: {
        rid: Number(q.get('rid') ?? 0) + 1,
        full_update: !q.get('rid'),
        torrents: Object.fromEntries([...state.torrents.values()].map((t) => [t.hash, info(t)])),
        categories: Object.fromEntries(state.categories),
        tags: [...state.tags],
        trackers: { [TRACKER.public]: [HASH.ubuntu], [TRACKER.private]: [HASH.debian] },
        server_state: { connection_status: 'connected', dl_info_speed: 1_048_576, free_space_on_disk: 1e12 },
      },
    }),
    'log/main': () => ({
      body: [
        { id: 1, message: 'qBittorrent v5.2.4 started', timestamp: 1_760_000_000, type: 1 },
        { id: 2, message: `Tracker error: "${TRACKER.private}" timed out`, timestamp: 1_760_000_100, type: 4 },
      ],
    }),
    'log/peers': () => ({
      body: [{ id: 1, ip: '203.0.113.7', timestamp: 1_760_000_000, blocked: true, reason: 'IP filter' }],
    }),
    'rss/items': (q) => ({ body: q.get('withData') === 'true' ? withArticles(state.rssItems) : state.rssItems }),
    'rss/rules': () => ({ body: state.rssRules }),
    'search/plugins': () => ({
      body: state.plugins.map((p) => ({
        ...p,
        fullName: 'Example search',
        version: '1.0',
        supportedCategories: [{ id: 'all', name: 'All categories' }],
      })),
    }),
    'search/status': () => ({ body: [{ id: 7, status: 'Stopped', total: 1 }] }),
    'search/results': () => ({
      body: {
        status: 'Stopped',
        total: 1,
        results: [
          {
            fileName: 'Ubuntu 24.04 Desktop',
            fileUrl: SEARCH_FILE_URL,
            fileSize: 6_114_656_256,
            nbSeeders: 120,
            nbLeechers: 4,
            siteUrl: 'https://search.example',
            descrLink: 'https://search.example/t/42',
          },
        ],
      },
    }),
  };

  function withArticles(items: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(items)) {
      const node = v as Record<string, unknown>;
      out[k] =
        'url' in node
          ? { ...node, articles: [{ id: 'a1', title: 'Ubuntu 24.04', torrentURL: `${String(node.url)}&item=1` }] }
          : withArticles(node);
    }
    return out;
  }

  const fake = await startFakeHttp({
    guard: (req) => {
      if (!req.path.startsWith('/api/v2/')) return { status: 404, body: 'Not Found' };
      if (req.headers.origin !== undefined || opts.refuseHost) return { status: 401, body: 'Unauthorized' };
      if (req.path === '/api/v2/auth/login') return undefined;
      const id = sid(req);
      return id && sessions.has(id) ? undefined : { status: 403, body: 'Forbidden' };
    },
    routes: {
      'POST /api/v2/auth/login': (req) => {
        const parsed = parseFields(req);
        if (parsed?.contentType !== 'form') return { status: 415, body: '' };
        self.logins++;
        const { username, password } = parsed.fields;
        if (username !== CREDENTIALS.username || password !== CREDENTIALS.password)
          return release === '5.2' ? { status: 401, body: 'Unauthorized' } : { body: 'Fails.' };
        const id = `EXAMPLE-session-${nextSession++}`;
        sessions.add(id);
        const headers = { 'set-cookie': [`${cookieName}=${id}; HttpOnly; path=/; SameSite=Lax`] };
        return release === '5.2' ? { status: 204, headers } : { body: 'Ok.', headers };
      },
      'GET /api/v2/{group}/{method}': (req) => {
        const name = `${req.params.group}/${req.params.method}`;
        if (actions[name]) return { status: 405, body: 'Method Not Allowed' };
        const read = reads[name];
        return read ? read(req.query) : { status: 404, body: 'Endpoint does not exist' };
      },
      'POST /api/v2/{group}/{method}': (req) => {
        const name = `${req.params.group}/${req.params.method}`;
        const action = actions[name];
        if (!action) return { status: 404, body: 'Endpoint does not exist' };
        const parsed = parseFields(req);
        if (
          !parsed ||
          parsed.contentType === 'none' ||
          (name === 'torrents/add') !== (parsed.contentType === 'multipart')
        )
          return { status: 415, body: 'Unsupported Media Type' };
        calls.push({ method: 'POST', path: name, contentType: parsed.contentType, fields: parsed.fields });
        return action(parsed.fields);
      },
    },
  });

  return {
    ...fake,
    get torrents() {
      return state.torrents;
    },
    get categories() {
      return state.categories;
    },
    get tags() {
      return state.tags;
    },
    get preferences() {
      return state.preferences;
    },
    get rssItems() {
      return state.rssItems;
    },
    get rssRules() {
      return state.rssRules;
    },
    get plugins() {
      return state.plugins;
    },
    calls,
    get logins() {
      return self.logins;
    },
    state: counters,
    expireSessions: () => sessions.clear(),
    reset() {
      Object.assign(state, initial());
      Object.assign(counters, { shutdown: false, deletedFiles: [], speedLimitsMode: 0, installed: [], updated: 0 });
      calls.length = 0;
    },
  };
}

/** A 40-hex id for a URL source, as qBittorrent would get from the downloaded torrent. */
function createHashLike(url: string): string {
  let h = 0;
  for (const c of url) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(5);
}
