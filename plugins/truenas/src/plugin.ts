import {
  compileRules,
  definePlugin,
  ErrorCodes,
  isPlainObject,
  PluginError,
  requireString,
  truncate,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import { buildCatalog, needsPoolRootKey, POOL_ROOT, POOL_ROOT_SUFFIX, policy, settings } from './catalog.js';
import type { MethodInfo } from './catalog.js';
import { TrueNasClient } from './client.js';

/** TrueNAS handlers (design §3.3–§3.4): `truenas.call(method, ...params)`, params positional as TrueNAS
 * takes them; locks, literals and secrets are in plugin.yaml. */

const MAX_SUMMARY_PARAMS = 400;

const baseMethod = (key: string) => key.split('#')[0]!;

export function createTrueNasPlugin(): PluginHandlers {
  return definePlugin({
    connect: ({ config, secrets }) =>
      new TrueNasClient(
        {
          baseUrl: requireString(config, 'baseUrl'),
          apiKey: requireString(secrets, 'apiKey'),
          verifyTls: config.verifyTls !== false,
        },
        { timeoutMs: settings.defaults.timeouts.request, jobPollMs: settings.plugin.jobPollMs },
      ),
    close: (client) => client.close(),
    version: async (kit) => String(await kit.client().call('system.version', [], 15_000)),

    handlers(kit) {
      const rules = compileRules(settings, {
        lookup: (method, args, timeoutMs) => kit.client().call(method, args, timeoutMs),
      });
      const catalog = kit.lazy(async () =>
        buildCatalog((await kit.client().call('core.get_methods')) as Record<string, MethodInfo>),
      );
      /** Positional params plugin.yaml marks sensitive, by method. Core redacts them too; this keeps summaries clean on their own. */
      const positionalSecrets = (method: string): number[] =>
        policy
          .decorate({ key: method, kind: 'method', group: 'x' })
          .sensitiveParams?.filter((p) => /^\/\d+$/.test(p))
          .map((p) => Number(p.slice(1))) ?? [];

      /** Core masks each method's own result; job records embed other methods' results and arguments, so each
       * is masked here by the job's own method. */
      const maskJobs = (result: unknown): unknown => {
        // Query options reshape the answer (`get` returns one record, `count` a number, `select`
        // drops or renames fields), so this fails closed on any shape it doesn't know.
        if (Array.isArray(result)) return result.map(maskJobRow);
        if (isPlainObject(result)) return maskJobRow(result);
        return typeof result === 'number' ? result : REDACTED;
      };
      const maskJobRow = (row: unknown): unknown => {
        if (!isPlainObject(row)) return REDACTED;
        const m = typeof row.method === 'string' && row.method ? row.method : undefined;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          let shown: unknown;
          // Without its method a record's result and arguments can't be attributed: only fields
          // that never carry them stay.
          if (!m) shown = JOB_FIELDS_UNATTRIBUTED.has(k) ? v : REDACTED;
          else if (k === 'result') shown = maskEmbedded(m, v);
          else if (k === 'arguments') shown = maskKeyParams(m, v);
          // Anything else, an alias from `select` included, is hidden.
          else shown = JOB_FIELDS.has(k) ? v : REDACTED;
          Object.defineProperty(out, k, { value: shown, enumerable: true, writable: true, configurable: true });
        }
        return out;
      };
      const maskEmbedded = (method: string, result: unknown): unknown =>
        method === 'core.get_jobs' ? maskJobs(result) : rules.maskEmbeddedResult(method, result);

      return {
        async syncCatalog() {
          const upstreamVersion = await kit.version();
          return { upstreamVersion, operations: (await catalog.reload()).operations };
        },

        async resolveOperation({ fn, args }) {
          if (fn !== 'call')
            throw new PluginError(ErrorCodes.UnknownOperation, `truenas.${fn} is not a binding function`);
          const [method, ...params] = args;
          if (typeof method !== 'string' || !method)
            throw new PluginError(ErrorCodes.InvalidParams, 'truenas.call(method, ...params): method must be a string');
          if (!(await catalog.get()).methods.has(method))
            throw new PluginError(ErrorCodes.UnknownOperation, `${method} is not a TrueNAS method on this system`);
          const path = isPlainObject(params[0]) ? params[0].path : undefined;
          const split = rules.splits(method).includes(POOL_ROOT) && needsPoolRootKey(path);
          return { key: split ? `${method}${POOL_ROOT_SUFFIX}` : method, params };
        },

        async summarize({ key, params, targets }) {
          const method = baseMethod(key);
          const list = Array.isArray(params) ? [...params] : [params];
          for (const i of positionalSecrets(method)) if (list[i] !== undefined) list[i] = '[REDACTED]';
          const args = JSON.stringify(maskKeyParams(method, list)).slice(1, -1);
          const notes = rules
            .summaryNotes(key)
            .map((n) => ` ${n}`)
            .join('');
          const text = `TrueNAS ${method}(${truncate(args, MAX_SUMMARY_PARAMS)})${notes}`;
          const literal = await rules.confirmLiteral({ key, params, targets });
          return literal ? { text, confirmLiteral: literal } : { text };
        },

        async invoke({ key, params, context }) {
          const method = baseMethod(key);
          const args = Array.isArray(params) ? params : params === undefined ? [] : [params];
          const known = await catalog.get();
          const timeout = kit.timeout(context);
          const result = known.jobs.has(method)
            ? await kit.client().callJob(method, args, timeout)
            : await kit.client().call(method, args, timeout);
          return method === 'core.get_jobs' ? maskJobs(result) : result;
        },

        async optionsFor({ source, query }) {
          if (source !== 'installed-apps')
            throw new PluginError(ErrorCodes.InvalidParams, `Unknown options source ${source}`);
          const apps = (await kit.client().call('app.query')) as { name?: unknown }[];
          const q = query?.toLowerCase() ?? '';
          return apps
            .map((a) => a.name)
            .filter((n): n is string => typeof n === 'string' && n.toLowerCase().includes(q))
            .sort()
            .map((name) => ({ value: name, label: name }));
        },
      };
    },
  });
}

/** Encryption keys passed as params sit under the common name `key`: masked in summaries and job records
 * here; `sensitiveParams` keeps them out of approvals and the audit log. */
function maskKeyParams(method: string, value: unknown): unknown {
  const keyed =
    method.startsWith('pool.dataset.') || method === 'pool.create' || method.startsWith('cloudsync.credentials.');
  if (!keyed) return value;
  return maskKeysDeep(value, method === 'pool.dataset.create' || method === 'pool.dataset.update');
}

const REDACTED = '[REDACTED]';

/** Job record fields shown as they are; `result` and `arguments` are masked by the job's method. */
const JOB_FIELDS = new Set([
  'id',
  'method',
  'transient',
  'description',
  'abortable',
  'logs_path',
  'logs_excerpt',
  'progress',
  'result_encoding_error',
  'error',
  'exception',
  'exc_info',
  'state',
  'time_started',
  'time_finished',
  'credentials',
  'message_ids',
]);

/** What a job record without its method may show: nothing that can carry its arguments or result. */
const JOB_FIELDS_UNATTRIBUTED = new Set(['id', 'state', 'abortable', 'transient', 'time_started', 'time_finished']);

/** Dataset user properties (`[{ key, value }]`): `key` is the property's name, not a secret. */
const USER_PROPERTY_LISTS = new Set(['user_properties', 'user_properties_update']);

/** Replaces non-empty strings under `key` with `[REDACTED]` on a copy; `keepPropertyNames` keeps user
 * property names in dataset create/update params. */
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
