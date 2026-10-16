import {
  buildOpenApiCatalog,
  compileRules,
  isPlainObject,
  parsePluginSettings,
  SpecError,
  stringOr,
} from '@synoikia/plugin-sdk';
import type { CompiledRules, ConfirmContext, OpenApiCatalog, RestCall, RuleHooks } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { requiredKeys, requireLockedKeys } from './locks.js';
import { parseSpecSource, pmsOnly } from './spec.js';

/** Plex's catalog: the SDK's OpenAPI catalog over the PMS operations of the pinned community spec, with
 * plugin.yaml's rules on top; keys are the spec's paths (`PUT /:/scrobble`). */

export const SERVICE = 'Plex';

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
    const keys = (key: string) => {
      const v = p[key];
      if (!Array.isArray(v) || !v.every((c) => typeof c === 'string' && /^\w+$/.test(c)))
        throw new Error(`plugin.yaml plugin.${key} must be a list of keys`);
      return v as string[];
    };
    return {
      spec: parseSpecSource(p.spec),
      versionPath: text('versionPath'),
      versionField: text('versionField'),
      minOperations: p.minOperations,
      canonicalKeys: keys('canonicalKeys'),
      refreshFlags: keys('refreshFlags'),
    };
  },
});

/** Set and not plainly false: a flag the upstream reads as true (`true`, `"true"`, `1`) takes the locked twin. */
const flagOn = (v: unknown) => v !== undefined && v !== null && v !== false && v !== 'false' && v !== 0 && v !== '0';

/** When a call takes its locked twin (plugin.yaml `split`). */
export const splitWhen: Record<string, (call: RestCall) => boolean> = {
  refresh: (call) => settings.plugin.refreshFlags.some((flag) => flagOn(call.params.query?.[flag])),
  own: (call) => flagOn(call.params.query?.own),
};

export type Get = (path: string) => Promise<unknown>;

const section = (value: unknown, key: string) => (isPlainObject(value) && isPlainObject(value[key]) ? value[key] : {});

/** The `Metadata` rows of a MediaContainer response. */
export function metadataRows(response: unknown): Record<string, unknown>[] {
  const rows = section(response, 'MediaContainer').Metadata;
  return Array.isArray(rows) ? rows.filter(isPlainObject) : [];
}

/** Named confirmation sources plugin.yaml uses; `get` reads from the PMS (absent without a connection). */
export function customSources(get?: Get): NonNullable<RuleHooks['custom']> {
  return {
    // The first path id: the literal for a locked operation plugin.yaml gives none (a newer DELETE).
    'path-id': ({ params }: ConfirmContext) => Object.values(section(params, 'path')).map(stringOr).find(Boolean),
    // `{ids}` takes a comma-separated list: more than one item confirms on the count.
    'item-count': ({ params }: ConfirmContext) => {
      const ids = stringOr(section(params, 'path').ids)?.split(',');
      return ids && ids.length > 1 ? `${ids.length} items` : undefined;
    },
    // What the session plays, from the live session list.
    session: async ({ params }: ConfirmContext) => {
      const id = stringOr(section(params, 'query').sessionId);
      if (!get || !id) return undefined;
      let sessions: unknown;
      try {
        sessions = await get('/status/sessions');
      } catch {
        return undefined;
      }
      const row = metadataRows(sessions).find((m) => stringOr(section(m, 'Session').id) === id);
      return row ? stringOr(row.title) : undefined;
    },
  };
}

/** plugin.yaml's rules, without upstream lookups. */
export const policy = compileRules(settings, { custom: customSources() });

const REQUIRED_KEYS = requiredKeys(settings.rules);

// The SDK skips paths with characters outside [A-Za-z0-9_-./{}], and Plex keeps actions under a `:` segment
// (`/:/scrobble`, `/:/prefs`): those paths are built under a placeholder segment and restored after.
const COLON = '-colon-';
const restore = (text: string) =>
  text
    .split('/')
    .map((s) => (s === COLON ? ':' : s))
    .join('/');

function withPlaceholders(doc: Record<string, unknown>): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(isPlainObject(doc.paths) ? doc.paths : {})) {
    const segments = path.split('/');
    if (segments.includes(COLON)) throw new SpecError(`The ${SERVICE} API spec has a path with a ${COLON} segment`);
    const key = segments.map((s) => (s === ':' ? COLON : s)).join('/');
    Object.defineProperty(paths, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return { ...doc, paths };
}

export function buildCatalog(
  spec: string | Record<string, unknown>,
  rules: CompiledRules<unknown> = policy,
): OpenApiCatalog {
  const view: CompiledRules<unknown> = {
    ...rules,
    excluded: (key) => rules.excluded(restore(key)),
    describe: (draft) => rules.describe({ ...draft, key: restore(draft.key) }),
  };
  const catalog = buildOpenApiCatalog(withPlaceholders(pmsOnly(spec, SERVICE)), {
    service: SERVICE,
    rules: view,
    minOperations: settings.plugin.minOperations,
  });
  for (const ops of catalog.byVerb.values())
    for (const op of ops) {
      op.key = restore(op.key);
      op.template = restore(op.template);
      op.segments = op.segments.map((s) => (s === COLON ? ':' : s));
    }
  requireLockedKeys(catalog.operations, REQUIRED_KEYS, SERVICE);
  return catalog;
}
