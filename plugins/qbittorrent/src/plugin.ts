import { randomBytes } from 'node:crypto';
import {
  baseKey,
  compileRules,
  definePlugin,
  ErrorCodes,
  HttpJsonClient,
  isPlainObject,
  joinApiPath,
  parseBaseUrl,
  parsePluginSettings,
  PluginError,
  REDACTED,
  requireString,
  staticCatalog,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { UrlMasker } from './mask.js';
import { urlProblem } from './urls.js';
import { checkCategoryName, checkInnerPath, checkParams, invalid } from './params.js';
import type { CallParams, HttpOperation } from './params.js';
import { checkPolicy } from './policy.js';
import { QbtApi, QbtSession, SERVICE } from './session.js';
import { addDestination, categoryPath, pathSettings, ruleDestination } from './paths.js';
import { rssItems, storedUrl, trackerUrls } from './stored.js';
import type { Lookups } from './stored.js';
import { summaryText } from './summary.js';
import { hasMissing, literals, writeTargets } from './targets.js';
import { quote } from './text.js';

/** The qBittorrent plugin: operations declared in plugin.yaml over the WebUI API v2, signed in with the WebUI
 * session cookie; the sandbox calls `qbittorrent.call(operation, params)` with flat params. */

interface PreferenceNote {
  note: string;
  keys: RegExp[];
}

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    if (typeof p.apiPath !== 'string' || !p.apiPath.startsWith('/'))
      throw new Error('plugin.yaml plugin.apiPath must be a path');
    if (typeof p.minWebApi !== 'string' || !/^\d+\.\d+$/.test(p.minWebApi))
      throw new Error('plugin.yaml plugin.minWebApi must be a major.minor version');
    if (typeof p.maxNames !== 'number' || !Number.isInteger(p.maxNames) || p.maxNames < 1)
      throw new Error('plugin.yaml plugin.maxNames must be a positive integer');
    if (!Array.isArray(p.preferenceNotes)) throw new Error('plugin.yaml plugin.preferenceNotes must be a list');
    const preferenceNotes = p.preferenceNotes.map((n): PreferenceNote => {
      if (!isPlainObject(n) || typeof n.note !== 'string' || !Array.isArray(n.keys))
        throw new Error('plugin.yaml plugin.preferenceNotes entries need a note and keys');
      const keys = n.keys.map((k) => {
        if (typeof k !== 'string' || !/^[a-z0-9_*]+$/i.test(k))
          throw new Error('plugin.yaml plugin.preferenceNotes keys must be names or globs');
        return new RegExp(`^${k.replace(/\*/g, '.*')}$`);
      });
      return { note: n.note, keys };
    });
    return { apiPath: p.apiPath, minWebApi: p.minWebApi, maxNames: p.maxNames, preferenceNotes };
  },
});

const OPERATIONS = new Map(
  settings.operations.flatMap((op): [string, HttpOperation][] => (op.http ? [[op.key, { ...op, http: op.http }]] : [])),
);

// At load, so the plugin never starts with a lock or split that names no operation, or a required lock gone.
checkPolicy(settings, compileRules(settings));

function operation(key: string): HttpOperation {
  const op = OPERATIONS.get(baseKey(key));
  if (!op) throw new PluginError(ErrorCodes.UnknownOperation, `${key} is not a ${SERVICE} operation`);
  return op;
}

const lines = (v: unknown, sep: string) =>
  (typeof v === 'string' ? v.split(sep) : []).map((s) => s.trim()).filter(Boolean);

/** When a call takes a locked twin (plugin.yaml `split`). */
const SPLIT_WHEN: Record<string, (params: CallParams) => boolean> = {
  'with-files': (p) => p.deleteFiles === true,
  remove: (p) => p.shareLimitAction === 'Remove' || p.shareLimitAction === 'RemoveWithContent',
  all: (p) => p.hashes === 'all',
  paths: (p) => Boolean(p.savePath) || Boolean(p.downloadPath) || p.downloadPathEnabled === true,
};

const MAX_URLS = 100;
const SCHEMES = {
  source: { re: /^(https?:\/\/|magnet:\?)/i, text: 'only http(s) URLs and magnet links' },
  tracker: { re: /^(https?|udp):\/\//i, text: 'only http(s) and udp tracker URLs' },
  feed: { re: /^https?:\/\//i, text: 'only http(s) URLs' },
  plugin: { re: /^https:\/\//i, text: 'only https URLs' },
} as const;

/** Never write a redacted value back as if it were the real one. */
function refuseRedacted(op: HttpOperation, value: unknown, where: string): void {
  if (typeof value === 'string') {
    if (value.includes(REDACTED)) throw invalid(`${op.key} ${where} holds a redacted value; give the real value`);
  } else if (Array.isArray(value)) value.forEach((v, i) => refuseRedacted(op, v, `${where}[${i}]`));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) refuseRedacted(op, v, `${where}.${k}`);
}

export interface QbittorrentOptions {
  /** Key of the URL masks; random per process unless a test fixes it. */
  maskKey?: Uint8Array;
}

export function createQbittorrentPlugin(opts: QbittorrentOptions = {}): PluginHandlers {
  const masker = new UrlMasker(opts.maskKey ?? randomBytes(32));

  /** URLs the call gives, each unmasked and of an allowed scheme. */
  const urlsOf = (op: HttpOperation, name: string, values: string[], kind: keyof typeof SCHEMES): string[] => {
    if (values.length > MAX_URLS) throw invalid(`${op.key} ${name}: at most ${MAX_URLS} URLs`);
    return values.map((v) => {
      const real = masker.unmask(v);
      if (real === undefined)
        throw invalid(`${op.key} ${name}: a masked URL this plugin no longer knows; read it again and retry`);
      if (!SCHEMES[kind].re.test(real)) throw invalid(`${op.key} ${name}: ${SCHEMES[kind].text}`);
      const problem = urlProblem(real);
      if (problem) throw invalid(`${op.key} ${name}: a URL that ${problem}`);
      return real;
    });
  };

  /** Checks a call beyond its schema: URL schemes and masks, paths inside torrents, preference names. */
  function checkCall(op: HttpOperation, p: CallParams): void {
    refuseRedacted(op, p, 'params');
    switch (op.key) {
      case 'torrents.add':
        urlsOf(op, 'urls', lines(p.urls, '\n'), 'source');
        checkCategoryName(op, 'category', p.category);
        break;
      case 'torrents.setCategory':
      case 'torrents.createCategory':
      case 'torrents.editCategory':
        checkCategoryName(op, 'category', p.category);
        break;
      case 'torrents.removeCategories':
        for (const c of lines(p.categories, '\n')) checkCategoryName(op, 'categories', c);
        break;
      case 'torrents.addTrackers':
        urlsOf(op, 'urls', lines(p.urls, '\n'), 'tracker');
        break;
      case 'torrents.editTracker':
        if (p.newUrl === undefined && p.tier === undefined) throw invalid(`${op.key} needs newUrl or tier`);
        if (typeof p.newUrl === 'string') urlsOf(op, 'newUrl', [p.newUrl], 'tracker');
        break;
      case 'rss.addFeed':
      case 'rss.setFeedURL':
        urlsOf(op, 'url', [String(p.url)], 'feed');
        break;
      case 'search.installPlugin':
        urlsOf(op, 'sources', lines(p.sources, '|'), 'plugin');
        break;
      case 'torrents.renameFile':
      case 'torrents.renameFolder':
        checkInnerPath(op, 'oldPath', p.oldPath);
        checkInnerPath(op, 'newPath', p.newPath);
        break;
      case 'torrents.filePrio':
      case 'torrents.files':
        for (const name of ['id', 'indexes'])
          if (p[name] !== undefined && !/^\d+(\|\d+)*$/.test(String(p[name])))
            throw invalid(`${op.key} ${name} must be file indexes joined with |`);
        break;
      case 'app.setPreferences':
        for (const k of Object.keys(isPlainObject(p.json) ? p.json : {}))
          if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k))
            throw invalid(`${op.key} json: ${JSON.stringify(k.slice(0, 80))} is not a preference name`);
        break;
      case 'rss.setRule': {
        const def = isPlainObject(p.ruleDef) ? p.ruleDef : {};
        checkCategoryName(op, 'ruleDef.assignedCategory', def.assignedCategory);
        if (isPlainObject(def.torrentParams))
          checkCategoryName(op, 'ruleDef.torrentParams.category', def.torrentParams.category);
        const feeds = def.affectedFeeds;
        if (feeds !== undefined && !(Array.isArray(feeds) && feeds.every((f) => typeof f === 'string')))
          throw invalid(`${op.key} ruleDef.affectedFeeds must be a list of feed URLs`);
        for (const f of (feeds ?? []) as string[]) {
          const problem = UrlMasker.isMasked(f) ? undefined : urlProblem(f);
          if (problem) throw invalid(`${op.key} ruleDef.affectedFeeds: a URL that ${problem}`);
        }
        break;
      }
    }
  }

  return definePlugin({
    connect(init) {
      const session = new QbtSession(init);
      const http = new HttpJsonClient({
        baseUrl: joinApiPath(requireString(init.config, 'baseUrl'), settings.plugin.apiPath),
        service: SERVICE,
        verifyTls: init.config.verifyTls !== false,
        timeoutMs: settings.defaults.timeouts.request,
        headers: () => session.headers(),
      });
      return new QbtApi(http, session, settings.defaults.timeouts.request);
    },

    // The WebUI API version decides support (5.0 renamed pause/resume); both calls also prove the sign-in.
    async version(kit) {
      const api = await kit.client().request('GET', '/app/webapiVersion');
      const app = await kit.client().request('GET', '/app/version');
      if (typeof api !== 'string' || typeof app !== 'string')
        throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      const m = /^(\d+)\.(\d+)/.exec(api.trim());
      if (!m) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      const [major, minor] = settings.plugin.minWebApi.split('.').map(Number) as [number, number];
      if (Number(m[1]) < major || (Number(m[1]) === major && Number(m[2]) < minor))
        throw new PluginError(
          ErrorCodes.UpstreamError,
          `${SERVICE} ${app.trim()} (WebUI API ${api.trim()}) is not supported; this plugin needs qBittorrent 5.0 or later`,
        );
      return `${app.trim()} (WebUI API ${api.trim()})`;
    },

    handlers(kit) {
      const client = () => kit.client();
      const host = () => parseBaseUrl(requireString(kit.init().config, 'baseUrl')).url.hostname;
      const lookups = (timeoutMs = settings.defaults.timeouts.lookup): Lookups => ({ client: client(), timeoutMs });
      const rules = compileRules(settings, {
        custom: {
          host: ({ targets }) => (hasMissing(targets) ? undefined : host()),
          torrents: ({ targets }) => literals.torrents(targets),
          categories: ({ targets }) => literals.categories(targets),
          tags: ({ targets }) => literals.tags(targets),
          rssItem: ({ targets }) => literals.rssItem(targets),
          rssRule: ({ targets }) => literals.rssRule(targets),
          searchPlugins: ({ targets }) => literals.searchPlugins(targets),
        },
      });
      const operations = staticCatalog(rules);
      const preferenceNotes = (k: string) =>
        settings.plugin.preferenceNotes.filter((n) => n.keys.some((re) => re.test(k))).map((n) => n.note);

      /** The checked params of a call and the key it takes: its locked twin when a split applies. */
      function resolve(key: string, params: unknown): { key: string; params: CallParams } {
        const op = operation(key);
        const p = checkParams(op, params);
        checkCall(op, p);
        for (const suffix of rules.splits(op.key)) {
          const when = SPLIT_WHEN[suffix];
          if (!when) throw new PluginError(ErrorCodes.Internal, `no split predicate for ${suffix}`);
          if (when(p)) return { key: `${op.key}#${suffix}`, params: p };
        }
        return { key: op.key, params: p };
      }

      /** The form body sent: URLs unmasked, and trackers and feeds as qBittorrent stores them. */
      async function body(op: HttpOperation, p: CallParams, timeoutMs: number): Promise<CallParams> {
        const l = lookups(timeoutMs);
        switch (op.key) {
          case 'torrents.add':
            return { ...p, urls: urlsOf(op, 'urls', lines(p.urls, '\n'), 'source').join('\n') };
          case 'torrents.addTrackers':
            return { ...p, urls: urlsOf(op, 'urls', lines(p.urls, '\n'), 'tracker').join('\n') };
          case 'rss.addFeed':
          case 'rss.setFeedURL':
            return { ...p, url: urlsOf(op, 'url', [String(p.url)], 'feed')[0] };
          case 'search.installPlugin':
            return { ...p, sources: urlsOf(op, 'sources', lines(p.sources, '|'), 'plugin').join('|') };
          case 'torrents.editTracker':
          case 'torrents.removeTrackers': {
            const stored = await trackerUrls(l, String(p.hash));
            const given = op.key === 'torrents.editTracker' ? [String(p.url)] : lines(p.urls, '|');
            const real = given.map((g) => (stored ? storedUrl(masker, stored, g) : undefined));
            if (real.some((r) => r === undefined)) throw invalid(`${op.key}: a tracker the torrent does not have`);
            if (op.key === 'torrents.removeTrackers') return { ...p, urls: real.join('|') };
            const newUrl = typeof p.newUrl === 'string' ? urlsOf(op, 'newUrl', [p.newUrl], 'tracker')[0] : undefined;
            return { ...p, url: real[0], ...(newUrl ? { newUrl } : {}) };
          }
          case 'rss.setRule': {
            const def = isPlainObject(p.ruleDef) ? p.ruleDef : {};
            if (!Array.isArray(def.affectedFeeds)) return p;
            const items = await rssItems(l);
            const stored = [...(items?.values() ?? [])].flatMap((i) => (i.url ? [i.url] : []));
            const feeds = def.affectedFeeds.map((f) => storedUrl(masker, stored, String(f)));
            if (feeds.some((f) => f === undefined))
              throw invalid(`${op.key}: affectedFeeds names a feed qBittorrent does not have`);
            return { ...p, ruleDef: { ...def, affectedFeeds: feeds } };
          }
          default:
            return p;
        }
      }

      return {
        async syncCatalog() {
          return { upstreamVersion: await kit.version(), operations };
        },

        async resolveOperation({ fn, args }) {
          if (fn !== 'call')
            throw new PluginError(ErrorCodes.UnknownOperation, `qbittorrent.${fn} is not a binding function`);
          const [key, params] = args;
          if (typeof key !== 'string' || !key || key.includes('#'))
            throw invalid('qbittorrent.call(operation, params): operation must be a name');
          return resolve(key, params);
        },

        async resolveTargets({ key, params }) {
          const op = operation(key);
          if (op.classification === 'read') return [];
          return writeTargets({ lookups: lookups(), masker, host: host() }, key, checkParams(op, params));
        },

        async summarize({ key, params, targets }) {
          const op = operation(key);
          const p = isPlainObject(params) ? params : {};
          if (op.classification === 'read') return { text: `${SERVICE} ${key} on qBittorrent at ${host()}` };
          const paths = ['torrents.add', 'torrents.setCategory', 'torrents.editCategory', 'rss.setRule'].includes(
            op.key,
          )
            ? await pathSettings(lookups())
            : undefined;
          const category = typeof p.category === 'string' ? p.category : '';
          let destination: string | undefined;
          if (op.key === 'torrents.add') destination = addDestination(paths, p);
          else if (op.key === 'rss.setRule') destination = ruleDestination(paths, p.ruleDef);
          else if (paths && op.key === 'torrents.setCategory')
            destination =
              category && !paths.categories.has(category)
                ? `the path of category ${quote(category)}, which does not exist`
                : quote(categoryPath(paths, category));
          else if (paths && op.key === 'torrents.editCategory' && typeof p.savePath === 'string')
            destination = quote(
              categoryPath({ ...paths, categories: new Map(paths.categories).set(category, p.savePath) }, category),
            );
          const notes = rules.summaryNotes(key).map((n) => ` ${n}`);
          const text =
            summaryText({
              key,
              params: p,
              targets,
              host: host(),
              maxNames: settings.plugin.maxNames,
              destination,
              preferenceNotes,
            }) + notes.join('');
          const literal = await rules.confirmLiteral({ key, params: p, targets });
          return literal ? { text, confirmLiteral: literal } : { text };
        },

        async invoke({ key, params, context }) {
          const op = operation(key);
          const timeoutMs = kit.timeout(context);
          const resolved = resolve(op.key, params);
          if (resolved.key !== key) throw invalid(`${key} does not match the call's params; it takes ${resolved.key}`);
          const p = resolved.params;
          let result: unknown;
          try {
            result =
              op.http.method === 'GET'
                ? await client().request('GET', op.http.path, { query: p, timeoutMs })
                : await client().request(op.http.method, op.http.path, {
                    body: await body(op, p, timeoutMs),
                    bodyEncoding: op.http.body,
                    timeoutMs,
                  });
          } catch (err) {
            // qBittorrent's error text can quote what it was given, a URL among it.
            if (err instanceof PluginError) throw new PluginError(err.code, masker.text(err.message), err.data);
            throw err;
          }
          if (op.classification === 'write') {
            if (result === 'Fails.')
              throw new PluginError(ErrorCodes.UpstreamError, `${op.key}: ${SERVICE} answered Fails.`);
            if (result === null || result === '' || result === 'Ok.') return { ok: true };
          }
          return masker.deep(result);
        },
      };
    },
  });
}
