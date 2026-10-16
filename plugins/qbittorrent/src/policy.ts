import type { CompiledRules, PluginSettings } from '@synoikia/plugin-sdk';

/** Operations that must stay locked whatever plugin.yaml says: they delete data, fetch or move files, run code or
 * change the instance. A plugin.yaml edit that drops one stops the plugin from loading. */
export const REQUIRED_LOCKS = [
  'torrents.delete',
  'torrents.delete#with-files',
  'torrents.add',
  'torrents.setLocation',
  'torrents.setSavePath',
  'torrents.editCategory',
  'torrents.createCategory#paths',
  'torrents.removeCategories',
  'torrents.deleteTags',
  'torrents.addTrackers',
  'torrents.editTracker',
  'torrents.removeTrackers',
  'torrents.setShareLimits#remove',
  'torrents.stop#all',
  'torrents.setCategory#all',
  'app.setPreferences',
  'app.shutdown',
  'rss.addFeed',
  'rss.setFeedURL',
  'rss.removeItem',
  'rss.setRule',
  'rss.removeRule',
  'search.start',
  'search.installPlugin',
  'search.uninstallPlugin',
  'search.enablePlugin',
  'search.updatePlugins',
] as const;

/** Refuses settings where a rule names an operation that does not exist (a typo would silently drop a lock), a
 * required lock is missing, or an operation's request does not fit its classification. */
export function checkPolicy(settings: PluginSettings<unknown>, rules: CompiledRules<unknown>): void {
  const ops = new Map(settings.operations.map((op) => [op.key, op]));
  const known = new Set(
    settings.operations.flatMap((op) => [op.key, ...rules.splits(op.key).map((s) => `${op.key}#${s}`)]),
  );
  const problems: string[] = [];
  for (const rule of settings.rules)
    for (const key of Array.isArray(rule.match) ? rule.match : [rule.match])
      if (!key.includes('*') && !known.has(key)) problems.push(`a rule names ${key}, which is not declared`);
  for (const key of REQUIRED_LOCKS)
    if (!known.has(key) || !rules.isLocked(key)) problems.push(`${key} must be declared and locked`);
  for (const op of settings.operations) {
    if (!op.http) problems.push(`${op.key} declares no request`);
    else if (op.classification === 'read' && op.http.method !== 'GET')
      problems.push(`${op.key} reads with ${op.http.method}`);
    else if (op.classification === 'write' && (op.http.method !== 'POST' || op.http.body === 'json'))
      problems.push(`${op.key} must POST a form`);
  }
  if (!ops.size) problems.push('no operations');
  if (problems.length) throw new Error(`plugin.yaml: ${problems.join('; ')}`);
}
