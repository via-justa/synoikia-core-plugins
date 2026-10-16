import { ErrorCodes, fillTemplate, isPlainObject, PluginError, truncate } from '@synoikia/plugin-sdk';
import type { StaticOperation } from '@synoikia/plugin-sdk';

export type HttpOperation = StaticOperation & { http: NonNullable<StaticOperation['http']> };

/** A call's params after the checks: what is sent, and nothing else. */
export interface CallParams {
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  ifMatch?: string;
}

const invalid = (message: string) => new PluginError(ErrorCodes.InvalidParams, message);

/** Body keys the plugin reads for summaries, literals and targets, in the spelling Grafana's Go services bind. */
const CANONICAL = [
  'metric',
  'match_type',
  'drop',
  'keep_labels',
  'drop_labels',
  'aggregations',
  'auto_apply',
  'enabled',
  'gate',
  'policy',
  'disable_recommendations',
  'name',
  'type',
  'body',
  'drop_rate',
  'stream_selector',
  'levels',
  'log_line_contains',
  'disabled',
  'expires_at',
  'segment_id',
  'version',
];

/** The Adaptive services are Go: encoding/json binds keys case-insensitively (the last match wins) and folds `ſ` to `s`
 * and the Kelvin sign to `k`. Two keys that differ only in case, or a non-ASCII key, are refused at any depth, and the
 * keys the plugin reads are renamed to one spelling, so summaries and literals see what the service binds. */
function canonicalize(value: unknown, byLower: ReadonlyMap<string, string>, where: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => canonicalize(v, byLower, `${where}[${i}]`));
  if (!isPlainObject(value)) return value;
  const seen = new Map<string, string>();
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!/^[\x20-\x7e]*$/.test(key))
      throw invalid(`${where}: the key ${JSON.stringify(key)} is not ASCII; send each key once, in one ASCII spelling`);
    const lower = key.toLowerCase();
    const other = seen.get(lower);
    if (other !== undefined)
      throw invalid(`${where}: "${other}" and "${key}" name the same field; send each key once, in one ASCII spelling`);
    seen.set(lower, key);
    Object.defineProperty(out, byLower.get(lower) ?? key, {
      value: canonicalize(v, byLower, `${where}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const BY_LOWER = new Map(CANONICAL.map((k) => [k.toLowerCase(), k]));

/** Prometheus metric names, and the ids Grafana gives exemptions, drop rules, policies and segments. */
const METRIC = /^[A-Za-z_:][A-Za-z0-9_:]{0,199}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const schemaProps = (op: HttpOperation): Record<string, unknown> => {
  const props = op.paramsSchema?.properties;
  return isPlainObject(props) ? props : {};
};

function checkPath(op: HttpOperation, path: unknown): Record<string, string> | undefined {
  const names = [...op.http.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const given = path === undefined ? {} : path;
  if (!isPlainObject(given)) throw invalid('path must be an object');
  const extra = Object.keys(given).find((k) => !names.includes(k));
  if (extra !== undefined) throw invalid(`${op.key} takes no path.${truncate(extra, 80)}`);
  if (!names.length) return undefined;
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = given[name];
    const pattern = name === 'metric' ? METRIC : ID;
    if (typeof v !== 'string' || !pattern.test(v))
      throw invalid(
        name === 'metric'
          ? 'path.metric must be a metric name such as http_requests_total'
          : `path.${name} must be an id as Grafana returns it`,
      );
    out[name] = v;
  }
  return out;
}

function checkQueryValue(op: HttpOperation, key: string, value: unknown, schema: unknown): void {
  const s = isPlainObject(schema) ? schema : {};
  const where = `${op.key} query.${key}`;
  const enumOf = (x: unknown) => (isPlainObject(x) && Array.isArray(x.enum) ? x.enum : undefined);
  if (s.type === 'boolean') {
    if (typeof value !== 'boolean') throw invalid(`${where} must be true or false`);
    return;
  }
  if (s.type === 'array') {
    const allowed = enumOf(s.items);
    const values = Array.isArray(value) ? value : [value];
    for (const v of values)
      if (typeof v !== 'string' || (allowed && !allowed.includes(v)))
        throw invalid(`${where} must be ${allowed ? `one or more of ${allowed.join(', ')}` : 'strings'}`);
    return;
  }
  const allowed = enumOf(s);
  // `__global__` names the tenant-wide segment of Adaptive Logs drop rules.
  const idOk = (v: string) => ID.test(v) || (key === 'segment_id' && v === '__global__');
  if (typeof value !== 'string' || (allowed ? !allowed.includes(value) : !idOk(value)))
    throw invalid(`${where} must be ${allowed ? `one of ${allowed.join(', ')}` : 'an id as Grafana returns it'}`);
}

function checkQuery(op: HttpOperation, query: unknown): Record<string, unknown> | undefined {
  if (query === undefined) return undefined;
  if (!isPlainObject(query)) throw invalid('query must be an object');
  const keys = Object.keys(query);
  if (!keys.length) return undefined;
  const schema = schemaProps(op).query;
  const props = isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : undefined;
  if (!props) throw invalid(`${op.key} takes no query`);
  const folded = new Set(keys.map((k) => k.toLowerCase()));
  if (folded.size !== keys.length) throw invalid(`${op.key}: query keys must not differ only by case`);
  for (const k of keys) {
    if (!Object.hasOwn(props, k))
      throw invalid(`${op.key} takes no query.${truncate(k, 80)}; it takes ${Object.keys(props).join(', ')}`);
    checkQueryValue(op, k, query[k], props[k]);
  }
  return query;
}

/** `If-Match` for a rules write: the `etag` (or `rulesVersion`) as read, one line of visible ASCII. */
function checkIfMatch(op: HttpOperation, value: unknown): string | undefined {
  const takes = Object.hasOwn(schemaProps(op), 'ifMatch');
  if (!takes) {
    if (value !== undefined) throw invalid(`${op.key} takes no ifMatch`);
    return undefined;
  }
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value))
    throw invalid(`${op.key} needs ifMatch: the etag from metrics.rules.list (or rulesVersion of a recommendation)`);
  return value;
}

function checkBody(op: HttpOperation, body: unknown): unknown {
  const schema = schemaProps(op).body;
  if (!isPlainObject(schema)) {
    if (body !== undefined) throw invalid(`${op.key} takes no body`);
    return undefined;
  }
  const wantsArray = schema.type === 'array';
  if (wantsArray ? !Array.isArray(body) : !isPlainObject(body))
    throw invalid(`${op.key} needs a body: ${wantsArray ? 'a list of rules' : 'an object'}`);
  return canonicalize(body, BY_LOWER, 'body');
}

/** The checked params of a call: path params that fit the template, declared query keys of the right type, a body
 * only where one is declared (Go key spellings refused or canonicalized), and `ifMatch` where a rules write needs it. */
export function checkParams(op: HttpOperation, raw: unknown): CallParams {
  if (raw !== undefined && !isPlainObject(raw)) throw invalid('params must be an object');
  const p = raw ?? {};
  const unknown = Object.keys(p).find((k) => !['path', 'query', 'body', 'ifMatch'].includes(k));
  if (unknown !== undefined) throw invalid(`params take path, query, body and ifMatch, not ${truncate(unknown, 80)}`);
  const path = checkPath(op, p.path);
  const query = checkQuery(op, p.query);
  const body = checkBody(op, p.body);
  const ifMatch = checkIfMatch(op, p.ifMatch);
  return {
    ...(path ? { path } : {}),
    ...(query ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(ifMatch !== undefined ? { ifMatch } : {}),
  };
}

/** The request path of checked params. */
export const requestPath = (op: HttpOperation, params: CallParams) => fillTemplate(op.http.path, params.path ?? {});
