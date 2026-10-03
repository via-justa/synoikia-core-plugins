import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import type { InitParams, PluginHandlers } from '@synoikia/plugin-sdk';
import { buildCatalog, isLocked, needsPoolRootKey, POOL_ROOT_SPLIT, POOL_ROOT_SUFFIX } from './catalog.js';
import type { Catalog, MethodInfo } from './catalog.js';
import { TrueNasClient } from './client.js';

/**
 * The TrueNAS plugin's handlers (design §3.3–§3.4, TN design). The sandbox calls
 * `truenas.call(method, ...params)`; params stay positional, exactly as TrueNAS takes them.
 */

const MAX_SUMMARY_PARAMS = 400;

const baseMethod = (key: string) => key.split('#')[0]!;

const first = (params: unknown): unknown => (Array.isArray(params) ? params[0] : undefined);
const field = (value: unknown, name: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined;

export function createTrueNasPlugin(): PluginHandlers {
  let client: TrueNasClient | undefined;
  let catalog: Catalog | undefined;

  const connected = () => {
    if (!client) throw new PluginError(ErrorCodes.Internal, 'init has not been called');
    return client;
  };

  const loadCatalog = async (): Promise<Catalog> => {
    catalog = buildCatalog((await connected().call('core.get_methods')) as Record<string, MethodInfo>);
    return catalog;
  };

  /** Looks up a readable name for a typed confirmation; falls back to the raw value. */
  const lookup = async (method: string, id: unknown, key: string): Promise<string | undefined> => {
    if (id === undefined || id === null) return undefined;
    try {
      const row = await connected().call(method, [id], 10_000);
      const name = field(row, key);
      if (typeof name === 'string' && name) return name;
    } catch {
      // fall through to the raw value
    }
    return String(id);
  };

  /** The literal an approver must type for each locked operation (TN §3.4): the thing it destroys. */
  const confirmLiteral = async (key: string, params: unknown): Promise<string | undefined> => {
    if (key.endsWith(POOL_ROOT_SUFFIX)) return stringOr(field(first(params), 'path'));
    switch (key) {
      case 'pool.dataset.delete':
      case 'pool.dataset.change_key':
      case 'disk.wipe':
      case 'app.delete':
      case 'docker.delete_backup':
      case 'user.renew_2fa_secret':
      case 'user.setup_local_administrator':
        return stringOr(first(params));
      case 'pool.export':
        return lookup('pool.get_instance', first(params), 'name');
      case 'user.delete':
        return lookup('user.get_instance', first(params), 'username');
      case 'user.set_password':
        return stringOr(field(first(params), 'username'));
      case 'api_key.create':
        return stringOr(field(first(params), 'name')) ?? hostname(key);
      case 'api_key.update':
      case 'api_key.delete':
        return lookup('api_key.get_instance', first(params), 'name');
      default:
        // Every other locked method (reboot, shutdown, config reset, the rest of api_key.*, …)
        // confirms against the system it acts on.
        return isLocked(key) ? hostname(key) : undefined;
    }
  };

  /** The system's hostname, or `fallback` if it can't be read. */
  const hostname = async (fallback: string): Promise<string> => {
    try {
      const host = field(await connected().call('system.info', [], 10_000), 'hostname');
      if (typeof host === 'string' && host) return host;
    } catch {
      // fall through
    }
    return fallback;
  };

  return {
    init({ config, secrets }: InitParams) {
      const baseUrl = config.baseUrl;
      const apiKey = secrets.apiKey;
      if (typeof baseUrl !== 'string' || !baseUrl)
        throw new PluginError(ErrorCodes.InvalidParams, 'baseUrl is required');
      if (!apiKey) throw new PluginError(ErrorCodes.InvalidParams, 'apiKey is required');
      client?.close();
      catalog = undefined;
      client = new TrueNasClient({ baseUrl, apiKey, verifyTls: config.verifyTls !== false });
    },

    async testConnection() {
      try {
        const version = await connected().call('system.version', [], 15_000);
        return { ok: true, upstreamVersion: String(version) };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    async getUpstreamVersion() {
      return String(await connected().call('system.version'));
    },

    async syncCatalog() {
      const version = String(await connected().call('system.version'));
      const { operations } = await loadCatalog();
      return { upstreamVersion: version, operations };
    },

    async resolveOperation({ fn, args }) {
      if (fn !== 'call') throw new PluginError(ErrorCodes.UnknownOperation, `truenas.${fn} is not a binding function`);
      const [method, ...params] = args;
      if (typeof method !== 'string' || !method)
        throw new PluginError(ErrorCodes.InvalidParams, 'truenas.call(method, ...params): method must be a string');
      const known = catalog ?? (await loadCatalog());
      if (!known.methods.has(method))
        throw new PluginError(ErrorCodes.UnknownOperation, `${method} is not a TrueNAS method on this system`);
      const split =
        (POOL_ROOT_SPLIT as readonly string[]).includes(method) && needsPoolRootKey(field(params[0], 'path'));
      return { key: split ? `${method}${POOL_ROOT_SUFFIX}` : method, params };
    },

    async summarize({ key, params }) {
      const method = baseMethod(key);
      const args = JSON.stringify(Array.isArray(params) ? params : [params]).slice(1, -1);
      const text = `TrueNAS ${method}(${args.length > MAX_SUMMARY_PARAMS ? `${args.slice(0, MAX_SUMMARY_PARAMS)}…` : args})${
        key.endsWith(POOL_ROOT_SUFFIX) ? ' at the root of a pool' : ''
      }`;
      const literal = await confirmLiteral(key, params);
      return literal ? { text, confirmLiteral: literal } : { text };
    },

    async invoke({ key, params, context }) {
      const method = baseMethod(key);
      const args = Array.isArray(params) ? params : params === undefined ? [] : [params];
      const known = catalog ?? (await loadCatalog());
      const timeout = Math.max(1000, context.deadlineMs);
      const result = known.jobs.has(method)
        ? await connected().callJob(method, args, timeout)
        : await connected().call(method, args, timeout);
      return method.startsWith('kerberos.keytab.') ? maskKeytabs(result) : result;
    },

    async optionsFor({ source, query }) {
      if (source !== 'installed-apps')
        throw new PluginError(ErrorCodes.InvalidParams, `Unknown options source ${source}`);
      const apps = (await connected().call('app.query')) as { name?: unknown }[];
      const q = query?.toLowerCase() ?? '';
      return apps
        .map((a) => a.name)
        .filter((n): n is string => typeof n === 'string' && n.toLowerCase().includes(q))
        .sort()
        .map((name) => ({ value: name, label: name }));
    },

    shutdown() {
      client?.close();
    },
  };
}

/**
 * Keytab rows carry the keytab itself under `file`. Core redacts by key name, and `file` is too
 * common to add to `sensitiveKeys` (it would hide ordinary paths), so it is masked here.
 */
function maskKeytabs(result: unknown): unknown {
  const mask = (row: unknown) =>
    row && typeof row === 'object' && !Array.isArray(row) && (row as Record<string, unknown>).file
      ? { ...row, file: '[REDACTED]' }
      : row;
  return Array.isArray(result) ? result.map(mask) : mask(result);
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined;
}
