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
      case 'pool.dataset.export_key':
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
        // What the key can do comes from the user it acts as, not from its (model-chosen) name.
        return stringOr(field(first(params), 'username')) ?? hostname(key);
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
      const list = Array.isArray(params) ? [...params] : [params];
      // Core also redacts these (`sensitiveParams`); masking here keeps the summary text clean on its own.
      for (const i of POSITIONAL_SECRETS[method] ?? []) if (list[i] !== undefined) list[i] = '[REDACTED]';
      const args = JSON.stringify(maskKeyParams(method, list)).slice(1, -1);
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
      return maskSecrets(method, result);
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

/** Positional params that hold a secret, by method (core can't see a key name for them). */
const POSITIONAL_SECRETS: Record<string, number[]> = {
  'user.setup_local_administrator': [1],
};

/** Methods whose whole result is a secret string (a token, an encryption key, a 2FA seed). */
const SECRET_RESULTS = new Set([
  'auth.generate_token',
  'auth.generate_onetime_password',
  'pool.dataset.export_key',
  'user.provisioning_uri',
]);

/** Which result field holds a secret, by method: the key is too common to add to `sensitiveKeys`. */
function secretField(method: string): string | null {
  if (method.startsWith('kerberos.keytab.')) return 'file';
  if (method.startsWith('api_key.') || method.startsWith('pool.dataset.') || method === 'pool.create') return 'key';
  return null;
}

/**
 * Secrets in results that core can't recognize by key name, because the key is too common to add to
 * `sensitiveKeys` (it would hide ordinary values) or there is no key at all:
 * - keytab rows carry the keytab under `file`;
 * - `api_key.*` returns a new or reset key under `key`, and dataset and pool results an encryption key;
 * - some methods return the secret itself as a bare string (`SECRET_RESULTS`).
 */
function maskSecrets(method: string, result: unknown): unknown {
  // Job records keep each job's arguments and result: mask them by the job's own method, so a secret
  // a call never returned directly can't be read back later through `core.get_jobs`.
  if (method === 'core.get_jobs' && Array.isArray(result)) {
    return result.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const r = row as Record<string, unknown>;
      const m = typeof r.method === 'string' ? r.method : '';
      return {
        ...r,
        ...('result' in r ? { result: maskSecrets(m, r.result) } : {}),
        ...('arguments' in r ? { arguments: maskKeyParams(m, r.arguments) } : {}),
      };
    });
  }
  if (SECRET_RESULTS.has(method)) return typeof result === 'string' && result ? '[REDACTED]' : result;
  // Cloud credentials nest their secret under `key` (in `provider`, `attributes` or an embedded
  // `credentials` object), at any depth: mask every string `key` in these results.
  if (method.startsWith('cloudsync.') || method.startsWith('cloud_backup.')) return maskKeysDeep(result);
  const field = secretField(method);
  if (!field) return result;
  const mask = (row: unknown) =>
    row && typeof row === 'object' && !Array.isArray(row) && typeof (row as Record<string, unknown>)[field] === 'string'
      ? { ...row, [field]: '[REDACTED]' }
      : row;
  return Array.isArray(result) ? result.map(mask) : mask(result);
}

/**
 * Encryption keys passed as params (`encryption_options.key`, `datasets[].key`, `change_key`'s `key`)
 * sit under the common name `key`, which core can't redact by name: masked in summaries and job
 * records here; core also keeps them out of approvals and the audit log through `sensitiveParams`.
 * This also covers the unlock datasets beyond the 32 declared paths, in the summary text.
 */
function maskKeyParams(method: string, value: unknown): unknown {
  const keyed =
    method.startsWith('pool.dataset.') || method === 'pool.create' || method.startsWith('cloudsync.credentials.');
  if (!keyed) return value;
  return maskKeysDeep(value, method === 'pool.dataset.create' || method === 'pool.dataset.update');
}

/** Dataset user properties (`[{ key, value }]`): `key` is the property's name, not a secret. */
const USER_PROPERTY_LISTS = new Set(['user_properties', 'user_properties_update']);

/**
 * Replaces every non-empty string under a `key` property with `[REDACTED]`, on a copy. With
 * `keepPropertyNames` (dataset create/update params only), the `key` of each item in a user property
 * list is kept so the approver sees which property changes; everything else in it is still walked.
 */
function maskKeysDeep(value: unknown, keepPropertyNames = false): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return copy(v as Record<string, unknown>, depth, (k, x) =>
      k === 'key' && typeof x === 'string' && x ? '[REDACTED]' : walk(x, depth + 1),
    );
  };
  const copy = (
    v: Record<string, unknown>,
    depth: number,
    each: (k: string, x: unknown) => unknown,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v))
      Object.defineProperty(out, k, {
        value:
          keepPropertyNames && USER_PROPERTY_LISTS.has(k) && Array.isArray(x)
            ? x.map((item) =>
                item && typeof item === 'object' && !Array.isArray(item)
                  ? copy(item as Record<string, unknown>, depth + 2, (ik, ix) =>
                      ik === 'key' ? ix : walk(ix, depth + 3),
                    )
                  : walk(item, depth + 2),
              )
            : each(k, x),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  };
  return walk(value, 0);
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined;
}
