import { fetchSpec as fetchText, isPlainObject } from '@synoikia/plugin-sdk';

/** Servarr apps serve their OpenAPI spec only in debug builds, so it is fetched from the repository at the release
 * tag matching the instance's version, else a fallback branch, from a configurable mirror; no credentials sent. */

export interface SpecSource {
  /** `<baseUrl>/<git ref>/<file>` is the spec. */
  baseUrl: string;
  file: string;
  fallbackRef: string;
  maxBytes: number;
  timeoutMs: number;
}

/** Validates plugin.yaml's `plugin.spec`. */
export function parseSpecSource(value: unknown): SpecSource {
  const p = isPlainObject(value) ? value : {};
  const text = (key: string) => {
    const v = p[key];
    if (typeof v !== 'string' || !v) throw new Error(`plugin.yaml plugin.spec.${key} must be a string`);
    return v;
  };
  const num = (key: string) => {
    const v = p[key];
    if (typeof v !== 'number' || v <= 0) throw new Error(`plugin.yaml plugin.spec.${key} must be a positive number`);
    return v;
  };
  return {
    baseUrl: text('baseUrl'),
    file: text('file'),
    fallbackRef: text('fallbackRef'),
    maxBytes: num('maxBytes'),
    timeoutMs: num('timeoutMs'),
  };
}

/** Servarr tags every build with its 4-part version: `6.4.4.10685` → `v6.4.4.10685`; anything else has no tag. */
export function tagFor(version: string): string | undefined {
  const v = version.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+\.\d+$/.test(v) ? `v${v}` : undefined;
}

/** Fetches the spec for `version` (the tag, then the fallback ref); returns its text and the ref it came from. */
export function fetchServarrSpec(
  service: string,
  source: SpecSource,
  version: string,
  baseUrl: string = source.baseUrl,
): Promise<{ text: string; ref: string }> {
  const base = baseUrl.replace(/\/+$/, '');
  const tag = tagFor(version);
  return fetchText({
    service,
    candidates: (tag ? [tag, source.fallbackRef] : [source.fallbackRef]).map((ref) => ({
      url: `${base}/${ref}/${source.file}`,
      ref,
    })),
    maxBytes: source.maxBytes,
    timeoutMs: source.timeoutMs,
  });
}
