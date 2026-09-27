import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';

/**
 * Where the catalog comes from (SR §2.2): Seerr has no introspection endpoint, so the plugin fetches
 * `seerr-api.yml` from the release tag matching the instance's `/status` version, and falls back to
 * `develop` (nightly and self-built instances have no matching tag). The base URL is configurable for
 * a mirror on a network without GitHub access.
 */

export const DEFAULT_SPEC_BASE_URL = 'https://raw.githubusercontent.com/seerr-team/seerr';
const SPEC_FILE = 'seerr-api.yml';
const FALLBACK_REF = 'develop';
const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** `3.4.1` → `v3.4.1`; anything that isn't a plain release version has no tag to try. */
export function tagFor(version: string): string | undefined {
  const v = version.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(v) ? `v${v}` : undefined;
}

async function fetchText(url: string): Promise<{ status: number; text?: string }> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new PluginError(ErrorCodes.UpstreamError, `Could not fetch the Seerr API spec from ${new URL(url).host}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { status: res.status };
  }
  const text = await res.text();
  if (text.length > MAX_SPEC_BYTES) throw new PluginError(ErrorCodes.UpstreamError, 'The Seerr API spec is too large');
  return { status: res.status, text };
}

/** Fetches the spec for `version`; returns its text and the git ref it came from. */
export async function fetchSpec(
  version: string,
  baseUrl: string = DEFAULT_SPEC_BASE_URL,
): Promise<{ text: string; ref: string }> {
  const base = baseUrl.replace(/\/+$/, '');
  const tag = tagFor(version);
  for (const ref of tag ? [tag, FALLBACK_REF] : [FALLBACK_REF]) {
    const { status, text } = await fetchText(`${base}/${ref}/${SPEC_FILE}`);
    if (text !== undefined) return { text, ref };
    if (status !== 404)
      throw new PluginError(ErrorCodes.UpstreamError, `Fetching the Seerr API spec failed: HTTP ${status}`);
  }
  throw new PluginError(ErrorCodes.UpstreamError, `No Seerr API spec found for ${tag ?? version} or ${FALLBACK_REF}`);
}
