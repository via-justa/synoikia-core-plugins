import { isPlainObject, REDACTED } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import { downloadPathText } from './paths.js';
import { SERVICE } from './session.js';
import { quote, quotedList, safe } from './text.js';

/** Approval text: `qBittorrent <key> <destination>: <what changes>`. The destination comes first (the stored
 * torrents, categories or items from the targets, or the path data moves to), model-written strings are escaped and
 * quoted, and URLs show only their origin, from the targets. */

export interface SummaryInput {
  key: string;
  params: Record<string, unknown>;
  targets: readonly ResolvedTarget[];
  host: string;
  maxNames: number;
  /** Where data lands or moves, as qBittorrent resolves it: add's save path text, the path setCategory moves
   * auto-managed torrents to, editCategory's new path. Undefined when the settings could not be read. */
  destination?: string;
  /** Notes per changed preference key (`runs a program`). */
  preferenceNotes?: (key: string) => string[];
}

const of = (targets: readonly ResolvedTarget[], ...kinds: string[]) => targets.filter((t) => kinds.includes(t.kind));
const missingOf = (targets: readonly ResolvedTarget[]) => targets.filter((t) => t.kind.startsWith('missing-'));

function torrentsText(targets: readonly ResolvedTarget[], max: number): string {
  const all = of(targets, 'all-torrents')[0];
  if (all) return all.name;
  const found = of(targets, 'torrent');
  const gone = of(targets, 'missing-torrent');
  const parts: string[] = [];
  if (found.length === 1) parts.push(`torrent ${quote(found[0]!.name)}`);
  else if (found.length)
    parts.push(
      `${found.length} torrents: ${quotedList(
        found.map((t) => t.name),
        max,
      )}`,
    );
  if (gone.length)
    parts.push(
      `${gone.length} unknown hash${gone.length > 1 ? 'es' : ''} (${gone.map((t) => t.id.slice(0, 8)).join(', ')})`,
    );
  return parts.join('; ') || 'no torrents';
}

const namesText = (noun: string, plural: string, targets: readonly ResolvedTarget[], kind: string, max: number) => {
  const found = of(targets, kind);
  const gone = of(targets, `missing-${kind}`);
  const head = found.length
    ? `${found.length === 1 ? noun : plural} ${quotedList(
        found.map((t) => t.name),
        max,
      )}`
    : '';
  const tail = gone.length
    ? `unknown ${gone.length === 1 ? noun : plural} ${quotedList(
        gone.map((t) => t.id),
        max,
      )}`
    : '';
  return [head, tail].filter(Boolean).join('; ') || `no ${plural}`;
};

const origins = (targets: readonly ResolvedTarget[], ...kinds: string[]) =>
  of(targets, ...kinds)
    .map((t) => t.name)
    .join(', ');

const bytes = (v: unknown) => (typeof v === 'number' && v > 0 ? `${v} B/s` : 'none');
const shown = (v: unknown) => (v === REDACTED ? REDACTED : typeof v === 'string' ? quote(v) : safe(JSON.stringify(v)));

function shareText(p: Record<string, unknown>): string {
  const parts = [
    `ratio ${safe(p.ratioLimit)}`,
    `seeding time ${safe(p.seedingTimeLimit)} min`,
    `inactive seeding time ${safe(p.inactiveSeedingTimeLimit)} min`,
  ];
  if (p.shareLimitAction !== undefined) parts.push(`then ${safe(p.shareLimitAction)}`);
  return parts.join(', ');
}

/** What happens when a share limit is reached, when the call sets it; removals spelled out. */
function shareActionText(action: unknown): string | undefined {
  if (typeof action !== 'string' || !action) return undefined;
  if (action === 'Remove') return 'removed when its share limit is reached';
  if (action === 'RemoveWithContent') return 'removed with its files when its share limit is reached';
  return `share limit action ${quote(action)}`;
}

function addDetail(p: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof p.category === 'string' && p.category) parts.push(`category ${quote(p.category)}`);
  if (typeof p.tags === 'string' && p.tags) parts.push(`tags ${quote(p.tags)}`);
  if (typeof p.rename === 'string' && p.rename) parts.push(`named ${quote(p.rename)}`);
  if (p.stopped === true) parts.push('stopped');
  if (p.forced === true) parts.push('forced');
  if (p.skip_checking === true) parts.push('without checking existing data');
  const download = p.useDownloadPath === false ? undefined : downloadPathText(p.downloadPath);
  if (download) parts.push(`downloads in ${download}`);
  const share = shareActionText(p.shareLimitAction);
  if (share) parts.push(share);
  return parts.length ? `; ${parts.join(', ')}` : '';
}

function preferencesText(json: unknown, notes: SummaryInput['preferenceNotes']): string {
  if (!isPlainObject(json)) return 'no changes';
  return Object.entries(json)
    .map(([k, v]) => {
      const flags = notes?.(k) ?? [];
      return `${safe(k, 80)}=${shown(v)}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    })
    .join(', ');
}

function ruleText(p: Record<string, unknown>, targets: readonly ResolvedTarget[], destination?: string): string {
  const def = isPlainObject(p.ruleDef) ? p.ruleDef : {};
  const params = isPlainObject(def.torrentParams) ? def.torrentParams : {};
  const category = params.category ?? def.assignedCategory;
  const parts = [`saves to ${destination ?? 'a save path qBittorrent did not report'}`];
  const download = params.use_download_path === false ? undefined : downloadPathText(params.download_path);
  if (download) parts.push(`downloads in ${download}`);
  if (typeof category === 'string' && category) parts.push(`category ${quote(category)}`);
  const share = shareActionText(params.share_limit_action);
  if (share) parts.push(share);
  if (def.enabled === false) parts.push('disabled');
  const feeds = origins(targets, 'feed-url');
  parts.push(feeds ? `from feeds ${feeds}` : 'from no feeds');
  for (const f of ['mustContain', 'mustNotContain', 'episodeFilter'] as const)
    if (typeof def[f] === 'string' && def[f]) parts.push(`${f} ${quote(def[f])}`);
  return parts.join(', ');
}

/** The approval text of a write. */
export function summaryText(s: SummaryInput): string {
  const { key, params: p, targets, host, maxNames: max } = s;
  const head = `${SERVICE} ${key}`;
  const on = (dest: string, detail?: string) => `${head} on ${dest}${detail ? `: ${detail}` : ''}`;
  const torrentsOn = (detail?: string) => on(torrentsText(targets, max), detail);
  const instance = `qBittorrent at ${host}`;
  const base = key.split('#')[0]!;
  switch (base) {
    case 'torrents.stop':
    case 'torrents.start':
    case 'torrents.recheck':
    case 'torrents.reannounce':
    case 'torrents.topPrio':
    case 'torrents.bottomPrio':
      return torrentsOn();
    case 'torrents.setCategory': {
      const move = `torrents in automatic management move to ${s.destination ?? 'a path qBittorrent did not report'}`;
      return torrentsOn(
        typeof p.category === 'string' && p.category
          ? `category ${quote(p.category)}; ${move}`
          : `clear the category; ${move}`,
      );
    }
    case 'torrents.addTags':
    case 'torrents.removeTags':
      return torrentsOn(`${base === 'torrents.addTags' ? 'add' : 'remove'} tags ${quote(p.tags)}`);
    case 'torrents.setDownloadLimit':
    case 'torrents.setUploadLimit':
      return torrentsOn(`${base === 'torrents.setDownloadLimit' ? 'download' : 'upload'} limit ${bytes(p.limit)}`);
    case 'torrents.setShareLimits':
      return torrentsOn(shareText(p));
    case 'torrents.filePrio':
      return torrentsOn(`files ${safe(p.id)} to priority ${safe(p.priority)}`);
    case 'torrents.rename':
      return torrentsOn(`rename to ${quote(p.name)}`);
    case 'torrents.renameFile':
    case 'torrents.renameFolder':
      return torrentsOn(`${quote(p.oldPath)} to ${quote(p.newPath)}`);
    case 'torrents.delete':
      return torrentsOn(
        p.deleteFiles === true ? 'remove, deleting the downloaded files' : 'remove, keep the downloaded files',
      );
    case 'torrents.setLocation':
      return `${head} to ${quote(p.location)} for ${torrentsText(targets, max)}: moves their data; turns off automatic management`;
    case 'torrents.setSavePath':
      return `${head} to ${quote(p.path)} for ${torrentsText(targets, max)}: moves the data of those in manual management`;
    case 'torrents.add': {
      const inner = origins(targets, 'magnet-url');
      return `${head} into ${s.destination ?? 'an unknown save path'} on ${instance}: ${of(targets, 'source').length} source(s): ${origins(targets, 'source')}${inner ? `; magnet trackers, sources, peers and DHT nodes: ${inner}` : ''}${addDetail(p)}`;
    }
    case 'torrents.addTrackers':
      return torrentsOn(`add trackers ${origins(targets, 'new-tracker')}`);
    case 'torrents.editTracker': {
      const changes = [`tracker ${origins(targets, 'tracker', 'missing-tracker') || 'not found'}`];
      if (p.newUrl !== undefined) changes.push(`to ${origins(targets, 'new-tracker')}`);
      if (p.tier !== undefined) changes.push(`tier ${safe(p.tier)}`);
      return torrentsOn(changes.join(' '));
    }
    case 'torrents.removeTrackers':
      return torrentsOn(`remove trackers ${origins(targets, 'tracker', 'missing-tracker')}`);
    case 'torrents.createCategory':
      return on(
        `category ${quote(p.category)}`,
        `create${typeof p.savePath === 'string' && p.savePath ? ` with save path ${quote(p.savePath)}` : ''}`,
      );
    case 'torrents.editCategory': {
      const download = p.downloadPathEnabled === true ? `, download path ${quote(p.downloadPath ?? '')}` : '';
      return on(
        namesText('category', 'categories', targets, 'category', max),
        `save path ${quote(p.savePath)}${download}; its torrents in automatic management move to ${s.destination ?? 'a path qBittorrent did not report'}`,
      );
    }
    case 'torrents.removeCategories':
      return on(namesText('category', 'categories', targets, 'category', max), 'delete');
    case 'torrents.createTags':
      return on(instance, `create tags ${quote(p.tags)}`);
    case 'torrents.deleteTags':
      return on(namesText('tag', 'tags', targets, 'tag', max), 'delete, removing them from every torrent');
    case 'transfer.setDownloadLimit':
    case 'transfer.setUploadLimit':
      return on(
        instance,
        `global ${base === 'transfer.setDownloadLimit' ? 'download' : 'upload'} limit ${bytes(p.limit)}`,
      );
    case 'transfer.toggleSpeedLimitsMode':
      return on(instance, 'switch the alternative speed limits');
    case 'search.stop':
    case 'search.delete':
      return on(`search ${safe(p.id)}`);
    case 'app.setPreferences':
      return on(instance, preferencesText(p.json, s.preferenceNotes));
    case 'app.shutdown':
      return on(instance, 'shut qBittorrent down');
    case 'rss.addFeed':
      return on(instance, `subscribe ${quote(p.path)} to ${origins(targets, 'feed-url')}`);
    case 'rss.setFeedURL':
      return on(namesText('feed', 'feeds', targets, 'rss-item', max), `URL to ${origins(targets, 'feed-url')}`);
    case 'rss.removeItem': {
      const feeds = of(targets, 'rss-folder-feeds')[0]?.name;
      return on(
        namesText('item', 'items', targets, 'rss-item', max),
        feeds === undefined ? 'remove the feed' : `remove the folder and its ${feeds} feed(s)`,
      );
    }
    case 'rss.setRule': {
      const stored = of(targets, 'rss-rule')[0];
      const dest = stored ? `rule ${quote(stored.name)} (replaced)` : `new rule ${quote(p.ruleName)} on ${instance}`;
      return on(dest, `${ruleText(p, targets, s.destination)}; matching articles download without another approval`);
    }
    case 'rss.removeRule':
      return on(namesText('rule', 'rules', targets, 'rss-rule', max), 'delete');
    case 'search.start': {
      const enabled = of(targets, 'search-plugin').map((t) => t.name);
      const disabled = of(targets, 'disabled-search-plugin').map((t) => t.name);
      const gone = of(targets, 'missing-search-plugin').map((t) => t.id);
      const parts = [enabled.length ? `plugins ${quotedList(enabled, max)}` : 'no enabled plugins'];
      if (disabled.length) parts.push(`including disabled: ${quotedList(disabled, max)}`);
      if (gone.length) parts.push(`unknown plugins ${quotedList(gone, max)}`);
      return on(
        instance,
        `search ${quote(p.pattern)} in category ${quote(p.category)} with ${parts.join('; ')} (runs search plugin code)`,
      );
    }
    case 'search.installPlugin':
      return on(
        instance,
        `install search plugins from ${origins(targets, 'source')} (their code runs on later searches)`,
      );
    case 'search.uninstallPlugin':
      return on(namesText('plugin', 'plugins', targets, 'search-plugin', max), 'uninstall');
    case 'search.enablePlugin':
      return on(
        namesText('plugin', 'plugins', targets, 'search-plugin', max),
        p.enable === true ? 'enable' : 'disable',
      );
    case 'search.updatePlugins':
      return on(instance, 'update every search plugin from its source (runs the new code)');
    default:
      return missingOf(targets).length ? on(torrentsText(targets, max)) : on(instance);
  }
}
