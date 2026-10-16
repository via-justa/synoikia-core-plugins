import { buildOpenApiCatalog, compileRules, isPlainObject, parsePluginSettings, stringOr } from '@synoikia/plugin-sdk';
import type { CompiledRules, ConfirmContext, RestCall, RuleHooks } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { lockedKeys, requireLockedKeys } from './locks.js';
import { parseSpecSource } from './spec.js';

/** Prowlarr's catalog: the SDK's OpenAPI catalog over the spec for the instance's release, with plugin.yaml's rules
 * on top; keys are the spec's paths, `/api/v1` included. */

export const SERVICE = 'Prowlarr';

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

/** When a call takes its locked twin (plugin.yaml `split`); anything unexpected takes the twin. */
export const splitWhen: Record<string, (call: RestCall) => boolean> = {
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

const BULK_NOUNS: Record<string, string> = {
  indexer: 'indexer',
  applications: 'application',
  downloadclient: 'download client',
};

/** Named confirmation sources plugin.yaml uses. */
export const custom: NonNullable<RuleHooks['custom']> = {
  // The first path id: the literal for a locked operation plugin.yaml gives none (a newer DELETE).
  'path-id': ({ params }: ConfirmContext) => {
    const path = isPlainObject(params) && isPlainObject(params.path) ? params.path : {};
    return Object.values(path).map(stringOr).find(Boolean);
  },
  // How many providers a bulk call touches: `3 indexers`, `1 application`, `2 download clients`.
  count: ({ key, params }: ConfirmContext) => {
    const b = body(params);
    if (!isPlainObject(b) || !Array.isArray(b.ids)) return undefined;
    const resource = /\/(indexer|applications|downloadclient)\/bulk/.exec(key)?.[1] ?? '';
    const n = b.ids.length;
    return `${n} ${BULK_NOUNS[resource] ?? 'item'}${n === 1 ? '' : 's'}`;
  },
  // The command name, only when it is a plain word (it is what Prowlarr runs, and the approver sees it in the body).
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
