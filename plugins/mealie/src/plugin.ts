import {
  buildOpenApiCatalog,
  compileRules,
  definePlugin,
  ErrorCodes,
  HttpJsonClient,
  isPlainObject,
  joinApiPath,
  parsePluginSettings,
  PluginError,
  requireString,
  restBinding,
  restLookup,
  SpecError,
  stringOr,
} from '@synoikia/plugin-sdk';
import type { CompiledRules, PluginHandlers } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { authHeaders } from './auth.js';
import { requireLockedKeys } from './locked-keys.js';

/** The Mealie plugin: catalog from the OpenAPI spec the instance serves, keyed by the spec's own `/api/…`
 * paths; the sandbox calls `mealie.request({ method, path, query, body })`. */

const SERVICE = 'Mealie';

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
    return {
      specPath: text('specPath'),
      versionPath: text('versionPath'),
      versionField: text('versionField'),
      minOperations: p.minOperations,
    };
  },
});

/** plugin.yaml's rules, without upstream lookups. */
export const policy = compileRules(settings);

export function buildCatalog(spec: string | Record<string, unknown>, rules: CompiledRules<unknown> = policy) {
  const catalog = buildOpenApiCatalog(spec, { service: SERVICE, rules, minOperations: settings.plugin.minOperations });
  requireLockedKeys(SERVICE, settings.rules, catalog.operations);
  return catalog;
}

export function createMealiePlugin(): PluginHandlers {
  return definePlugin({
    connect: (init) =>
      new HttpJsonClient({
        baseUrl: joinApiPath(requireString(init.config, 'baseUrl'), ''),
        service: SERVICE,
        verifyTls: init.config.verifyTls !== false,
        headers: authHeaders(init),
        timeoutMs: settings.defaults.timeouts.request,
      }),

    async version(kit) {
      const about = await kit.client().request('GET', settings.plugin.versionPath);
      const version = isPlainObject(about) ? stringOr(about[settings.plugin.versionField]) : undefined;
      if (!version) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      return version;
    },
    // The version endpoint is public; this one proves the token works.
    probe: async (kit) => void (await kit.client().request('GET', '/api/users/self')),

    handlers(kit) {
      const rules = compileRules(settings, { lookup: restLookup(kit.client) });
      const catalog = kit.lazy(async () => {
        const spec = await kit.client().request('GET', settings.plugin.specPath);
        if (typeof spec !== 'string' && !isPlainObject(spec))
          throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} served no OpenAPI spec`);
        try {
          return buildCatalog(spec, rules);
        } catch (err) {
          if (err instanceof SpecError) throw new PluginError(ErrorCodes.UpstreamError, err.message);
          throw err;
        }
      });
      const binding = restBinding({
        namespace: 'mealie',
        service: SERVICE,
        rules,
        catalog: catalog.get,
        client: kit.client,
      });
      return {
        async syncCatalog() {
          const upstreamVersion = await kit.version();
          return { upstreamVersion, operations: (await catalog.reload()).operations };
        },
        resolveOperation: binding.resolveOperation,
        summarize: binding.summarize,
        invoke: (params) => binding.invoke(params),
      };
    },
  });
}
