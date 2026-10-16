import { ErrorCodes, isPlainObject, PluginError, stringOr } from '@synoikia/plugin-sdk';

/** Servarr provider settings (download clients, indexers, applications, proxies, notifications) are a `fields`
 * list of `{ name, value, privacy }`; key-based redaction can't see a secret in `value`, so these helpers do. */

/** Servarr's own mask: a provider write that sends it back keeps the stored password or API key. */
export const PRIVATE_VALUE = '********';
const REDACTED = '[REDACTED]';
const PRIVATE = new Set(['password', 'apikey']);
// Cardigann indexer settings come back unmasked: `password`-typed fields, cookies, passkeys, 2FA codes, PINs.
const SECRET_NAME = /pass|secret|token|apikey|api_key|cookie|auth|key$|2fa|^pin$/i;
const MAX_DEPTH = 16;

/** A model-written string as one visible line: control, bidi and zero-width characters escaped. */
export function safe(value: unknown): string | undefined {
  const text = stringOr(value);
  if (text === undefined) return undefined;
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

const asUrl = (value: unknown): URL | undefined => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) return undefined;
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
};

/** `https://user:pw@discord.com/api/webhooks/1/abc?x` → `https://discord.com`: where a URL goes, without what it
 * carries. */
export function originOf(value: unknown): string | undefined {
  const url = asUrl(value);
  return url ? `${url.protocol}//${url.host}` : undefined;
}

/** Keeps only a URL's origin: webhook, feed and indexer URLs carry tokens, passkeys and UUIDs in the path or query. */
function maskUrl(value: string): string {
  const url = asUrl(value);
  if (!url) return value;
  const rest = url.pathname.replace(/\/+$/, '') || url.username || url.password || url.search || url.hash;
  return rest ? `${url.protocol}//${url.host}/${REDACTED}` : value;
}

/** A magnet link with only its info hash: trackers (`tr`) carry the passkey, and no other parameter is needed. */
function cutMagnet(value: string): string {
  const query = value.slice(value.indexOf('?') + 1);
  const xt = new URLSearchParams(query).getAll('xt');
  const ok = xt.length > 0 && xt.every((x) => /^urn:(btih:([0-9a-f]{40}|[a-z2-7]{32})|btmh:[0-9a-f]+)$/i.test(x));
  return ok ? `magnet:?${xt.map((x) => `xt=${x}`).join('&')}` : `magnet:?${REDACTED}`;
}

/** `value` with every string under one of `keys` (any case, any depth) that is a URL cut to its origin, or a magnet
 * link cut to its info hash: indexers use the download link, passkey included, as the guid, and info and comment
 * links can carry it too. Other guids stay; a release whose guid was cut can't be grabbed by it. */
/** A link cut to its origin or info hash; anything else that looks like an encoded or bare tracker link is hidden. */
function cutLink(value: string): string {
  if (/^\s*magnet:/i.test(value)) return cutMagnet(value.trim());
  const cut = maskUrl(value);
  return cut === value && /tr=|%3a/i.test(value) ? REDACTED : cut;
}

export function cutLinksDeep(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => cutLinksDeep(v, keys, depth + 1));
  if (!isPlainObject(value)) return value;
  const lower = new Set(keys.map((k) => k.toLowerCase()));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    Object.defineProperty(out, k, {
      value: lower.has(k.toLowerCase()) && typeof v === 'string' ? cutLink(v) : cutLinksDeep(v, keys, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}

/** `value` with every entry whose key matches one of `keys` in any case hidden, at any depth: a history `Url` must
 * not slip past `sensitiveResult`, whose keys match exactly. */
export function redactKeysDeep(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactKeysDeep(v, keys, depth + 1));
  if (!isPlainObject(value)) return value;
  const lower = new Set(keys.map((k) => k.toLowerCase()));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    Object.defineProperty(out, k, {
      value: lower.has(k.toLowerCase()) && v !== null && v !== '' ? REDACTED : redactKeysDeep(v, keys, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}

/** Key/value lists (webhook `headers`) and objects inside a field value: every entry's value hidden. */
function maskEntries(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((v) =>
      typeof v === 'string' ? maskUrl(v) : isPlainObject(v) || Array.isArray(v) ? maskEntries(v) : v,
    );
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    Object.defineProperty(out, k, {
      value: k === 'key' || k === 'name' ? v : REDACTED,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}

const isField = (v: unknown): v is Record<string, unknown> => isPlainObject(v) && 'value' in v && 'name' in v;

const KEPT_TYPES = new Set(['select', 'checkbox']);

/** Cardigann settings are free-form per definition and come back unmasked, so every string is hidden except the
 * site URL (origin) and select or checkbox values. */
function maskStrict(field: Record<string, unknown>, value: unknown): unknown {
  // The site URL is a select in Cardigann, so it is cut to its origin before select values are kept.
  if (field.name === 'baseUrl' && typeof value === 'string') return maskUrl(value);
  const type = typeof field.type === 'string' ? field.type.toLowerCase() : '';
  if (KEPT_TYPES.has(type)) return value;
  if (typeof value === 'string') return REDACTED;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' && v !== '' ? REDACTED : v));
  return isPlainObject(value) ? maskEntries(value) : value;
}

function maskField(field: Record<string, unknown>, strict: boolean): Record<string, unknown> {
  const { value } = field;
  if (value === null || value === undefined || value === '') return field;
  const privacy = typeof field.privacy === 'string' ? field.privacy.toLowerCase() : '';
  if (PRIVATE.has(privacy)) return { ...field, value: PRIVATE_VALUE };
  if (strict) return { ...field, value: maskStrict(field, value) };
  // Not marked private, so Servarr would store its mask as is: the write guard refuses `[REDACTED]` instead.
  const secretType = typeof field.type === 'string' && field.type.toLowerCase() === 'password';
  if (secretType || (typeof field.name === 'string' && SECRET_NAME.test(field.name)))
    return { ...field, value: REDACTED };
  if (typeof value === 'string') return { ...field, value: maskUrl(value) };
  return { ...field, value: maskEntries(value) };
}

/** A result with every provider field's password or API key replaced by Servarr's mask, URLs cut to their origin
 * and key/value entries hidden. Anything nested too deep is hidden. */
export function maskProviderFields(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => maskProviderFields(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const strict = typeof value.implementation === 'string' && value.implementation.toLowerCase() === 'cardigann';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const masked =
      k === 'fields' && Array.isArray(v)
        ? v.map((f) => (isField(f) ? maskField(f, strict) : maskProviderFields(f, depth + 1)))
        : maskProviderFields(v, depth + 1);
    Object.defineProperty(out, k, { value: masked, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

const hasRedacted = (value: unknown, depth = 0): boolean => {
  if (typeof value === 'string') return value.includes(REDACTED);
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => hasRedacted(v, depth + 1));
  return isPlainObject(value) && Object.values(value).some((v) => hasRedacted(v, depth + 1));
};

/** Refuses a body that carries a masked value from an earlier result: Servarr would store `[REDACTED]` as the
 * password, URL or key. Servarr's own `********` is fine (it keeps the stored secret). */
export function refuseMaskedValues(body: unknown): void {
  if (hasRedacted(body))
    throw new PluginError(
      ErrorCodes.InvalidParams,
      `The body contains ${REDACTED}, a masked value from an earlier result; the upstream would store it as is. ` +
        `Leave the field out, send ${PRIVATE_VALUE} to keep a stored password or API key, or ask the user for the value`,
    );
}

/** Where a provider body sends data: hosts and URL origins, and the recipients of a notification. Field names match
 * exactly and the first one wins, as Servarr reads them (`SchemaBuilder.ReadFromSchema`). */
export function destinations(body: unknown): string[] {
  if (!isPlainObject(body) || !Array.isArray(body.fields)) return [];
  const byName = new Map<string, unknown>();
  for (const f of body.fields)
    if (isField(f) && typeof f.name === 'string' && !byName.has(f.name)) byName.set(f.name, f.value);
  const out = new Set<string>();
  // A URL in `host` is listed by its origin below; any other form loses userinfo before the first `/?#\`.
  const rawHost = byName.get('host');
  const host = originOf(rawHost)
    ? undefined
    : safe(typeof rawHost === 'string' ? rawHost.replace(/^[^/?#\\]*@/, '') : rawHost);
  if (host) {
    const port = safe(byName.get('port'));
    out.add(`${byName.get('useSsl') === true ? 'https' : 'http'}://${host}${port ? `:${port}` : ''}`);
  }
  for (const [name, value] of byName) {
    if (PRIVATE.has(name.toLowerCase()) || SECRET_NAME.test(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      const origin = originOf(v);
      if (origin) out.add(safe(origin) ?? origin);
      else if (['server', 'to', 'cc', 'bcc'].includes(name) && safe(v)) out.add(safe(v)!);
    }
  }
  return [...out];
}
