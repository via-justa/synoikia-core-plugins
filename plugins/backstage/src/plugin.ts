import {
  buildOpenApiCatalog,
  compileRules,
  definePlugin,
  ErrorCodes,
  HttpJsonClient,
  isPlainObject,
  parsePluginSettings,
  PluginError,
  requireString,
  restBinding,
  restLookup,
  SpecError,
} from '@synoikia/plugin-sdk';
import type { CompiledRules, PluginHandlers } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { authHeaders } from './auth.js';
import { lockedKeys, requireLockedKeys } from './locks.js';
import { loadSpecs, mergeSpecs, pluginIdsOf, specVersion } from './spec.js';
import type { PluginSpec } from './spec.js';
import { backstageTargets, withTargets } from './targets.js';

/** The Backstage plugin: catalog from the OpenAPI specs the backend plugins serve, merged and keyed by the
 * full served path (`GET /api/catalog/entities`); the sandbox calls `backstage.request({ method, path, … })`. */

const SERVICE = 'Backstage';

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const ids = p.defaultPluginIds;
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string'))
      throw new Error('plugin.yaml plugin.defaultPluginIds must be a list of strings');
    if (typeof p.specPath !== 'string' || !p.specPath.startsWith('/'))
      throw new Error('plugin.yaml plugin.specPath must be a path');
    if (typeof p.minOperations !== 'number' || p.minOperations < 1)
      throw new Error('plugin.yaml plugin.minOperations must be a positive number');
    return { defaultPluginIds: ids as string[], specPath: p.specPath, minOperations: p.minOperations };
  },
});

/** plugin.yaml's rules, without upstream lookups. */
export const policy = compileRules(settings);

const LOCKED_KEYS = lockedKeys(settings.rules);

/** The merged catalog; each loaded plugin must keep the keys plugin.yaml locks under its own path. */
export function buildCatalog(specs: readonly PluginSpec[], rules: CompiledRules<unknown> = policy) {
  const merged = mergeSpecs(specs, SERVICE);
  const catalog = buildOpenApiCatalog(merged, {
    service: SERVICE,
    rules,
    minOperations: settings.plugin.minOperations,
  });
  const loaded = specs.map((s) => `/api/${s.id}/`);
  const locked = LOCKED_KEYS.filter((key) => loaded.some((prefix) => key.split(' ')[1]!.startsWith(prefix)));
  requireLockedKeys(catalog.operations, locked, SERVICE);
  return { catalog, version: specVersion(merged) };
}

export function createBackstagePlugin(): PluginHandlers {
  return definePlugin({
    connect: (init) => {
      pluginIdsOf(init.config, settings.plugin.defaultPluginIds);
      return new HttpJsonClient({
        baseUrl: requireString(init.config, 'baseUrl'),
        service: SERVICE,
        verifyTls: init.config.verifyTls !== false,
        headers: authHeaders(init),
        timeoutMs: settings.defaults.timeouts.request,
      });
    },

    // No version endpoint: the first loaded spec's info.version. Loading needs the token, so it also proves it.
    async version(kit) {
      return (await discover(kit.client(), kit.init().config)).version;
    },

    handlers(kit) {
      const rules = compileRules(settings, { lookup: restLookup(kit.client) });
      const catalog = kit.lazy(() => discover(kit.client(), kit.init().config, rules));
      const binding = restBinding({
        namespace: 'backstage',
        service: SERVICE,
        rules,
        catalog: async () => (await catalog.get()).catalog,
        client: kit.client,
      });
      return {
        async syncCatalog() {
          const { catalog: current, version } = await catalog.reload();
          return { upstreamVersion: version, operations: current.operations };
        },
        resolveOperation: binding.resolveOperation,
        resolveTargets: ({ key, params }) =>
          backstageTargets(kit.client(), key, params, settings.defaults.timeouts.lookup),
        async summarize(params) {
          const summary = await binding.summarize(params);
          return { ...summary, text: withTargets(summary.text, params.key, params.targets) };
        },
        invoke: (params) => binding.invoke(params),
      };
    },
  });
}

async function discover(client: HttpJsonClient, config: Record<string, unknown>, rules?: CompiledRules<unknown>) {
  const ids = pluginIdsOf(config, settings.plugin.defaultPluginIds);
  const specs = await loadSpecs(client, ids, settings.plugin.specPath, SERVICE);
  try {
    return buildCatalog(specs, rules);
  } catch (err) {
    if (err instanceof SpecError) throw new PluginError(ErrorCodes.UpstreamError, err.message);
    throw err;
  }
}
