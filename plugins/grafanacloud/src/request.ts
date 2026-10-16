import { ErrorCodes, isPlainObject, PluginError } from '@synoikia/plugin-sdk';
import type { RestParams } from '@synoikia/plugin-sdk';

/** grafana.com is Go: encoding/json binds body keys case-insensitively (the last match wins) and folds `ſ` to `s`
 * and the Kelvin sign to `k`. A request is refused when, at any depth, two keys differ only in case or a key is not
 * ASCII, and the keys the rules read are renamed to one spelling, so summaries, literals and targets see what
 * grafana.com binds. */

const refuse = (where: string, detail: string): never => {
  throw new PluginError(ErrorCodes.InvalidParams, `${where}: ${detail}; send each key once, in one ASCII spelling`);
};

function canonicalize(value: unknown, byLower: ReadonlyMap<string, string>, where: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => canonicalize(v, byLower, `${where}[${i}]`));
  if (!isPlainObject(value)) return value;
  const seen = new Map<string, string>();
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!/^[\x20-\x7e]*$/.test(key)) refuse(where, `the key ${JSON.stringify(key)} is not ASCII`);
    const lower = key.toLowerCase();
    const other = seen.get(lower);
    if (other !== undefined) refuse(where, `"${other}" and "${key}" name the same field`);
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

/** `params` with case-duplicate and non-ASCII keys refused and the `canonical` keys renamed, in the query and the
 * body at any depth. */
export function normalizeRequest(params: RestParams, canonical: readonly string[]): RestParams {
  const byLower = new Map(canonical.map((k) => [k.toLowerCase(), k]));
  const out: RestParams = { ...params };
  if (params.query !== undefined) out.query = canonicalize(params.query, byLower, 'query') as RestParams['query'];
  if (params.body !== undefined) out.body = canonicalize(params.body, byLower, 'body');
  return out;
}
