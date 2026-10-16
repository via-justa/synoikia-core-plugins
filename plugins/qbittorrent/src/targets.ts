import { isPlainObject } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import type { UrlMasker } from './mask.js';
import { selection } from './params.js';
import { magnetEndpoints, magnetUrls } from './urls.js';
import type { CallParams } from './params.js';
import {
  categories,
  missing,
  origin,
  rssItems,
  rssRules,
  searchPlugins,
  tags,
  torrentTargets,
  trackerUrls,
  storedUrl,
} from './stored.js';
import type { Lookups } from './stored.js';

/** What a write acts on, read back from qBittorrent: torrents by stored name, categories, tags, RSS items and rules,
 * search plugins, trackers; the instance for instance-wide writes; and the origin of each URL qBittorrent will fetch.
 * Stable across the approval wait (core resolves again and compares), so no status or progress is included. */

export interface TargetContext {
  lookups: Lookups;
  masker: UrlMasker;
  host: string;
}

export const instanceTarget = (host: string): ResolvedTarget => ({
  kind: 'instance',
  id: host,
  name: `qBittorrent at ${host}`,
});

const lines = (v: unknown, sep: string | RegExp) =>
  (typeof v === 'string' ? v.split(sep) : []).map((s) => s.trim()).filter(Boolean);

/** A URL the call gives, by origin; a masked one by the URL it stands for. */
function urlTarget(masker: UrlMasker, kind: string, given: string, i: number): ResolvedTarget {
  const real = masker.unmask(given);
  return {
    kind,
    id: `${kind}:${i}:${real === undefined ? given : masker.url(real)}`,
    name: real ? origin(real) : 'an unknown masked URL',
  };
}

/** A source to add, and for a magnet link each tracker, web seed and source URL (by origin) and each peer and DHT
 * node (`host:port`) in it that qBittorrent will contact. */
function sourceTargets(masker: UrlMasker, given: string, i: number): ResolvedTarget[] {
  const real = masker.unmask(given);
  const magnet = real && /^magnet:/i.test(real) ? real : undefined;
  const urls = magnet ? magnetUrls(magnet) : [];
  const endpoints = magnet ? magnetEndpoints(magnet) : [];
  return [
    urlTarget(masker, 'source', given, i),
    ...urls.map((u, j) => ({ kind: 'magnet-url', id: `magnet-url:${i}:${j}:${masker.url(u)}`, name: origin(u) })),
    ...endpoints.map((e, j) => ({ kind: 'magnet-url', id: `magnet-endpoint:${i}:${j}:${e}`, name: e })),
  ];
}

/** The plugins a search runs, as qBittorrent picks them: `all` (any case) is every installed plugin, disabled ones
 * too; `enabled` (or `multi`) the enabled ones; names run whatever their enabled state. */
async function searchTargets(ctx: TargetContext, plugins: string): Promise<ResolvedTarget[]> {
  const stored = await searchPlugins(ctx.lookups);
  if (!stored) return [missing('search-plugin', plugins)];
  const names = plugins.split('|');
  const one = names.length === 1 ? names[0]!.toLowerCase() : undefined;
  const picked =
    one === 'all'
      ? [...stored.keys()]
      : one === 'enabled' || one === 'multi'
        ? [...stored].filter(([, enabled]) => enabled).map(([n]) => n)
        : names;
  return picked.map((n) =>
    !stored.has(n)
      ? missing('search-plugin', n)
      : { kind: stored.get(n) ? 'search-plugin' : 'disabled-search-plugin', id: n, name: n },
  );
}

async function torrentPart(ctx: TargetContext, key: string, params: CallParams): Promise<ResolvedTarget[]> {
  const sel = selection(key.split('#')[0]!, params);
  return sel ? torrentTargets(ctx.lookups, sel) : [];
}

async function trackerPart(ctx: TargetContext, params: CallParams, given: string[]): Promise<ResolvedTarget[]> {
  const hash = typeof params.hash === 'string' ? params.hash : '';
  const stored = (await trackerUrls(ctx.lookups, hash)) ?? [];
  return given.map((g) => {
    const real = storedUrl(ctx.masker, stored, g);
    return real
      ? { kind: 'tracker', id: ctx.masker.url(real), name: origin(real) }
      : { ...missing('tracker', ctx.masker.text(g)), name: `unknown tracker ${origin(ctx.masker.unmask(g) ?? '')}` };
  });
}

/** The targets of a write; reads have none. */
export async function writeTargets(ctx: TargetContext, key: string, params: CallParams): Promise<ResolvedTarget[]> {
  const base = key.split('#')[0]!;
  const l = ctx.lookups;
  const instance = [instanceTarget(ctx.host)];
  switch (base) {
    case 'torrents.add':
      return [...instance, ...lines(params.urls, '\n').flatMap((u, i) => sourceTargets(ctx.masker, u, i))];
    case 'torrents.addTrackers':
      return [
        ...(await torrentPart(ctx, key, params)),
        ...lines(params.urls, '\n').map((u, i) => urlTarget(ctx.masker, 'new-tracker', u, i)),
      ];
    case 'torrents.editTracker':
      return [
        ...(await torrentPart(ctx, key, params)),
        ...(await trackerPart(ctx, params, [String(params.url)])),
        ...(typeof params.newUrl === 'string' ? [urlTarget(ctx.masker, 'new-tracker', params.newUrl, 0)] : []),
      ];
    case 'torrents.removeTrackers':
      return [...(await torrentPart(ctx, key, params)), ...(await trackerPart(ctx, params, lines(params.urls, '|')))];
    case 'torrents.editCategory':
    case 'torrents.removeCategories': {
      const stored = await categories(l);
      const names = base === 'torrents.editCategory' ? [String(params.category)] : lines(params.categories, '\n');
      return names.map((n) => (stored?.has(n) ? { kind: 'category', id: n, name: n } : missing('category', n)));
    }
    case 'torrents.deleteTags': {
      const stored = await tags(l);
      return lines(params.tags, ',').map((t) => (stored?.has(t) ? { kind: 'tag', id: t, name: t } : missing('tag', t)));
    }
    case 'rss.addFeed':
      return [...instance, urlTarget(ctx.masker, 'feed-url', String(params.url), 0)];
    case 'rss.setFeedURL':
    case 'rss.removeItem': {
      const path = String(params.path);
      const item = (await rssItems(l))?.get(path);
      const ok = item && (base === 'rss.removeItem' || item.url !== undefined);
      if (!ok) return [missing('rss-item', path)];
      const target: ResolvedTarget = { kind: 'rss-item', id: path, name: path };
      if (base === 'rss.setFeedURL') return [target, urlTarget(ctx.masker, 'feed-url', String(params.url), 0)];
      return item.url === undefined
        ? [target, { kind: 'rss-folder-feeds', id: `feeds:${path}`, name: String(item.feeds) }]
        : [target];
    }
    case 'rss.setRule': {
      const name = String(params.ruleName);
      const rules = await rssRules(l);
      const def = isPlainObject(params.ruleDef) ? params.ruleDef : {};
      const feeds = Array.isArray(def.affectedFeeds) ? def.affectedFeeds.filter((f) => typeof f === 'string') : [];
      const stored = [...((await rssItems(l))?.values() ?? [])].flatMap((i) => (i.url ? [i.url] : []));
      const feedTargets = feeds.map((f, i): ResolvedTarget => {
        const real = storedUrl(ctx.masker, stored, f) ?? ctx.masker.unmask(f);
        return {
          kind: 'feed-url',
          id: `feed-url:${i}:${real ? ctx.masker.url(real) : f}`,
          name: real ? origin(real) : 'an unknown masked URL',
        };
      });
      const rule = rules && Object.hasOwn(rules, name) ? [{ kind: 'rss-rule', id: name, name }] : instance;
      return [...rule, ...feedTargets];
    }
    case 'rss.removeRule': {
      const name = String(params.ruleName);
      const rules = await rssRules(l);
      return [rules && Object.hasOwn(rules, name) ? { kind: 'rss-rule', id: name, name } : missing('rss-rule', name)];
    }
    case 'search.start':
      return [...instance, ...(await searchTargets(ctx, String(params.plugins)))];
    case 'search.uninstallPlugin':
    case 'search.enablePlugin': {
      const stored = await searchPlugins(l);
      return lines(params.names, '|').map((n) =>
        stored?.has(n) ? { kind: 'search-plugin', id: n, name: n } : missing('search-plugin', n),
      );
    }
    case 'search.installPlugin':
      return [...instance, ...lines(params.sources, '|').map((u, i) => urlTarget(ctx.masker, 'source', u, i))];
    case 'search.stop':
    case 'search.delete':
      return [{ kind: 'search', id: String(params.id), name: `search ${String(params.id)}` }];
    case 'torrents.createCategory':
    case 'torrents.createTags':
    case 'transfer.setDownloadLimit':
    case 'transfer.setUploadLimit':
    case 'transfer.toggleSpeedLimitsMode':
    case 'app.setPreferences':
    case 'app.shutdown':
    case 'search.updatePlugins':
      return instance;
    default:
      return torrentPart(ctx, key, params);
  }
}

/** Names of the targets of one kind, or undefined when none or any of that kind is missing. */
const storedNames = (targets: readonly ResolvedTarget[], kind: string, field: 'id' | 'name' = 'name') => {
  if (targets.some((t) => t.kind === `missing-${kind}`)) return undefined;
  const names = targets.filter((t) => t.kind === kind).map((t) => t[field]);
  return names.length ? names : undefined;
};

/** Confirm literals, from the stored objects in the targets; none when one of them is missing. */
export const literals = {
  torrents: (targets: readonly ResolvedTarget[]) => {
    const all = targets.find((t) => t.kind === 'all-torrents');
    if (all) return all.name;
    if (targets.some((t) => t.kind === 'missing-torrent' || t.kind === 'missing-tracker')) return undefined;
    const names = storedNames(targets, 'torrent');
    return names && (names.length === 1 ? names[0] : `${names.length} torrents`);
  },
  categories: (targets: readonly ResolvedTarget[]) => storedNames(targets, 'category')?.join(', '),
  tags: (targets: readonly ResolvedTarget[]) => storedNames(targets, 'tag')?.join(', '),
  rssItem: (targets: readonly ResolvedTarget[]) => storedNames(targets, 'rss-item', 'id')?.[0],
  rssRule: (targets: readonly ResolvedTarget[]) => storedNames(targets, 'rss-rule')?.[0],
  searchPlugins: (targets: readonly ResolvedTarget[]) => storedNames(targets, 'search-plugin')?.join(', '),
};

/** Whether a call names something qBittorrent does not have; then no literal comes from the host name either. */
export const hasMissing = (targets: readonly ResolvedTarget[]) => targets.some((t) => t.kind.startsWith('missing-'));
