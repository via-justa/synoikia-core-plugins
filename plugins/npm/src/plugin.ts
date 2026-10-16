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
import { NpmSession } from './auth.js';
import { requireLockedKeys } from './locked-keys.js';

/** The Nginx Proxy Manager plugin: catalog from the OpenAPI spec the instance serves at `/api/schema`, keyed by
 * the spec's paths under `/api`; the sandbox calls `npm.request({ method, path, query, body })`. */

const SERVICE = 'Nginx Proxy Manager';

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
    return { specPath: text('specPath'), versionPath: text('versionPath'), minOperations: p.minOperations };
  },
});

/** The first path parameter: the literal for a locked operation plugin.yaml gives none (a newer DELETE). */
function pathId({ params }: { params: unknown }): string | undefined {
  const path = isPlainObject(params) && isPlainObject(params.path) ? params.path : {};
  return Object.values(path).map(stringOr).find(Boolean);
}

/** plugin.yaml's rules, without upstream lookups. */
export const policy = compileRules(settings, { custom: { 'path-id': pathId } });

export function buildCatalog(spec: string | Record<string, unknown>, rules: CompiledRules<unknown> = policy) {
  const catalog = buildOpenApiCatalog(spec, { service: SERVICE, rules, minOperations: settings.plugin.minOperations });
  requireLockedKeys(SERVICE, settings.rules, catalog.operations);
  return catalog;
}

/** A model-written string as one visible line: control, bidi and zero-width characters escaped. */
function safe(value: unknown): string | undefined {
  const text = stringOr(value);
  if (text === undefined) return undefined;
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

export const ADVANCED_NOTE = '(injects raw nginx config)';

/** Where a host or stream body sends traffic, spelled out for the approver even when the body summary is cut. */
export function destinations(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const target = (scheme: unknown, host: unknown, port: unknown) =>
    `${safe(scheme) ? `${safe(scheme)}://` : ''}${safe(host) ?? '?'}${safe(port) ? `:${safe(port)}` : ''}`;
  const parts: string[] = [];
  if (Array.isArray(body.domain_names))
    parts.push(`domains ${body.domain_names.map((d) => safe(d) ?? '?').join(', ')}`);
  if (body.incoming_port !== undefined) parts.push(`port ${safe(body.incoming_port) ?? '?'}`);
  if (body.forward_host !== undefined)
    parts.push(`→ ${target(body.forward_scheme, body.forward_host, body.forward_port)}`);
  if (body.forwarding_host !== undefined)
    parts.push(`→ ${target(undefined, body.forwarding_host, body.forwarding_port)}`);
  if (body.forward_domain_name !== undefined)
    parts.push(`redirects to ${target(body.forward_scheme, body.forward_domain_name, undefined)}`);
  if (Array.isArray(body.locations))
    for (const loc of body.locations.filter(isPlainObject))
      parts.push(
        `location ${safe(loc.path) ?? '?'} → ${target(loc.forward_scheme, loc.forward_host, loc.forward_port)}`,
      );
  return parts.length ? `[${parts.join('; ')}]` : undefined;
}

/** Raw nginx config in a host body, top level or in a custom location. */
export function hasAdvancedConfig(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  const raw = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  return (
    raw(body.advanced_config) ||
    (Array.isArray(body.locations) && body.locations.some((l) => isPlainObject(l) && raw(l.advanced_config)))
  );
}

export function createNpmPlugin(): PluginHandlers {
  return definePlugin({
    connect: (init) => {
      const session = new NpmSession(init);
      const client: HttpJsonClient = new HttpJsonClient({
        baseUrl: joinApiPath(requireString(init.config, 'baseUrl'), '/api'),
        service: SERVICE,
        verifyTls: init.config.verifyTls !== false,
        timeoutMs: settings.defaults.timeouts.request,
        ...session.options(() => client),
      });
      return client;
    },

    async version(kit) {
      const health = await kit.client().request('GET', settings.plugin.versionPath);
      const v = isPlainObject(health) && isPlainObject(health.version) ? health.version : undefined;
      const parts = v ? [v.major, v.minor, v.revision].map(stringOr) : [];
      if (parts.length !== 3 || parts.some((p) => p === undefined))
        throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      return parts.join('.');
    },
    // The version endpoint is public; this one proves the email and password work.
    probe: async (kit) => void (await kit.client().request('GET', '/users/me')),

    handlers(kit) {
      const rules = compileRules(settings, { lookup: restLookup(kit.client), custom: { 'path-id': pathId } });
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
        namespace: 'npm',
        service: SERVICE,
        rules,
        catalog: catalog.get,
        client: kit.client,
        stripPrefix: '/api',
        splitWhen: { advanced: (call) => hasAdvancedConfig(call.params.body) },
      });
      return {
        async syncCatalog() {
          const upstreamVersion = await kit.version();
          return { upstreamVersion, operations: (await catalog.reload()).operations };
        },
        resolveOperation: binding.resolveOperation,
        async summarize(params) {
          const summary = await binding.summarize(params);
          const body = isPlainObject(params.params) ? params.params.body : undefined;
          const notes = [hasAdvancedConfig(body) ? ADVANCED_NOTE : undefined, destinations(body)].filter(Boolean);
          return notes.length ? { ...summary, text: `${summary.text} ${notes.join(' ')}` } : summary;
        },
        invoke: (params) => binding.invoke(params),
      };
    },
  });
}
