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
import { lockedKeys, requireLockedKeys } from './locks.js';
import { databaseTargets, withTargets } from './targets.js';

/** The Profilarr plugin: catalog from the OpenAPI spec the instance serves, keyed by the spec's paths under
 * `/api/v1`; the sandbox calls `profilarr.request({ method, path, query, body })`. */

const SERVICE = 'Profilarr';

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
      apiPath: text('apiPath'),
      specPath: text('specPath'),
      versionPath: text('versionPath'),
      versionField: text('versionField'),
      minOperations: p.minOperations,
    };
  },
});

/** plugin.yaml's rules, without upstream lookups. */
export const policy = compileRules(settings);

const LOCKED_KEYS = lockedKeys(settings.rules);

export function buildCatalog(spec: string | Record<string, unknown>, rules: CompiledRules<unknown> = policy) {
  const catalog = buildOpenApiCatalog(spec, { service: SERVICE, rules, minOperations: settings.plugin.minOperations });
  requireLockedKeys(catalog.operations, LOCKED_KEYS, SERVICE);
  return catalog;
}

export function createProfilarrPlugin(): PluginHandlers {
  return definePlugin({
    connect: (init) =>
      new HttpJsonClient({
        baseUrl: joinApiPath(requireString(init.config, 'baseUrl'), settings.plugin.apiPath),
        service: SERVICE,
        verifyTls: init.config.verifyTls !== false,
        headers: authHeaders(init),
        timeoutMs: settings.defaults.timeouts.request,
      }),

    // /status needs the API key (only /health is public), so it also proves the key.
    async version(kit) {
      const status = await kit.client().request('GET', settings.plugin.versionPath);
      const version = isPlainObject(status) ? stringOr(status[settings.plugin.versionField]) : undefined;
      if (!version) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      return version;
    },

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
        namespace: 'profilarr',
        service: SERVICE,
        rules,
        catalog: catalog.get,
        client: kit.client,
        stripPrefix: settings.plugin.apiPath,
      });
      return {
        async syncCatalog() {
          const upstreamVersion = await kit.version();
          return { upstreamVersion, operations: (await catalog.reload()).operations };
        },
        resolveOperation: binding.resolveOperation,
        resolveTargets: ({ key, params }) =>
          databaseTargets(kit.client(), key, params, settings.defaults.timeouts.lookup),
        async summarize(params) {
          const summary = await binding.summarize(params);
          return { ...summary, text: withTargets(summary.text, params.targets) };
        },
        invoke: (params) => binding.invoke(params),
      };
    },
  });
}
