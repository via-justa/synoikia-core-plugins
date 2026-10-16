import {
  buildOpenApiCatalog,
  compileRules,
  definePlugin,
  ErrorCodes,
  fillTemplate,
  HttpJsonClient,
  isPlainObject,
  parsePluginSettings,
  PluginError,
  requireString,
  restBinding,
} from '@synoikia/plugin-sdk';
import type { CompiledRules, InitParams, Lazy, OpenApiCatalog, PluginHandlers, RuleHooks } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { authHeaders } from './auth.js';
import { lockedKeys, requireLockedKeys } from './locks.js';
import { normalizeRequest } from './request.js';
import { loadSpec } from './spec.js';
import type { LoadedSpec } from './spec.js';
import { withFields, withTargets } from './summary.js';
import { resolveTargets } from './targets.js';

/** The Grafana Cloud plugin: the grafana.com API (`https://grafana.com/api`), catalog from the spec grafana.com
 * publishes, keyed by its paths under `/api`; the sandbox calls `grafanacloud.request({ method, path, query, body })`. */

const SERVICE = 'Grafana Cloud';

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const spec = isPlainObject(p.spec) ? p.spec : {};
    const url = (v: unknown, name: string) => {
      if (typeof v !== 'string' || !/^https:\/\/[^/]/.test(v))
        throw new Error(`plugin.yaml plugin.${name} must be an https URL`);
      return v;
    };
    const positive = (v: unknown, name: string) => {
      if (typeof v !== 'number' || v < 1) throw new Error(`plugin.yaml plugin.${name} must be a positive number`);
      return v;
    };
    if (!Array.isArray(spec.urls) || !spec.urls.length) throw new Error('plugin.yaml plugin.spec.urls must be a list');
    if (!Array.isArray(p.canonicalKeys) || !p.canonicalKeys.every((k) => typeof k === 'string' && /^\w+$/.test(k)))
      throw new Error('plugin.yaml plugin.canonicalKeys must be a list of keys');
    if (!Array.isArray(p.summaryFields) || !p.summaryFields.every((f) => typeof f === 'string' && f.startsWith('/')))
      throw new Error('plugin.yaml plugin.summaryFields must be a list of JSON pointers');
    return {
      apiUrl: url(p.apiUrl, 'apiUrl'),
      spec: {
        urls: spec.urls.map((u: unknown) => url(u, 'spec.urls')),
        maxBytes: positive(spec.maxBytes, 'spec.maxBytes'),
        timeoutMs: positive(spec.timeoutMs, 'spec.timeoutMs'),
      },
      summaryFields: p.summaryFields as string[],
      canonicalKeys: [
        ...(p.canonicalKeys as string[]),
        ...(p.summaryFields as string[]).map((f) => f.slice(1).split('/')[0]!),
      ],
      minOperations: positive(p.minOperations, 'minOperations'),
    };
  },
});

/** Rules whose `custom: org` source is the connection's org slug, the literal for a locked operation
 * plugin.yaml gives none. */
const rulesFor = (org: () => string | undefined, lookup?: RuleHooks['lookup']) =>
  compileRules(settings, { ...(lookup ? { lookup } : {}), custom: { org } });

/** plugin.yaml's rules, without upstream lookups or a connection. */
export const policy = rulesFor(() => undefined);

const LOCKED_KEYS = lockedKeys(settings.rules);

export function buildCatalog(spec: string | Record<string, unknown>, rules: CompiledRules<unknown> = policy) {
  const catalog = buildOpenApiCatalog(spec, { service: SERVICE, rules, minOperations: settings.plugin.minOperations });
  requireLockedKeys(catalog.operations, LOCKED_KEYS, SERVICE);
  return catalog;
}

/** A connection URL override: https, or http only to this machine (a local mirror or test double). */
function urlField(config: Record<string, unknown>, name: string): string | undefined {
  const v = config[name];
  if (v === undefined || v === '') return undefined;
  let url: URL;
  try {
    url = new URL(String(v));
  } catch {
    throw new PluginError(ErrorCodes.InvalidParams, `${name} must be a URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new PluginError(ErrorCodes.InvalidParams, `${name} must use https`);
  return String(v);
}

interface Connection {
  api: HttpJsonClient;
  org: string;
  specUrls: string[];
}

function connect(init: InitParams): Connection {
  const org = requireString(init.config, 'org');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(org))
    throw new PluginError(ErrorCodes.InvalidParams, 'org must be an organization slug (lowercase letters, digits, -)');
  const specUrl = urlField(init.config, 'specUrl');
  return {
    api: new HttpJsonClient({
      baseUrl: urlField(init.config, 'apiUrl') ?? settings.plugin.apiUrl,
      service: SERVICE,
      headers: authHeaders(init),
      timeoutMs: settings.defaults.timeouts.request,
    }),
    org,
    specUrls: specUrl ? [specUrl] : settings.plugin.spec.urls,
  };
}

/** A GET for confirmation lookups: `args[0]` fills the path, `args[1]` is the query (the `region` that access
 * policies and tokens need). */
export function cloudLookup(client: () => HttpJsonClient) {
  return async (op: string, args: unknown[], timeoutMs: number) => {
    const [method, template] = op.split(' ');
    if (method !== 'GET' || !template?.startsWith('/'))
      throw new PluginError(ErrorCodes.InvalidParams, `plugin.yaml lookup ${op}: only GET /path lookups are allowed`);
    const query = isPlainObject(args[1]) ? args[1] : undefined;
    return client().request('GET', fillTemplate(template, isPlainObject(args[0]) ? args[0] : {}), {
      timeoutMs,
      ...(query ? { query } : {}),
    });
  };
}

export function createGrafanaCloudPlugin(): PluginHandlers {
  let current: Lazy<LoadedSpec<OpenApiCatalog>> | undefined;
  return definePlugin<Connection>({
    connect,

    // The spec's `info.version`: grafana.com has no version endpoint.
    async version() {
      if (!current) throw new PluginError(ErrorCodes.Internal, 'handlers are not ready');
      return (await current.get()).version;
    },
    // The org proves the token works and belongs to it.
    probe: async (kit) => {
      const { api, org } = kit.client();
      await api.request('GET', `/orgs/${encodeURIComponent(org)}`);
    },

    handlers(kit) {
      const api = () => kit.client().api;
      const rules = rulesFor(() => kit.client().org, cloudLookup(api));
      current = kit.lazy(() =>
        loadSpec(kit.client().specUrls, (spec) => buildCatalog(spec, rules), {
          service: SERVICE,
          maxBytes: settings.plugin.spec.maxBytes,
          timeoutMs: settings.plugin.spec.timeoutMs,
        }),
      );
      const loaded = current;
      const binding = restBinding({
        namespace: 'grafanacloud',
        service: SERVICE,
        rules,
        catalog: async () => (await loaded.get()).catalog,
        client: api,
        stripPrefix: '/api',
        maxSummaryBody: 1000,
        adjust: ({ params }) => normalizeRequest(params, settings.plugin.canonicalKeys),
      });
      return {
        async syncCatalog() {
          const { catalog, source, version } = await loaded.reload();
          return { upstreamVersion: version, sourceRef: source, operations: catalog.operations };
        },
        resolveOperation: binding.resolveOperation,
        resolveTargets: ({ key, params }) => resolveTargets(api(), key, params, settings.defaults.timeouts.lookup),
        async summarize(params) {
          const summary = await binding.summarize(params);
          const text = withFields(summary.text, SERVICE, params.key, params.params, settings.plugin.summaryFields);
          return { ...summary, text: withTargets(text, params.targets) };
        },
        invoke: (params) => binding.invoke(params),
      };
    },
  });
}
