import { isPlainObject, REDACTED } from '@synoikia/plugin-sdk';

/** Secrets key-based redaction can't see: a token in a URL's query (`?X-Plex-Token=…`), and the value of a server
 * setting whose id names a secret (`{ id: 'PlexOnlineToken', value: … }` in `GET /:/prefs`). */

const TOKEN_IN_URL = /([?&;](?:x-plex-token|token|accesstoken|authtoken)=)[^&#\s"'<>]*/gi;
const SECRET_SETTING = /token|password|secret|key$/i;
const MAX_DEPTH = 32;

const define = (out: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });

const maskUrl = (text: string) => text.replace(TOKEN_IN_URL, `$1${REDACTED}`);

const present = (v: unknown) => v !== undefined && v !== null && v !== '';

/** A copy of `value` with URL tokens and secret settings masked; anything nested too deep is hidden. */
export function maskTokens(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskUrl(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => maskTokens(v, depth + 1));
  if (!isPlainObject(value)) return REDACTED;
  const secret = typeof value.id === 'string' && SECRET_SETTING.test(value.id);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    define(out, k, secret && k === 'value' && present(v) ? REDACTED : maskTokens(v, depth + 1));
  return out;
}
