import { fetchSpec as fetchText } from '@synoikia/plugin-sdk';
import { settings } from './catalog.js';

/**
 * Where the catalog comes from (SR §2.2): Seerr has no introspection endpoint, so the plugin fetches
 * the spec from the release tag matching the instance's `/status` version, and falls back to a branch
 * (nightly and self-built instances have no matching tag). The source is in plugin.yaml; the base URL
 * is a connection field for a mirror on a network without GitHub access. No credentials are sent.
 */

export const DEFAULT_SPEC_BASE_URL = settings.plugin.spec.baseUrl;

/** `3.4.1` → `v3.4.1`; anything that isn't a plain release version has no tag to try. */
export function tagFor(version: string): string | undefined {
  const v = version.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(v) ? `v${v}` : undefined;
}

/** Fetches the spec for `version`; returns its text and the git ref it came from. */
export function fetchSpec(
  version: string,
  baseUrl: string = DEFAULT_SPEC_BASE_URL,
): Promise<{ text: string; ref: string }> {
  const { file, fallbackRef, maxBytes, timeoutMs } = settings.plugin.spec;
  const base = baseUrl.replace(/\/+$/, '');
  const tag = tagFor(version);
  return fetchText({
    service: 'Seerr',
    candidates: (tag ? [tag, fallbackRef] : [fallbackRef]).map((ref) => ({ url: `${base}/${ref}/${file}`, ref })),
    maxBytes,
    timeoutMs,
  });
}
