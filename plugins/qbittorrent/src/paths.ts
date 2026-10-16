import { isPlainObject, stringOr } from '@synoikia/plugin-sdk';
import { categories } from './stored.js';
import type { Lookups } from './stored.js';
import { quote } from './text.js';

/** Where qBittorrent saves a torrent, as `SessionImpl::categorySavePath` and `buildLoadTorrentParams` decide it, so
 * an approval names the directory data lands in or moves to even when no call param names it. */

export interface PathSettings {
  /** The default save path (`save_path`). */
  defaultPath: string;
  /** Stored category save paths by name; empty for an implicit path. */
  categories: Map<string, string>;
  /** New torrents use automatic management unless told otherwise (`auto_tmm_enabled`). */
  autoTmmDefault: boolean;
  /** Manual-mode torrents still start from the category's path (`use_category_paths_in_manual_mode`). */
  categoryPathsInManual: boolean;
  /** An implicit path nests under the parent category's path: `use_subcategories` on 5.0 and 5.1, always from 5.2
   * (WebUI API 2.15), whose `categorySavePath` dropped the other branch. */
  nested: boolean;
}

/** The settings the paths depend on, read from qBittorrent; undefined when a read fails. */
export async function pathSettings(l: Lookups): Promise<PathSettings | undefined> {
  const get = (path: string) => l.client.request('GET', path, { timeoutMs: l.timeoutMs }).catch(() => undefined);
  const [prefs, cats, api] = await Promise.all([get('/app/preferences'), categories(l), get('/app/webapiVersion')]);
  const m = typeof api === 'string' ? /^(\d+)\.(\d+)/.exec(api.trim()) : null;
  if (!m) return undefined;
  const from52 = Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 15);
  const defaultPath = isPlainObject(prefs) ? stringOr(prefs.save_path) : undefined;
  if (!isPlainObject(prefs) || !defaultPath || !cats) return undefined;
  return {
    defaultPath,
    categories: new Map([...cats].map(([name, c]) => [name, c.savePath])),
    autoTmmDefault: prefs.auto_tmm_enabled === true,
    categoryPathsInManual: prefs.use_category_paths_in_manual_mode === true,
    nested: from52 || prefs.use_subcategories === true,
  };
}

const isAbsolute = (p: string) => p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p);
const join = (base: string, rel: string) => `${base.replace(/[\\/]+$/, '')}/${rel}`;

/** `QDir::cleanPath` as `Path` applies it: separators collapsed, `.` dropped, `..` resolved. */
export function clean(path: string): string {
  const root = /^(\/|[A-Za-z]:\/)/.exec(path.replace(/\\/g, '/'))?.[0] ?? '';
  const out: string[] = [];
  for (const seg of path.replace(/\\/g, '/').slice(root.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out.at(-1) !== '..') out.pop();
    else if (seg !== '..' || !root) out.push(seg);
  }
  return root + out.join('/');
}

/** `Utils::Fs::toValidPath`: runs of `:?"*<>|` become one space. */
const validPath = (name: string) => name.replace(/[:?"*<>|]+/g, ' ');

/** A category's save path, cleaned as qBittorrent's `Path` cleans it: its own (relative to the default save path),
 * else implicit: nested, `<parent's path>/<last segment>`; else the whole name under the default save path. No
 * category: the default. */
export function categoryPath(s: PathSettings, name: string): string {
  return clean(rawCategoryPath(s, name));
}

function rawCategoryPath(s: PathSettings, name: string): string {
  if (!name) return s.defaultPath;
  const own = s.categories.get(name) ?? '';
  if (own) return isAbsolute(own) ? own : join(s.defaultPath, own);
  if (!s.nested) return join(s.defaultPath, validPath(name));
  const sep = name.lastIndexOf('/');
  return join(rawCategoryPath(s, sep < 0 ? '' : name.slice(0, sep)), validPath(name.slice(sep + 1)));
}

/** A download path as shown: absolute and cleaned, or relative to the download path qBittorrent picks. */
export function downloadPathText(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.trim()) return undefined;
  const p = path.trim();
  return isAbsolute(p) ? quote(clean(p)) : `${quote(clean(p))} (under the default download path)`;
}

/** Where an RSS rule's downloads land: its `torrentParams` (or the legacy `savePath` and `assignedCategory`) read as
 * `torrents/add` params, since qBittorrent adds each match with them. */
export function ruleDestination(s: PathSettings | undefined, ruleDef: unknown): string {
  const def = isPlainObject(ruleDef) ? ruleDef : {};
  const tp = isPlainObject(def.torrentParams) ? def.torrentParams : {};
  return addDestination(s, {
    savepath: tp.save_path ?? def.savePath,
    downloadPath: tp.download_path,
    category: tp.category ?? def.assignedCategory,
    autoTMM: tp.use_auto_tmm,
  });
}

/** Where `torrents/add` saves, destination text for the approval. With automatic management (asked for, or the
 * default when no path is given) qBittorrent ignores `savepath` and uses the category's path. */
export function addDestination(s: PathSettings | undefined, p: Record<string, unknown>): string {
  if (!s) return 'a save path qBittorrent did not report';
  const category = typeof p.category === 'string' ? p.category : '';
  const savepath = typeof p.savepath === 'string' ? p.savepath.trim() : '';
  const downloadPath = typeof p.downloadPath === 'string' ? p.downloadPath.trim() : '';
  const auto = typeof p.autoTMM === 'boolean' ? p.autoTMM : !savepath && !downloadPath && s.autoTmmDefault;
  if (auto) {
    const ignored = savepath ? `; savepath ${quote(savepath)} is ignored` : '';
    return `${quote(categoryPath(s, category))} (automatic management${category ? `, category ${quote(category)}` : ''}${ignored})`;
  }
  const useCategory = (typeof p.autoTMM === 'boolean' ? p.autoTMM : s.autoTmmDefault) || s.categoryPathsInManual;
  const base = useCategory ? categoryPath(s, category) : s.defaultPath;
  if (!savepath)
    return `${quote(base)} (${useCategory && category ? "the category's save path" : 'the default save path'})`;
  return quote(clean(isAbsolute(savepath) ? savepath : join(base, savepath)));
}
