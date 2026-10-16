import { createHash } from 'node:crypto';
import { isPlainObject, stringOr } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import type { UrlMasker } from './mask.js';
import type { HashSelection } from './params.js';
import type { QbtApi } from './session.js';
import { quote } from './text.js';
import { magnetParams } from './urls.js';

/** Reads of what a write acts on, as qBittorrent stores it: torrents, categories, tags, RSS items and rules,
 * search plugins and trackers. Each returns undefined when the read fails, so callers fail closed. */

export interface Torrent {
  hash: string;
  name: string;
  savePath: string;
}

export interface Lookups {
  client: QbtApi;
  timeoutMs: number;
}

async function read(l: Lookups, path: string, query?: Record<string, unknown>): Promise<unknown> {
  try {
    return await l.client.request('GET', path, { query, timeoutMs: l.timeoutMs });
  } catch {
    return undefined;
  }
}

/** Every torrent, or the ones with these hashes. */
export async function torrents(l: Lookups, hashes?: readonly string[]): Promise<Torrent[] | undefined> {
  const body = await read(l, '/torrents/info', hashes ? { hashes: hashes.join('|') } : undefined);
  if (!Array.isArray(body)) return undefined;
  return body.flatMap((t) => {
    const hash = isPlainObject(t) ? stringOr(t.hash)?.toLowerCase() : undefined;
    if (!isPlainObject(t) || !hash) return [];
    return [{ hash, name: stringOr(t.name) ?? hash, savePath: stringOr(t.save_path) ?? '' }];
  });
}

export interface Category {
  name: string;
  savePath: string;
}

export async function categories(l: Lookups): Promise<Map<string, Category> | undefined> {
  const body = await read(l, '/torrents/categories');
  if (!isPlainObject(body)) return undefined;
  return new Map(
    Object.entries(body).map(([name, c]) => [
      name,
      { name, savePath: (isPlainObject(c) && (stringOr(c.savePath) ?? stringOr(c.save_path))) || '' },
    ]),
  );
}

export async function tags(l: Lookups): Promise<Set<string> | undefined> {
  const body = await read(l, '/torrents/tags');
  return Array.isArray(body) ? new Set(body.filter((t): t is string => typeof t === 'string')) : undefined;
}

export interface RssItem {
  path: string;
  /** A feed's URL; undefined for a folder. */
  url?: string;
  /** Feeds in a folder, at any depth. */
  feeds: number;
}

/** RSS folders and feeds by path (`Folder\Feed`): a feed is an object with a `uid` or `url`, a folder any other. */
export async function rssItems(l: Lookups): Promise<Map<string, RssItem> | undefined> {
  const body = await read(l, '/rss/items', { withData: false });
  if (!isPlainObject(body)) return undefined;
  const out = new Map<string, RssItem>();
  const walk = (node: Record<string, unknown>, prefix: string): number => {
    let count = 0;
    for (const [name, child] of Object.entries(node)) {
      if (!isPlainObject(child)) continue;
      const path = prefix ? `${prefix}\\${name}` : name;
      const url = stringOr(child.url);
      if (url !== undefined || typeof child.uid === 'string') {
        out.set(path, { path, url, feeds: 1 });
        count++;
      } else {
        const feeds = walk(child, path);
        out.set(path, { path, feeds });
        count += feeds;
      }
    }
    return count;
  };
  walk(body, '');
  return out;
}

export async function rssRules(l: Lookups): Promise<Record<string, unknown> | undefined> {
  const body = await read(l, '/rss/rules');
  return isPlainObject(body) ? body : undefined;
}

/** Installed search plugins by name, and whether each is enabled. */
export async function searchPlugins(l: Lookups): Promise<Map<string, boolean> | undefined> {
  const body = await read(l, '/search/plugins');
  if (!Array.isArray(body)) return undefined;
  return new Map(
    body.flatMap((p): [string, boolean][] =>
      isPlainObject(p) && stringOr(p.name) ? [[String(p.name), p.enabled === true]] : [],
    ),
  );
}

/** A torrent's tracker URLs, without the DHT, PeX and LSD rows. */
export async function trackerUrls(l: Lookups, hash: string): Promise<string[] | undefined> {
  const body = await read(l, '/torrents/trackers', { hash });
  if (!Array.isArray(body)) return undefined;
  return body.flatMap((t) => {
    const url = isPlainObject(t) ? stringOr(t.url) : undefined;
    return url && /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? [url] : [];
  });
}

/** The stored URL a given one stands for: the same URL, or its masked form as results show it. */
export function storedUrl(masker: UrlMasker, stored: readonly string[], given: string): string | undefined {
  return stored.find((u) => u === given) ?? stored.find((u) => masker.url(u) === given);
}

/** A URL's scheme, host and port, for summaries; never its path, query or credentials. */
export function origin(url: string): string {
  if (/^magnet:/i.test(url)) {
    // libtorrent keeps the last `dn`.
    const dn = magnetParams(url)
      .filter((p) => p.key === 'dn')
      .at(-1)?.value;
    return dn ? `magnet ${quote(dn, 120)}` : 'a magnet link';
  }
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'an invalid URL';
  }
}

/** Targets of a torrent selection: each torrent by its stored name (an unknown hash as `missing`), or for `all`
 * one target whose id hashes the current set, so a torrent added during the approval wait changes it. */
export async function torrentTargets(l: Lookups, sel: HashSelection): Promise<ResolvedTarget[]> {
  if (sel.all) {
    const all = await torrents(l);
    if (!all) return [];
    const digest = createHash('sha256')
      .update(
        all
          .map((t) => t.hash)
          .sort()
          .join('|'),
      )
      .digest('hex')
      .slice(0, 16);
    return [{ kind: 'all-torrents', id: `all:${all.length}:${digest}`, name: `all ${all.length} torrents` }];
  }
  const found = await torrents(l, sel.hashes);
  if (!found) return sel.hashes.map((h) => missing('torrent', h));
  return sel.hashes.map((h) => {
    const t = found.find((f) => f.hash === h);
    return t ? { kind: 'torrent', id: t.hash, name: t.name } : missing('torrent', h);
  });
}

/** A name the call gives that qBittorrent does not have: shown, and no confirmation literal comes from it. */
export const missing = (kind: string, id: string): ResolvedTarget => ({ kind: `missing-${kind}`, id, name: id });
