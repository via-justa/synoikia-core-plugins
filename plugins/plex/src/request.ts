import { ErrorCodes, isPlainObject, PluginError, REDACTED } from '@synoikia/plugin-sdk';
import type { RestParams } from '@synoikia/plugin-sdk';

// Runs before splits, literals and targets read the query; the checks and their reasons are in docs/designs/plex.md.

const MAX_DEPTH = 16;

const refuse = (detail: string): never => {
  throw new PluginError(ErrorCodes.InvalidParams, detail);
};

const hasRedacted = (value: unknown, depth = 0): boolean => {
  if (typeof value === 'string') return value.includes(REDACTED);
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => hasRedacted(v, depth + 1));
  return isPlainObject(value) && Object.values(value).some((v) => hasRedacted(v, depth + 1));
};

function canonicalQuery(query: Record<string, unknown>, canonical: readonly string[]) {
  const byLower = new Map(canonical.map((k) => [k.toLowerCase(), k]));
  const seen = new Map<string, string>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    const lower = key.toLowerCase();
    if (lower === 'x-plex-token') refuse('query: X-Plex-Token is not a parameter; the plugin authenticates each call');
    const other = seen.get(lower);
    if (other !== undefined)
      refuse(`query: "${other}" and "${key}" name the same parameter; send each key once, in one spelling`);
    seen.set(lower, key);
    const name = byLower.get(lower);
    if (name !== undefined && value !== null && typeof value === 'object')
      refuse(`query: "${key}" takes one plain value, not a list or an object`);
    Object.defineProperty(out, name ?? key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function normalizeRequest(params: RestParams, canonical: readonly string[]): RestParams {
  const out: RestParams = { ...params };
  if (isPlainObject(params.query)) out.query = canonicalQuery(params.query, canonical);
  if (hasRedacted(out.query) || hasRedacted(out.body))
    refuse(
      `The request contains ${REDACTED}, a masked value from an earlier result; Plex would store it as is. ` +
        'Leave the setting out, or ask the user for the value',
    );
  return out;
}
