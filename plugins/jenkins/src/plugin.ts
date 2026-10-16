import {
  baseKey,
  compileRules,
  definePlugin,
  ErrorCodes,
  HttpJsonClient,
  isPlainObject,
  joinApiPath,
  parseBaseUrl,
  parsePluginSettings,
  PluginError,
  queryString,
  REDACTED,
  requireString,
  staticCatalog,
  staticHttpBinding,
  stringOr,
  truncate,
} from '@synoikia/plugin-sdk';
import type { ConfirmContext, PluginHandlers, ResolvedTarget, StaticOperation } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { authHeaders } from './auth.js';
import {
  checkStatus,
  checkTriggerParameters,
  isSecretParameter,
  jenkinsTargets,
  jobInfo,
  queueIdOf,
  send,
  SERVICE,
} from './jenkins.js';
import type { JobInfo } from './jenkins.js';
import { readLog } from './log.js';
import { maskEmbeddedCredentials, maskParameterSecrets, maskUrlCredentials } from './mask.js';
import { fillPath } from './paths.js';
import { checkDepth, checkTree } from './tree.js';

/** The Jenkins plugin: a fixed set of operations declared in plugin.yaml over the remote access API; the
 * sandbox calls `jenkins.call(operation, { path, query })`. */

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const positive = (v: unknown, name: string) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
        throw new Error(`plugin.yaml plugin.${name} must be a positive integer`);
      return v;
    };
    const trees = isPlainObject(p.trees) ? p.trees : undefined;
    if (!trees || !Object.values(trees).every((t) => typeof t === 'string' && t.trim()))
      throw new Error('plugin.yaml plugin.trees must map operation keys to tree filters');
    if (!Array.isArray(p.permalinks) || !p.permalinks.every((l) => typeof l === 'string' && /^[a-zA-Z]+$/.test(l)))
      throw new Error('plugin.yaml plugin.permalinks must be a list of names');
    const log = isPlainObject(p.log) ? p.log : {};
    return {
      trees: Object.fromEntries(Object.entries(trees).map(([k, t]) => [k, String(t).replace(/\s+/g, '')])),
      permalinks: p.permalinks as string[],
      log: {
        defaultBytes: positive(log.defaultBytes, 'log.defaultBytes'),
        maxBytes: positive(log.maxBytes, 'log.maxBytes'),
        maxLines: positive(log.maxLines, 'log.maxLines'),
      },
      minMajor: positive(p.minMajor, 'minMajor'),
    };
  },
});

type HttpOperation = StaticOperation & { http: NonNullable<StaticOperation['http']> };

const OPERATIONS = new Map(
  settings.operations.flatMap((op): [string, HttpOperation][] => (op.http ? [[op.key, { ...op, http: op.http }]] : [])),
);
const TRIGGER = 'builds.trigger';
const LOG = 'builds.log';

/** The declared operation of a key or its split twin (`builds.trigger#params`). */
function operation(key: string): HttpOperation {
  const op = OPERATIONS.get(baseKey(key));
  if (!op) throw new PluginError(ErrorCodes.UnknownOperation, `${key} is not a ${SERVICE} operation`);
  return op;
}

const pathOf = (params: unknown) => (isPlainObject(params) && isPlainObject(params.path) ? params.path : {});
const queryOf = (params: unknown) => (isPlainObject(params) && isPlainObject(params.query) ? params.query : {});

/** The request path of a call: reads may name a build by permalink, writes only by number. */
const requestPath = (op: HttpOperation, params: unknown) =>
  fillPath(op.http.path, pathOf(params), op.classification === 'read' ? settings.plugin.permalinks : []);

/** Refuses query keys the operation's schema doesn't list (`additionalProperties: false`), a query on an
 * operation without one, and anything but plain values. */
function checkQuery(op: HttpOperation, query: Record<string, unknown>) {
  const keys = Object.keys(query);
  if (!keys.length) return;
  const props = op.paramsSchema?.properties;
  const schema = isPlainObject(props) ? props.query : undefined;
  if (!isPlainObject(schema)) throw new PluginError(ErrorCodes.InvalidParams, `${op.key} takes no query`);
  const known = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
  const unknown = schema.additionalProperties === false ? keys.find((k) => !known.includes(k)) : undefined;
  if (unknown !== undefined)
    throw new PluginError(
      ErrorCodes.InvalidParams,
      `${op.key} takes no query.${truncate(unknown, 80)}${known.length ? `; it takes ${known.join(', ')}` : ''}`,
    );
  // Stapler binds names case-sensitively, but a near-duplicate could still slip a value past the checks here.
  const folded = new Set(keys.map((k) => k.toLowerCase()));
  if (folded.size !== keys.length)
    throw new PluginError(ErrorCodes.InvalidParams, `${op.key}: query keys must not differ only by case`);
  for (const [k, v] of Object.entries(query))
    if (!['string', 'number', 'boolean'].includes(typeof v))
      throw new PluginError(ErrorCodes.InvalidParams, `query.${truncate(k, 80)} must be a string, number or boolean`);
  if (op.classification !== 'read') return;
  if (query.tree !== undefined) {
    const defaults = settings.plugin.trees[op.key];
    if (!defaults) throw new PluginError(ErrorCodes.InvalidParams, `${op.key} takes no query.tree`);
    checkTree(op.key, query.tree, defaults);
  }
  if (query.depth !== undefined) checkDepth(query.depth);
}

/** A trigger with build parameters is its locked `#params` twin: values can carry code (a branch with its
 * own Jenkinsfile, strings a pipeline evaluates). */
const hasParameters = (params: unknown) => Object.keys(queryOf(params)).length > 0;

/** A model-written string as one visible line: control, bidi and zero-width characters escaped. */
export function safe(value: unknown): string {
  return JSON.stringify(String(value))
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

/** `host` confirm literal and instance target: the base URL's host name, as Jenkins has no instance name. */
const hostOf = (config: Record<string, unknown>) => parseBaseUrl(requireString(config, 'baseUrl')).url.hostname;

/** `stored` confirm literal: the job's stored full name (`<full name>#<number>` for a build) from the
 * resolved target, else the names in the call. */
function storedLiteral({ params, targets }: ConfirmContext): string | undefined {
  const target = targets.find((t) => t.kind === 'job' || t.kind === 'build');
  if (target) return target.id;
  const path = pathOf(params);
  const job = stringOr(path.job);
  if (!job) return undefined;
  return path.number === undefined ? job : `${job}#${stringOr(path.number) ?? ''}`;
}

/** Where a call acts, for the summary: the resolved targets, else the job and build the call names. */
function destination(op: HttpOperation, params: unknown, targets: readonly ResolvedTarget[], host: string) {
  if (targets.length) return targets.map((t) => safe(t.name)).join(', ');
  if (op.key.startsWith('system.')) return host;
  const path = pathOf(params);
  const job = path.job ?? path.folder;
  if (job === undefined) return host;
  return `job "${safe(job)}"${path.number === undefined ? '' : ` #${safe(path.number)}`}`;
}

/** `A="x", B=[REDACTED]`: build parameters with secret ones, or all when the job can't be read, hidden. */
function parameterText(query: Record<string, unknown>, info: JobInfo | undefined) {
  return Object.entries(query)
    .map(([name, value]) => {
      const def = info?.parameters.find((p) => p.name === name);
      const hidden = !def || isSecretParameter(def) || value === REDACTED;
      return `${safe(truncate(name, 80))}=${hidden ? REDACTED : `"${safe(truncate(String(value), 120))}"`}`;
    })
    .join(', ');
}

export function createJenkinsPlugin(): PluginHandlers {
  return definePlugin({
    connect: (init) =>
      new HttpJsonClient({
        baseUrl: joinApiPath(requireString(init.config, 'baseUrl'), ''),
        service: SERVICE,
        verifyTls: init.config.verifyTls !== false,
        headers: authHeaders(init),
        timeoutMs: settings.defaults.timeouts.request,
      }),

    // Every response names the version in X-Jenkins; this call also proves the user and token.
    async version(kit) {
      const res = await kit.client().raw('GET', '/api/json', { query: { tree: 'mode' } });
      checkStatus(res, 'GET /api/json');
      const version = stringOr(res.headers['x-jenkins']);
      const major = version ? /^(\d+)\./.exec(version)?.[1] : undefined;
      if (!version || !major) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      if (Number(major) < settings.plugin.minMajor)
        throw new PluginError(
          ErrorCodes.UpstreamError,
          `${SERVICE} ${version} is not supported; this plugin needs ${SERVICE} ${settings.plugin.minMajor}.x or later`,
        );
      return version;
    },

    handlers(kit) {
      const client = () => kit.client();
      const host = () => hostOf(kit.init().config);
      const lookupMs = settings.defaults.timeouts.lookup;
      const rules = compileRules(settings, { custom: { stored: storedLiteral, host } });
      const operations = staticCatalog(rules);
      const binding = staticHttpBinding({
        namespace: 'jenkins',
        service: SERVICE,
        rules,
        client,
        splitWhen: { params: (_key, params) => hasParameters(params) },
      });
      const base = () => joinApiPath(requireString(kit.init().config, 'baseUrl'), '');

      return {
        async syncCatalog() {
          return { upstreamVersion: await kit.version(), operations };
        },

        async resolveOperation(call) {
          const resolved = await binding.resolveOperation(call);
          const op = operation(resolved.key);
          const p = isPlainObject(resolved.params) ? resolved.params : {};
          if (p.body !== undefined) throw new PluginError(ErrorCodes.InvalidParams, `${op.key} takes no body`);
          requestPath(op, p);
          const query = queryOf(p);
          checkQuery(op, query);
          // A password parameter would reach the audit log under its own name, which core can't know is secret.
          if (op.key === TRIGGER && Object.keys(query).length)
            checkTriggerParameters(await jobInfo(client(), pathOf(p).job, lookupMs), query);
          return resolved;
        },

        async resolveTargets({ key, params }) {
          const op = operation(key);
          if (op.classification === 'read') return [];
          if (op.key.startsWith('system.')) return [{ kind: 'instance', id: host(), name: host() }];
          return jenkinsTargets(client(), pathOf(params), lookupMs);
        },

        async summarize({ key, params, targets }) {
          const op = operation(key);
          const query = queryOf(params);
          let path: string;
          try {
            path = requestPath(op, params);
          } catch {
            path = op.http.path;
          }
          let detail = '';
          if (op.key === TRIGGER) {
            let info: JobInfo | undefined;
            try {
              info = await jobInfo(client(), pathOf(params).job, lookupMs);
            } catch {
              info = undefined;
            }
            if (info?.parameters.length || Object.keys(query).length) path = `${path}WithParameters`;
            if (Object.keys(query).length) detail = ` with ${parameterText(query, info)}`;
          } else if (op.key === 'system.quietDown' && query.reason !== undefined) {
            detail = ` (reason "${safe(truncate(String(query.reason), 200))}")`;
          } else if (op.classification === 'read') {
            path += queryString(query);
          }
          const dest = destination(op, params, targets, host());
          const text = `${SERVICE} ${key} on ${dest}: ${op.http.method} ${path}${detail}`;
          const literal = await rules.confirmLiteral({ key, params, targets });
          return literal ? { text, confirmLiteral: literal } : { text };
        },

        async invoke({ key, params, context }) {
          const op = operation(key);
          const timeoutMs = kit.timeout(context);
          const path = requestPath(op, params);
          const query = queryOf(params);
          checkQuery(op, query);

          if (op.key === LOG) {
            const slice = await readLog(client(), path, query, settings.plugin.log, timeoutMs);
            return { ...slice, text: maskUrlCredentials(slice.text) };
          }
          if (op.classification === 'read') {
            const tree = settings.plugin.trees[op.key];
            const sent = tree && query.tree === undefined && query.depth === undefined ? { ...query, tree } : query;
            const res = await send(client(), 'GET', path, { query: sent, timeoutMs });
            return maskEmbeddedCredentials(maskParameterSecrets(res.body));
          }
          if (op.key === TRIGGER) {
            if (hasParameters(params) !== (key !== op.key))
              throw new PluginError(ErrorCodes.InvalidParams, `${key} does not match the call's build parameters`);
            const info = await jobInfo(client(), pathOf(params).job, timeoutMs);
            checkTriggerParameters(info, query);
            const endpoint = info.parameters.length ? `${path}WithParameters` : path;
            const res = await send(client(), 'POST', endpoint, { query, timeoutMs, base: base() });
            const queueId = queueIdOf(res.headers.location);
            return queueId === undefined ? { job: info.fullName, queued: true } : { job: info.fullName, queueId };
          }
          await send(client(), op.http.method, path, { query, timeoutMs, base: base() });
          return { ok: true };
        },
      };
    },
  });
}
