import {
  compileRules,
  definePlugin,
  ErrorCodes,
  HttpJsonClient,
  joinApiPath,
  PluginError,
  readPointer,
  requireString,
  restBinding,
  restLookup,
  SpecError,
  stringOr,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import { authHeaders } from './auth.js';
import { buildCatalog, customSources, SERVICE, settings, splitWhen } from './catalog.js';
import { maskTokens } from './mask.js';
import { normalizeRequest } from './request.js';
import { fetchPlexSpec } from './spec.js';
import { resolveTargets, withTargets } from './targets.js';

/** The Plex plugin: catalog from the PMS operations of the pinned community spec, keyed by its paths; the sandbox
 * calls `plex.request({ method, path, query, body })`. */

export function createPlexPlugin(): PluginHandlers {
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

    // `GET /` needs the token, so it also proves it.
    async version(kit) {
      const info = await kit.client().http.request('GET', settings.plugin.versionPath);
      const version = stringOr(readPointer(info, settings.plugin.versionField));
      if (!version) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      return version;
    },

    handlers(kit) {
      const http = () => kit.client().http;
      const get = (path: string) => http().request('GET', path, { timeoutMs: settings.defaults.timeouts.lookup });
      const rules = compileRules(settings, { lookup: restLookup(http), custom: customSources(get) });
      const current = kit.lazy(async () => {
        const version = await kit.version();
        const { text, ref } = await fetchPlexSpec(SERVICE, settings.plugin.spec, kit.client().specBaseUrl);
        try {
          return { catalog: buildCatalog(text, rules), ref, version };
        } catch (err) {
          if (err instanceof SpecError) throw new PluginError(ErrorCodes.UpstreamError, `${err.message} (${ref})`);
          throw err;
        }
      });
      const binding = restBinding({
        namespace: 'plex',
        service: SERVICE,
        rules,
        catalog: async () => (await current.get()).catalog,
        client: http,
        adjust: ({ params }) => normalizeRequest(params, settings.plugin.canonicalKeys),
        splitWhen,
      });
      return {
        async syncCatalog() {
          const { catalog, ref, version } = await current.reload();
          return { upstreamVersion: version, sourceRef: ref, operations: catalog.operations };
        },
        resolveOperation: binding.resolveOperation,
        async resolveTargets({ key, params }) {
          const op = (await current.get()).catalog.operations.find((o) => o.key === key);
          return op?.classification === 'read' ? [] : resolveTargets(get, key, params);
        },
        async summarize(params) {
          const summary = await binding.summarize(params);
          return { ...summary, text: withTargets(summary.text, params.targets) };
        },
        async invoke(params) {
          return maskTokens(await binding.invoke(params));
        },
      };
    },
  });
}
