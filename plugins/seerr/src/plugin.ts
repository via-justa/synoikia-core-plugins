import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import type { InitParams, PluginHandlers } from '@synoikia/plugin-sdk';
import { buildCatalog, CHEAP_JOBS, fillTemplate, LOCKED, matchPath, SpecError, SPLITS, VERBS } from './catalog.js';
import type { Catalog, Verb } from './catalog.js';
import { queryString, SeerrClient } from './client.js';
import type { SeerrAuth } from './client.js';
import { DEFAULT_SPEC_BASE_URL, fetchSpec } from './spec.js';

/**
 * The Seerr plugin's handlers (design §3.3–§3.4, SR design). The sandbox calls
 * `seerr.request({ method, path, query, body })`; the catalog key is the verb plus the OpenAPI path
 * template (`POST /request/{requestId}/{status}`), and params are `{ path, query, body }`.
 */

const MAX_SUMMARY_BODY = 400;
const LOOKUP_TIMEOUT_MS = 10_000;

export interface SeerrParams {
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

const baseKey = (key: string) => key.split('#')[0]!;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const startsScan = (body: unknown) =>
  body !== undefined && (!isPlainObject(body) || (body.start !== undefined && body.start !== false));
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;

export function createSeerrPlugin(): PluginHandlers {
  let client: SeerrClient | undefined;
  let catalog: Catalog | undefined;
  let specBaseUrl = DEFAULT_SPEC_BASE_URL;
  let myUserId: number | undefined;

  const connected = () => {
    if (!client) throw new PluginError(ErrorCodes.Internal, 'init has not been called');
    return client;
  };

  const version = async () => {
    const status = await connected().request('GET', '/status');
    const v = isPlainObject(status) ? str(status.version) : undefined;
    if (!v) throw new PluginError(ErrorCodes.UpstreamError, 'Seerr /status returned no version');
    return v;
  };

  const loadCatalog = async (): Promise<{ catalog: Catalog; ref: string; version: string }> => {
    const v = await version();
    const { text, ref } = await fetchSpec(v, specBaseUrl);
    try {
      catalog = buildCatalog(text);
    } catch (err) {
      if (err instanceof SpecError) throw new PluginError(ErrorCodes.UpstreamError, `${err.message} (${ref})`);
      throw err;
    }
    return { catalog, ref, version: v };
  };
  const currentCatalog = async () => catalog ?? (await loadCatalog()).catalog;

  /** The Seerr user this connection acts as. */
  const me = async (): Promise<number | undefined> => {
    if (myUserId === undefined) {
      const user = await connected().request('GET', '/auth/me', { timeoutMs: LOOKUP_TIMEOUT_MS });
      myUserId = isPlainObject(user) && typeof user.id === 'number' ? user.id : undefined;
    }
    return myUserId;
  };

  const get = async (path: string): Promise<unknown> => {
    try {
      return await connected().request('GET', path, { timeoutMs: LOOKUP_TIMEOUT_MS });
    } catch {
      return undefined;
    }
  };

  /** Whether approving/declining `requestId` acts for another user; unknown counts as yes (fail closed). */
  const onBehalf = async (requestId: string): Promise<boolean> => {
    const request = await get(`/request/${encodeURIComponent(requestId)}`);
    const requester = isPlainObject(request) && isPlainObject(request.requestedBy) ? request.requestedBy.id : undefined;
    let self: number | undefined;
    try {
      self = await me();
    } catch {
      return true;
    }
    return typeof requester !== 'number' || self === undefined || requester !== self;
  };

  const appTitle = async (): Promise<string> => {
    const settings = await get('/settings/public');
    return (isPlainObject(settings) && str(settings.applicationTitle)) || 'Seerr';
  };

  const named = async (listPath: string, id: string | undefined): Promise<string | undefined> => {
    if (!id) return undefined;
    const list = await get(listPath);
    const row = Array.isArray(list) ? list.find((r) => isPlainObject(r) && String(r.id) === id) : undefined;
    return (isPlainObject(row) && (str(row.name) ?? str(row.title))) || id;
  };

  /** The literal an approver must type for each locked operation: the thing it affects (SR §3.4). */
  const confirmLiteral = async (key: string, params: SeerrParams): Promise<string | undefined> => {
    const path = params.path ?? {};
    if (key.endsWith('#on-behalf')) {
      const request = await get(`/request/${encodeURIComponent(path.requestId ?? '')}`);
      const by = isPlainObject(request) && isPlainObject(request.requestedBy) ? request.requestedBy : undefined;
      return (by && (str(by.displayName) ?? str(by.email))) || path.requestId;
    }
    switch (key) {
      case 'DELETE /user/{userId}': {
        const user = await get(`/user/${encodeURIComponent(path.userId ?? '')}`);
        return (isPlainObject(user) && (str(user.email) ?? str(user.displayName))) || path.userId;
      }
      case 'DELETE /settings/radarr/{radarrId}':
        return named('/settings/radarr', path.radarrId);
      case 'DELETE /settings/sonarr/{sonarrId}':
        return named('/settings/sonarr', path.sonarrId);
      case 'DELETE /settings/discover/{sliderId}':
        return named('/settings/discover', path.sliderId);
      default:
        if (key === 'POST /settings/jobs/{jobId}/run#start') return path.jobId;
        return LOCKED.has(key) || key.endsWith('#start') ? appTitle() : undefined;
    }
  };

  return {
    init({ config, secrets }: InitParams) {
      const baseUrl = config.baseUrl;
      if (typeof baseUrl !== 'string' || !baseUrl)
        throw new PluginError(ErrorCodes.InvalidParams, 'baseUrl is required');
      let auth: SeerrAuth;
      if ((config.authMethod ?? 'local') === 'apiKey') {
        if (!secrets.apiKey) throw new PluginError(ErrorCodes.InvalidParams, 'apiKey is required');
        const actAs = Number(config.actAsUserId);
        auth = {
          kind: 'apiKey',
          apiKey: secrets.apiKey,
          ...(Number.isInteger(actAs) && actAs > 0 ? { actAsUserId: actAs } : {}),
        };
      } else {
        if (typeof config.email !== 'string' || !config.email)
          throw new PluginError(ErrorCodes.InvalidParams, 'email is required');
        if (!secrets.password) throw new PluginError(ErrorCodes.InvalidParams, 'password is required');
        auth = { kind: 'local', email: config.email, password: secrets.password };
      }
      client?.close();
      client = new SeerrClient(baseUrl, auth);
      catalog = undefined;
      myUserId = undefined;
      specBaseUrl =
        typeof config.specBaseUrl === 'string' && config.specBaseUrl ? config.specBaseUrl : DEFAULT_SPEC_BASE_URL;
    },

    async testConnection() {
      try {
        // /status is public; /auth/me proves the credentials work.
        await connected().request('GET', '/auth/me', { timeoutMs: 15_000 });
        return { ok: true, upstreamVersion: await version() };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    getUpstreamVersion: version,

    async syncCatalog() {
      const { catalog: c, ref, version: v } = await loadCatalog();
      return { upstreamVersion: v, sourceRef: ref, operations: c.operations };
    },

    async resolveOperation({ fn, args }) {
      if (fn !== 'request') throw new PluginError(ErrorCodes.UnknownOperation, `seerr.${fn} is not a binding function`);
      const [req] = args;
      if (!isPlainObject(req))
        throw new PluginError(
          ErrorCodes.InvalidParams,
          'seerr.request({ method, path, query, body }) takes one object',
        );
      const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
      if (!(VERBS as readonly string[]).includes(method))
        throw new PluginError(ErrorCodes.InvalidParams, `Unsupported HTTP method ${String(req.method)}`);
      if (typeof req.path !== 'string' || !req.path.startsWith('/'))
        throw new PluginError(ErrorCodes.InvalidParams, 'path must be a string starting with /');
      if (req.path.includes('?') || req.path.includes('#'))
        throw new PluginError(ErrorCodes.InvalidParams, 'Pass query parameters in `query`, not in the path');
      if (req.query !== undefined && !isPlainObject(req.query))
        throw new PluginError(ErrorCodes.InvalidParams, 'query must be an object');
      const match = matchPath(await currentCatalog(), method, req.path);
      if (!match)
        throw new PluginError(ErrorCodes.UnknownOperation, `${method} ${req.path} is not a Seerr API operation`);
      const params: SeerrParams = {
        ...(Object.keys(match.pathParams).length ? { path: match.pathParams } : {}),
        ...(req.query && Object.keys(req.query).length ? { query: req.query } : {}),
        ...(req.body !== undefined && method !== 'GET' ? { body: req.body } : {}),
      };
      // Seerr treats a missing is4k as false. Saying so explicitly lets a media-request rule on
      // "4K: no" match the call; the request Seerr receives means the same thing.
      if (match.op.key === 'POST /request' && isPlainObject(params.body) && params.body.is4k === undefined)
        params.body = { ...params.body, is4k: false };
      let key = match.op.key;
      const split = SPLITS[key];
      if (split === '#on-behalf' && (await onBehalf(match.pathParams.requestId!))) key += split;
      // Seerr starts the scan on any truthy `start`, so only a body that clearly doesn't ask for one
      // (none, or `start` absent or exactly false) keeps the ordinary key.
      if (split === '#start' && key === 'POST /settings/jobs/{jobId}/run') {
        if (!CHEAP_JOBS.has(match.pathParams.jobId!)) key += split;
      } else if (split === '#start' && startsScan(req.body)) key += split;
      return { key, params };
    },

    async summarize({ key, params }) {
      const p = (isPlainObject(params) ? params : {}) as SeerrParams;
      const [method, template] = baseKey(key).split(' ') as [string, string];
      let path = template;
      try {
        path = fillTemplate(template, p.path ?? {});
      } catch {
        // keep the template
      }
      const body = p.body === undefined ? '' : JSON.stringify(p.body);
      const text = `Seerr ${method} ${path}${queryString(p.query)}${
        body ? ` ${body.length > MAX_SUMMARY_BODY ? `${body.slice(0, MAX_SUMMARY_BODY)}…` : body}` : ''
      }${key.endsWith('#on-behalf') ? " (another user's request)" : ''}${key.endsWith('#start') ? ' (starts a full library scan or another heavy job)' : ''}`;
      const literal = await confirmLiteral(key, p);
      return literal ? { text, confirmLiteral: literal } : { text };
    },

    async invoke({ key, params, context }) {
      const p = (isPlainObject(params) ? params : {}) as SeerrParams;
      const [method, template] = baseKey(key).split(' ') as [Verb, string];
      const known = await currentCatalog();
      if (!known.byVerb.get(method)?.some((op) => op.template === template))
        throw new PluginError(ErrorCodes.UnknownOperation, `${baseKey(key)} is not a Seerr API operation`);
      let path: string;
      try {
        path = fillTemplate(template, p.path ?? {});
      } catch (err) {
        throw new PluginError(ErrorCodes.InvalidParams, (err as Error).message);
      }
      return connected().request(method, path, {
        query: p.query,
        body: p.body,
        timeoutMs: Math.max(1000, context.deadlineMs),
      });
    },

    shutdown() {
      client?.close();
    },
  };
}
