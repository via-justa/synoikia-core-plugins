import {
  compileRules,
  definePlugin,
  ErrorCodes,
  isPlainObject,
  PluginError,
  requireString,
  restBinding,
  restLookup,
  SpecError,
  stringOr,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers, RestCall } from '@synoikia/plugin-sdk';
import { buildCatalog, CHEAP_JOBS, settings } from './catalog.js';
import { SeerrClient } from './client.js';
import type { SeerrAuth } from './client.js';
import { DEFAULT_SPEC_BASE_URL, fetchSpec } from './spec.js';

/**
 * The Seerr plugin's handlers (design §3.3–§3.4, SR design). The sandbox calls
 * `seerr.request({ method, path, query, body })`; the catalog key is the verb plus the OpenAPI path
 * template (`POST /request/{requestId}/{status}`), and params are `{ path, query, body }`. Locks,
 * splits and confirmation literals are in plugin.yaml.
 */

export interface SeerrParams {
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

const LOOKUP_TIMEOUT_MS = settings.defaults.timeouts.lookup;

/** Seerr starts a scan on any truthy `start`, so only a body that clearly doesn't ask for one keeps the ordinary key. */
const startsScan = (body: unknown) =>
  body !== undefined && (!isPlainObject(body) || (body.start !== undefined && body.start !== false));

function connect(config: Record<string, unknown>, secrets: Record<string, string>) {
  const baseUrl = requireString(config, 'baseUrl');
  let auth: SeerrAuth;
  if ((config.authMethod ?? 'local') === 'apiKey') {
    const actAs = Number(config.actAsUserId);
    auth = {
      kind: 'apiKey',
      apiKey: requireString(secrets, 'apiKey'),
      ...(Number.isInteger(actAs) && actAs > 0 ? { actAsUserId: actAs } : {}),
    };
  } else {
    auth = { kind: 'local', email: requireString(config, 'email'), password: requireString(secrets, 'password') };
  }
  const specBaseUrl =
    typeof config.specBaseUrl === 'string' && config.specBaseUrl ? config.specBaseUrl : DEFAULT_SPEC_BASE_URL;
  return { client: new SeerrClient(baseUrl, auth), specBaseUrl };
}

export function createSeerrPlugin(): PluginHandlers {
  return definePlugin({
    connect: ({ config, secrets }) => connect(config, secrets),
    close: ({ client }) => client.close(),

    async version(kit) {
      const status = await kit.client().client.request('GET', '/status');
      const v = isPlainObject(status) ? stringOr(status.version) : undefined;
      if (!v) throw new PluginError(ErrorCodes.UpstreamError, 'Seerr /status returned no version');
      return v;
    },
    // /status is public; /auth/me proves the credentials work.
    probe: async (kit) => void (await kit.client().client.request('GET', '/auth/me', { timeoutMs: 15_000 })),

    handlers(kit) {
      const http = () => kit.client().client.http;
      const rules = compileRules(settings, { lookup: restLookup(http) });

      const loadCatalog = async () => {
        const version = await kit.version();
        const { text, ref } = await fetchSpec(version, kit.client().specBaseUrl);
        try {
          return { catalog: buildCatalog(text, rules), ref, version };
        } catch (err) {
          if (err instanceof SpecError) throw new PluginError(ErrorCodes.UpstreamError, `${err.message} (${ref})`);
          throw err;
        }
      };
      const current = kit.lazy(loadCatalog);

      /** The Seerr user this connection acts as. */
      const me = kit.lazy(async () => {
        const user = await http().request('GET', '/auth/me', { timeoutMs: LOOKUP_TIMEOUT_MS });
        return isPlainObject(user) && typeof user.id === 'number' ? user.id : undefined;
      });

      /** Whether approving/declining a request acts for another user; unknown counts as yes (fail closed). */
      const onBehalf = async (call: RestCall): Promise<boolean> => {
        const requestId = call.params.path?.requestId ?? '';
        let request: unknown;
        try {
          request = await http().request('GET', `/request/${encodeURIComponent(requestId)}`, {
            timeoutMs: LOOKUP_TIMEOUT_MS,
          });
        } catch {
          request = undefined;
        }
        const requester =
          isPlainObject(request) && isPlainObject(request.requestedBy) ? request.requestedBy.id : undefined;
        let self: number | undefined;
        try {
          self = await me.get();
        } catch {
          return true;
        }
        return typeof requester !== 'number' || self === undefined || requester !== self;
      };

      const binding = restBinding({
        namespace: 'seerr',
        service: 'Seerr',
        rules,
        catalog: async () => (await current.get()).catalog,
        client: http,
        stripPrefix: '/api/v1',
        // Seerr treats a missing is4k as false. Saying so explicitly lets a media-request rule on "4K: no"
        // match the call; the request Seerr receives means the same thing.
        adjust: ({ key, params }) =>
          key === 'POST /request' && isPlainObject(params.body) && params.body.is4k === undefined
            ? { ...params, body: { ...params.body, is4k: false } }
            : params,
        splitWhen: {
          'on-behalf': onBehalf,
          start: (call) =>
            call.key === 'POST /settings/jobs/{jobId}/run'
              ? !CHEAP_JOBS.has(call.params.path?.jobId ?? '')
              : startsScan(call.request.body),
        },
      });

      return {
        async syncCatalog() {
          const { catalog, ref, version } = await current.reload();
          return { upstreamVersion: version, sourceRef: ref, operations: catalog.operations };
        },
        resolveOperation: binding.resolveOperation,
        summarize: binding.summarize,
        invoke: (params) => binding.invoke(params),
      };
    },
  });
}
