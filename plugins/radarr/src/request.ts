import { ErrorCodes, isPlainObject, PluginError } from '@synoikia/plugin-sdk';
import type { RestParams } from '@synoikia/plugin-sdk';

/** Servarr binds query parameters (ASP.NET Core) and JSON bodies (System.Text.Json) case-insensitively, so `MoveFiles`
 * or `Id` reach the same property as `moveFiles` or `id`. A request is refused when two keys differ only in case
 * (which one wins is the upstream's choice), and the keys the rules read are renamed to one spelling, so split
 * checks, `sensitiveParams` pointers, literals and targets see what the upstream binds. */

const FIELD_KEYS = ['name', 'value', 'privacy'];

const refuse = (where: string, detail: string): never => {
  throw new PluginError(ErrorCodes.InvalidParams, `${where}: ${detail}; send each key once, in one spelling`);
};

/** A copy of `obj` with `canonical` keys spelled as given; refuses keys that differ only in case. */
function canonicalize(obj: Record<string, unknown>, canonical: readonly string[], where: string) {
  const byLower = new Map(canonical.map((k) => [k.toLowerCase(), k]));
  const seen = new Map<string, string>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    const other = seen.get(lower);
    if (other !== undefined) refuse(where, `"${other}" and "${key}" name the same parameter`);
    seen.set(lower, key);
    Object.defineProperty(out, byLower.get(lower) ?? key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Provider `fields[]`: item keys in one spelling, and each field name once (Servarr takes the first exact match). */
function canonicalFields(fields: unknown[]): unknown[] {
  const names = new Set<string>();
  return fields.map((item) => {
    if (!isPlainObject(item)) return item;
    const field = canonicalize(item, FIELD_KEYS, 'body.fields[]');
    if (typeof field.name === 'string') {
      const lower = field.name.toLowerCase();
      if (names.has(lower)) refuse('body.fields', `the field "${field.name}" appears more than once`);
      names.add(lower);
    }
    return field;
  });
}

/** `params` with case-duplicate keys refused and the `canonical` keys renamed, in the query, the body (or each body
 * item when it is a list) and provider fields. */
export function normalizeRequest(params: RestParams, canonical: readonly string[]): RestParams {
  const out: RestParams = { ...params };
  if (isPlainObject(params.query)) out.query = canonicalize(params.query, canonical, 'query');
  const body = (value: unknown): unknown => {
    if (!isPlainObject(value)) return value;
    const b = canonicalize(value, canonical, 'body');
    if (Array.isArray(b.fields)) b.fields = canonicalFields(b.fields);
    return b;
  };
  if (Array.isArray(params.body)) out.body = params.body.map(body);
  else if (params.body !== undefined) out.body = body(params.body);
  return out;
}
