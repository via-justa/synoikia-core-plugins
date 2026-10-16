import {
  compileRules,
  definePlugin,
  ErrorCodes,
  errorMessage,
  isPlainObject,
  parsePluginSettings,
  PluginError,
  staticCatalog,
  statusKind,
  upstreamError,
} from '@synoikia/plugin-sdk';
import type { ConfirmContext, HttpResponse, PluginHandlers } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { connect, endpointFor, SERVICE_NAMES, SERVICES, serviceOf } from './connection.js';
import type { Endpoint, Endpoints, Service } from './connection.js';
import { checkParams, requestPath } from './request.js';
import type { CallParams, HttpOperation } from './request.js';
import {
  hasStored,
  INSTANCE_WRITES,
  storedObject,
  subjectLiteral,
  traceRecommendation,
  writeTargets,
} from './stored.js';
import { checkBodyFields, detailText, summaryText } from './summary.js';

/** Grafana Cloud Adaptive Metrics, Logs and Traces: operations declared in plugin.yaml, each sent to its service's
 * stack endpoint; the sandbox calls `grafanaAdaptive.call(operation, { path, query, body, ifMatch })`. */

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const probes = isPlainObject(p.probes) ? p.probes : {};
    for (const s of SERVICES)
      if (typeof probes[s] !== 'string' || !String(probes[s]).startsWith('/'))
        throw new Error(`plugin.yaml plugin.probes.${s} must be a path`);
    return { probes: probes as Record<Service, string> };
  },
});

const OPERATIONS = new Map(
  settings.operations.flatMap((op): [string, HttpOperation][] => (op.http ? [[op.key, { ...op, http: op.http }]] : [])),
);

function operation(key: string): HttpOperation {
  const op = OPERATIONS.get(key);
  if (!op) throw new PluginError(ErrorCodes.UnknownOperation, `${key} is not a Grafana Adaptive operation`);
  return op;
}

/** Checked params of a call; core hands back what `resolveOperation` returned, and it is checked again. */
function paramsOf(key: string, params: unknown): CallParams {
  const p = checkParams(operation(key), params);
  checkBodyFields(key, p.body);
  if ((key === 'metrics.rules.create' || key === 'metrics.rules.update') && isPlainObject(p.body))
    if (p.body.metric !== p.path?.metric)
      throw new PluginError(ErrorCodes.InvalidParams, `${key}: body.metric must equal path.metric`);
  return p;
}

/** A 2xx response, or the service's error; a 412 on a rules write means the etag is stale. */
function checkStatus(res: HttpResponse, service: Service, label: string): void {
  if (res.status >= 200 && res.status < 300) return;
  if (res.status === 412)
    throw new PluginError(
      ErrorCodes.InvalidParams,
      `${label}: the rules changed since ifMatch was read (412); read them again with metrics.rules.list and retry`,
      { status: 412 },
    );
  const kind = statusKind(res.status);
  const message = errorMessage(res);
  throw upstreamError(
    SERVICE_NAMES[service],
    kind,
    label,
    kind === 'failed' ? `HTTP ${res.status} (${message})` : message,
    { status: res.status },
  );
}

const header = (res: HttpResponse, name: string) => {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function createGrafanaAdaptivePlugin(): PluginHandlers {
  return definePlugin<Endpoints>({
    connect: (init) => connect(init, settings.defaults.timeouts.request),

    // Each configured service answers a cheap read, which proves its URL, instance id and the token's scopes.
    async version(kit) {
      const endpoints = kit.client();
      const configured = SERVICES.filter((s) => endpoints[s]);
      for (const s of configured) {
        const path = settings.plugin.probes[s];
        checkStatus(await endpoints[s]!.client.raw('GET', path), s, `GET ${path}`);
      }
      return `adaptive (${configured.join(', ')})`;
    },

    handlers(kit) {
      const lookupMs = settings.defaults.timeouts.lookup;
      const endpoint = (key: string): Endpoint => endpointFor(kit.client(), key);
      const callParams = (ctx: ConfirmContext) => (isPlainObject(ctx.params) ? (ctx.params as CallParams) : {});
      const rules = compileRules(settings, {
        custom: {
          instance: (ctx) => endpoint(ctx.key).instanceId,
          subject: (ctx) => subjectLiteral(endpoint(ctx.key), ctx.key, callParams(ctx), ctx.targets),
        },
      });
      const operations = staticCatalog(rules);

      /** The recommendation settings in force, for a change's summary. */
      const currentConfig = async (e: Endpoint) => {
        try {
          const res = await e.client.raw('GET', '/aggregations/recommendations/config', { timeoutMs: lookupMs });
          return res.status === 200 && isPlainObject(res.body) ? res.body : undefined;
        } catch {
          return undefined;
        }
      };

      /** The rule set in force, for a replacement's summary. */
      const currentRules = async (e: Endpoint, p: CallParams) => {
        try {
          const segment = p.query?.segment;
          const res = await e.client.raw('GET', '/aggregations/rules', {
            query: segment === undefined ? undefined : { segment },
            timeoutMs: lookupMs,
          });
          return res.status === 200 && Array.isArray(res.body) ? res.body.filter(isPlainObject) : undefined;
        } catch {
          return undefined;
        }
      };

      return {
        // Only the operations of configured services are offered.
        async syncCatalog() {
          const upstreamVersion = await kit.version();
          const endpoints = kit.client();
          return { upstreamVersion, operations: operations.filter((o) => endpoints[serviceOf(o.key)]) };
        },

        async resolveOperation({ fn, args }) {
          if (fn !== 'call')
            throw new PluginError(ErrorCodes.UnknownOperation, `grafanaAdaptive.${fn} is not a binding function`);
          const [key, params] = args;
          if (typeof key !== 'string' || !key || key.includes('#'))
            throw new PluginError(
              ErrorCodes.InvalidParams,
              'grafanaAdaptive.call(operation, params): operation must be a name',
            );
          operation(key);
          endpoint(key);
          return { key, params: paramsOf(key, params) };
        },

        async resolveTargets({ key, params }) {
          if (operation(key).classification === 'read') return [];
          return writeTargets(endpoint(key), key, paramsOf(key, params), lookupMs);
        },

        async summarize({ key, params, targets }) {
          const op = operation(key);
          const e = endpoint(key);
          const p = paramsOf(key, params);
          let detail = '';
          if (op.classification === 'write') {
            let stored: Record<string, unknown> | undefined;
            if (hasStored(key)) stored = await storedObject(e, key, p, lookupMs);
            if (key.startsWith('traces.recommendations.')) stored = await traceRecommendation(e, p.path?.id, lookupMs);
            const current =
              key === 'metrics.rules.replace'
                ? await currentRules(e, p)
                : key === 'metrics.recommendations.updateConfig'
                  ? await currentConfig(e)
                  : undefined;
            detail = detailText(key, p, stored, current);
          }
          const text = summaryText({
            serviceName: SERVICE_NAMES[e.service],
            key,
            op,
            path: requestPath(op, p),
            params: p,
            targets,
            instance: `${SERVICE_NAMES[e.service]} instance ${e.instanceId}`,
            detail,
          });
          const literal = await rules.confirmLiteral({ key, params: p, targets });
          return literal ? { text, confirmLiteral: literal } : { text };
        },

        async invoke({ key, params, context }) {
          const op = operation(key);
          const e = endpoint(key);
          const p = paramsOf(key, params);
          const path = requestPath(op, p);
          const client = p.ifMatch === undefined ? e.client : e.withHeaders({ 'if-match': p.ifMatch });
          const res = await client.raw(op.http.method, path, {
            query: p.query,
            body: p.body,
            timeoutMs: kit.timeout(context),
          });
          // check-rules answers 400 with the list of errors when the rules are invalid.
          if (key === 'metrics.rules.check' && (res.status === 200 || res.status === 400) && Array.isArray(res.body))
            return { valid: res.body.length === 0, errors: res.body };
          checkStatus(res, e.service, `${op.http.method} ${path}`);
          if (key === 'metrics.rules.list') return { etag: header(res, 'etag') ?? null, rules: res.body ?? [] };
          if (key === 'metrics.recommendations.list') {
            const version = header(res, 'rules-version');
            return { ...(version ? { rulesVersion: version } : {}), recommendations: res.body ?? [] };
          }
          if (op.classification === 'write' && (INSTANCE_WRITES.has(key) || key.startsWith('metrics.rules.'))) {
            const etag = header(res, 'etag');
            return { ok: true, ...(etag ? { etag } : {}) };
          }
          return res.body ?? { ok: true };
        },
      };
    },
  });
}
