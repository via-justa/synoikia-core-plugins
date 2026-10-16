import { createHash } from 'node:crypto';
import { fillTemplate, isPlainObject, stringOr } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import { SERVICE_NAMES } from './connection.js';
import type { Endpoint } from './connection.js';
import type { CallParams } from './request.js';

/** Writes that act on a whole service instance (its rule set, its settings, a recommendation's policies). */
export const INSTANCE_WRITES = new Set([
  'metrics.rules.replace',
  'metrics.recommendations.updateConfig',
  'traces.recommendations.apply',
]);

/** Per-object writes: the read that returns the stored object, and the field that names it. */
interface StoredSpec {
  /** The read path, from the call's `path.id` or `path.metric`. */
  read: string;
  kind: string;
  /** The field that names the object. */
  name: string;
  /** The read answers `{ result: … }`. */
  wrapped?: boolean;
}

const READS: Record<string, StoredSpec> = {
  'metrics.rules': { read: '/aggregations/rule/{metric}', kind: 'metric-rule', name: 'metric' },
  'metrics.exemptions': {
    read: '/v1/recommendations/exemptions/{id}',
    kind: 'metrics-exemption',
    name: 'metric',
    wrapped: true,
  },
  'logs.exemptions': {
    read: '/adaptive-logs/exemptions/{id}',
    kind: 'logs-exemption',
    name: 'stream_selector',
    wrapped: true,
  },
  'logs.dropRules': { read: '/adaptive-logs/drop-rules/{id}', kind: 'drop-rule', name: 'name' },
  'traces.policies': { read: '/adaptive-traces/api/v1/policies/{id}', kind: 'policy', name: 'name' },
};

const STORED: Record<string, StoredSpec> = Object.fromEntries(
  Object.entries(READS).flatMap(([prefix, spec]) => ['update', 'delete'].map((verb) => [`${prefix}.${verb}`, spec])),
);

/** Whether a key reads a stored object for its target. */
export const hasStored = (key: string) => Object.hasOwn(STORED, key);

/** The stored object a write acts on, read back from the service; undefined when it can't be read. */
export async function storedObject(
  endpoint: Endpoint,
  key: string,
  params: CallParams,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const spec = STORED[key];
  if (!spec) return undefined;
  const segment = params.query?.segment;
  try {
    const res = await endpoint.client.raw('GET', fillTemplate(spec.read, params.path ?? {}), {
      query: typeof segment === 'string' && key.startsWith('metrics.') ? { segment } : undefined,
      timeoutMs,
    });
    if (res.status !== 200) return undefined;
    const body = spec.wrapped && isPlainObject(res.body) ? res.body.result : res.body;
    return isPlainObject(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** What a write acts on. Per-object writes name the stored object (none when it can't be read); creates have no
 * stored object; instance-wide writes name the service instance. No status, as core compares targets after the
 * approval wait. */
export async function writeTargets(
  endpoint: Endpoint,
  key: string,
  params: CallParams,
  timeoutMs: number,
): Promise<ResolvedTarget[]> {
  if (key === 'traces.recommendations.apply') {
    const rec = await traceRecommendation(endpoint, params.path?.id, timeoutMs);
    return rec ? [instanceTarget(endpoint), recommendationTarget(rec)] : [instanceTarget(endpoint)];
  }
  if (INSTANCE_WRITES.has(key)) return [instanceTarget(endpoint)];
  const spec = STORED[key];
  if (!spec) return [];
  const stored = await storedObject(endpoint, key, params, timeoutMs);
  const name = stored ? stringOr(stored[spec.name]) : undefined;
  if (!name) return [];
  const id = params.path?.id ?? params.path?.metric ?? name;
  return [{ kind: spec.kind, id, name }];
}

/** A trace recommendation, read from the list (there is no read by id); undefined when it can't be read. */
export async function traceRecommendation(
  endpoint: Endpoint,
  id: string | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await endpoint.client.raw('GET', '/adaptive-traces/api/v1/recommendations', { timeoutMs });
    if (res.status !== 200 || !Array.isArray(res.body)) return undefined;
    return res.body.find((r): r is Record<string, unknown> => isPlainObject(r) && r.id === id);
  } catch {
    return undefined;
  }
}

/** The recommendation with a hash of its actions in the id, so one regenerated during the approval wait changes the
 * target and core refuses the call. */
const recommendationTarget = (rec: Record<string, unknown>): ResolvedTarget => {
  const hash = createHash('sha256')
    .update(JSON.stringify(rec.actions ?? null))
    .digest('hex')
    .slice(0, 12);
  return { kind: 'trace-recommendation', id: `${String(rec.id)}#${hash}`, name: `recommendation ${String(rec.id)}` };
};

export const instanceTarget = (endpoint: Endpoint): ResolvedTarget => ({
  kind: 'instance',
  id: `${endpoint.service}:${endpoint.instanceId}`,
  name: `${SERVICE_NAMES[endpoint.service]} instance ${endpoint.instanceId}`,
});

/** The confirm literal of a per-object write: the stored object's name, else for a create the name the call gives,
 * else the instance id. */
export function subjectLiteral(
  endpoint: Endpoint,
  key: string,
  params: CallParams,
  targets: readonly ResolvedTarget[],
) {
  const target = targets.find((t) => t.kind !== 'instance' && t.kind !== 'trace-recommendation');
  if (target) return target.name;
  const body = isPlainObject(params.body) ? params.body : {};
  const fromCall =
    key === 'metrics.rules.create'
      ? params.path?.metric
      : key === 'metrics.exemptions.create'
        ? stringOr(body.metric)
        : key === 'logs.exemptions.create'
          ? stringOr(body.stream_selector)
          : key === 'logs.dropRules.create' || key === 'traces.policies.create'
            ? stringOr(body.name)
            : undefined;
  return fromCall ?? endpoint.instanceId;
}
