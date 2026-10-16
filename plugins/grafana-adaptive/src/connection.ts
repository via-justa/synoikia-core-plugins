import { isIP } from 'node:net';
import { ErrorCodes, HttpJsonClient, parseBaseUrl, PluginError, requireString } from '@synoikia/plugin-sdk';
import type { InitParams } from '@synoikia/plugin-sdk';

export const SERVICES = ['metrics', 'logs', 'traces'] as const;
export type Service = (typeof SERVICES)[number];

export const SERVICE_NAMES: Record<Service, string> = {
  metrics: 'Adaptive Metrics',
  logs: 'Adaptive Logs',
  traces: 'Adaptive Traces',
};

/** The connection fields of each service: its stack endpoint URL and instance (tenant) id. */
export const FIELDS: Record<Service, { url: string; id: string }> = {
  metrics: { url: 'prometheusUrl', id: 'metricsInstanceId' },
  logs: { url: 'lokiUrl', id: 'logsInstanceId' },
  traces: { url: 'tempoUrl', id: 'tracesInstanceId' },
};

export interface Endpoint {
  service: Service;
  instanceId: string;
  /** The URL's origin: the Adaptive APIs sit at the host root, whatever path the stack page shows. */
  origin: string;
  client: HttpJsonClient;
  /** A client for one call with extra headers (`If-Match`). */
  withHeaders(extra: Record<string, string>): HttpJsonClient;
}

export type Endpoints = Partial<Record<Service, Endpoint>>;

const invalid = (message: string) => new PluginError(ErrorCodes.InvalidParams, message);

const isLoopback = (host: string) => {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || (isIP(h) === 4 && h.startsWith('127.'));
};

/** `https://host[:port]`, from a URL that is https, or http on loopback only (tests and tunnels). */
export function originOf(value: string, field: string): string {
  const { url } = parseBaseUrl(value);
  if (url.protocol !== 'https:' && !isLoopback(url.hostname))
    throw invalid(`${field} must be an https:// URL (http:// only on the loopback address)`);
  return url.origin;
}

/** One endpoint per service whose URL is set; a set URL needs a numeric instance id, and one service is needed. */
export function connect(init: InitParams, timeoutMs: number): Endpoints {
  const token = requireString(init.secrets, 'token');
  const endpoints: Endpoints = {};
  for (const service of SERVICES) {
    const { url, id } = FIELDS[service];
    const raw = init.config[url];
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string') throw invalid(`${url} must be a URL`);
    const instanceId = init.config[id];
    if (typeof instanceId !== 'string' || !/^\d{1,20}$/.test(instanceId))
      throw invalid(`${id} is required with ${url}: the numeric instance id shown next to it`);
    const origin = originOf(raw, url);
    const auth = `Basic ${Buffer.from(`${instanceId}:${token}`).toString('base64')}`;
    const make = (extra: Record<string, string>) =>
      new HttpJsonClient({
        baseUrl: origin,
        service: SERVICE_NAMES[service],
        headers: () => ({ ...extra, authorization: auth }),
        timeoutMs,
      });
    endpoints[service] = { service, instanceId, origin, client: make({}), withHeaders: make };
  }
  if (!Object.keys(endpoints).length)
    throw invalid('Set the URL and instance id of at least one of Adaptive Metrics, Logs or Traces');
  return endpoints;
}

/** The service an operation key is sent to: its first part. */
export function serviceOf(key: string): Service {
  const head = key.split('.')[0];
  const service = SERVICES.find((s) => s === head);
  if (!service) throw new PluginError(ErrorCodes.UnknownOperation, `${key} is not a Grafana Adaptive operation`);
  return service;
}

/** The endpoint of a key's service, or an error naming the connection fields to set. */
export function endpointFor(endpoints: Endpoints, key: string): Endpoint {
  const service = serviceOf(key);
  const endpoint = endpoints[service];
  if (!endpoint)
    throw new PluginError(
      ErrorCodes.UnknownOperation,
      `${key}: ${SERVICE_NAMES[service]} is not configured on this endpoint (set ${FIELDS[service].url})`,
    );
  return endpoint;
}
