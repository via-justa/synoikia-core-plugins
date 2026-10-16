import { buildOpenApiCatalog, compileRules, isPlainObject, parsePluginSettings, stringOr } from '@synoikia/plugin-sdk';
import type { CompiledRules, ConfirmContext, RestCall, RuleHooks } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { lockedKeys, requireLockedKeys } from './locks.js';
import { parseSpecSource } from './spec.js';

/** Sonarr's catalog: the SDK's OpenAPI catalog over the spec for the instance's release, with plugin.yaml's rules
 * on top; keys are the spec's paths, `/api/v3` included. */

export const SERVICE = 'Sonarr';

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const text = (key: string) => {
      const v = p[key];
      if (typeof v !== 'string' || !v) throw new Error(`plugin.yaml plugin.${key} must be a string`);
      return v;
    };
    if (typeof p.minOperations !== 'number' || p.minOperations < 1)
      throw new Error('plugin.yaml plugin.minOperations must be a positive number');
    if (!Array.isArray(p.quickCommands) || !p.quickCommands.every((c) => typeof c === 'string' && /^\w+$/.test(c)))
      throw new Error('plugin.yaml plugin.quickCommands must be a list of command names');
    if (!Array.isArray(p.canonicalKeys) || !p.canonicalKeys.every((c) => typeof c === 'string' && /^\w+$/.test(c)))
      throw new Error('plugin.yaml plugin.canonicalKeys must be a list of keys');
    return {
      spec: parseSpecSource(p.spec),
      versionPath: text('versionPath'),
      versionField: text('versionField'),
      minOperations: p.minOperations,
      quickCommands: new Set((p.quickCommands as string[]).map((c) => c.toLowerCase())),
      canonicalKeys: p.canonicalKeys as string[],
    };
  },
});

const body = (params: unknown) => (isPlainObject(params) ? params.body : undefined);

/** Set and not plainly false: a flag the upstream reads as true (`true`, `"true"`, `1`) takes the locked twin. */
const flagOn = (v: unknown) => v !== undefined && v !== null && v !== false && v !== 'false' && v !== 0 && v !== '0';

/** When a call takes its locked twin (plugin.yaml `split`); anything unexpected takes the twin. */
export const splitWhen: Record<string, (call: RestCall) => boolean> = {
  'delete-files': (call) =>
    call.key === 'DELETE /api/v3/series/{id}'
      ? flagOn(call.params.query?.deleteFiles)
      : !isPlainObject(call.params.body) || flagOn(call.params.body.deleteFiles),
  'move-files': (call) => flagOn(call.params.query?.moveFiles),
  heavy: (call) => {
    const name = isPlainObject(call.params.body) ? call.params.body.name : undefined;
    return typeof name !== 'string' || !settings.plugin.quickCommands.has(name.toLowerCase());
  },
  // Servarr fills stored secrets into a test or action for any `id` > 0.
  stored: (call) => {
    const id = isPlainObject(call.params.body) ? call.params.body.id : undefined;
    return !(id === undefined || id === null || (typeof id === 'number' && id <= 0));
  },
};

/** Named confirmation sources plugin.yaml uses. */
export const custom: NonNullable<RuleHooks['custom']> = {
  // The first path id: the literal for a locked operation plugin.yaml gives none (a newer DELETE).
  'path-id': ({ params }: ConfirmContext) => {
    const path = isPlainObject(params) && isPlainObject(params.path) ? params.path : {};
    return Object.values(path).map(stringOr).find(Boolean);
  },
  // How many items a bulk call touches: `3 series` (editor, season pass), `12 items`.
  count: ({ params }: ConfirmContext) => {
    const b = body(params);
    if (!isPlainObject(b)) return undefined;
    const series = [b.seriesIds, b.series].find(Array.isArray);
    if (series) return `${series.length} series`;
    const ids = [b.ids, b.episodeFileIds].find(Array.isArray);
    return ids ? `${ids.length} item${ids.length === 1 ? '' : 's'}` : undefined;
  },
  // The command name, only when it is a plain word (it is what Sonarr runs, and the approver sees it in the body).
  command: ({ params }: ConfirmContext) => {
    const b = body(params);
    const name = isPlainObject(b) ? b.name : undefined;
    return typeof name === 'string' && /^\w{1,64}$/.test(name) ? name : undefined;
  },
};

/** plugin.yaml's rules, without upstream lookups. */
export const policy = compileRules(settings, { custom });

const LOCKED_KEYS = lockedKeys(settings.rules);

export function buildCatalog(spec: string | Record<string, unknown>, rules: CompiledRules<unknown> = policy) {
  const catalog = buildOpenApiCatalog(spec, { service: SERVICE, rules, minOperations: settings.plugin.minOperations });
  requireLockedKeys(catalog.operations, LOCKED_KEYS, SERVICE);
  return catalog;
}
