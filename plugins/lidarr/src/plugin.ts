import {
  compileRules,
  definePlugin,
  ErrorCodes,
  HttpJsonClient,
  isPlainObject,
  joinApiPath,
  PluginError,
  requireString,
  restBinding,
  restLookup,
  SpecError,
  stringOr,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import { authHeaders } from './auth.js';
import { buildCatalog, custom, SERVICE, settings, splitWhen } from './catalog.js';
import { cutLinksDeep, maskProviderFields, redactKeysDeep, refuseMaskedValues } from './fields.js';
import { normalizeRequest } from './request.js';
import { fetchServarrSpec } from './spec.js';
import { resolveTargets, withTargets } from './targets.js';

/** The Lidarr plugin: catalog from the OpenAPI spec of the instance's release, keyed by the spec's paths
 * (`/api/v1/...`); the sandbox calls `lidarr.request({ method, path, query, body })`. */

// Release and history links carry the indexer's API key or the tracker passkey; matched in any case.
const LINK_KEYS = ['downloadUrl', 'magnetUrl', 'url'];
// Link-shaped guids, info and comment links (history `nzbInfoUrl` too) are cut to their origin.
const ORIGIN_KEYS = ['guid', 'infoUrl', 'commentUrl', 'nzbInfoUrl'];

export function createLidarrPlugin(): PluginHandlers {
  return definePlugin({
    connect: (init) => {
      const specBaseUrl = stringOr(init.config.specBaseUrl) ?? settings.plugin.spec.baseUrl;
      const http = new HttpJsonClient({
        baseUrl: joinApiPath(requireString(init.config, 'baseUrl'), ''),
        service: SERVICE,
        verifyTls: init.config.verifyTls !== false,
        headers: authHeaders(init),
        timeoutMs: settings.defaults.timeouts.request,
      });
      return { http, specBaseUrl };
    },

    // /system/status needs the API key, so it also proves it.
    async version(kit) {
      const status = await kit.client().http.request('GET', settings.plugin.versionPath);
      const version = isPlainObject(status) ? stringOr(status[settings.plugin.versionField]) : undefined;
      if (!version) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      return version;
    },

    handlers(kit) {
      const http = () => kit.client().http;
      const rules = compileRules(settings, { lookup: restLookup(http), custom });
      const current = kit.lazy(async () => {
        const version = await kit.version();
        const { text, ref } = await fetchServarrSpec(SERVICE, settings.plugin.spec, version, kit.client().specBaseUrl);
        try {
          return { catalog: buildCatalog(text, rules), ref, version };
        } catch (err) {
          if (err instanceof SpecError) throw new PluginError(ErrorCodes.UpstreamError, `${err.message} (${ref})`);
          throw err;
        }
      });
      const binding = restBinding({
        namespace: 'lidarr',
        service: SERVICE,
        rules,
        catalog: async () => (await current.get()).catalog,
        client: http,
        adjust: ({ params }) => {
          const normalized = normalizeRequest(params, settings.plugin.canonicalKeys);
          refuseMaskedValues(normalized.body);
          return normalized;
        },
        splitWhen,
      });
      return {
        async syncCatalog() {
          const { catalog, ref, version } = await current.reload();
          return { upstreamVersion: version, sourceRef: ref, operations: catalog.operations };
        },
        resolveOperation: binding.resolveOperation,
        resolveTargets: ({ key, params }) => resolveTargets(http(), key, params, settings.defaults.timeouts.lookup),
        async summarize(params) {
          const summary = await binding.summarize(params);
          return { ...summary, text: withTargets(summary.text, params.targets) };
        },
        async invoke(params) {
          // Provider fields wherever they appear; release and history links.
          const result = maskProviderFields(await binding.invoke(params));
          if (!/ \/api\/v1\/(release|history)/.test(params.key)) return result;
          return cutLinksDeep(redactKeysDeep(result, LINK_KEYS), ORIGIN_KEYS);
        },
      };
    },
  });
}
