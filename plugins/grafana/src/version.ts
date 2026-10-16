import { ErrorCodes, isPlainObject, PluginError, readPointer, stringOr } from '@synoikia/plugin-sdk';
import type { HttpJsonClient } from '@synoikia/plugin-sdk';

/** The version from the first source that reports one, refused below `minMajor`. */
export async function grafanaVersion(
  client: HttpJsonClient,
  sources: readonly { path: string; field: string }[],
  minMajor: number,
): Promise<string> {
  let version: string | undefined;
  for (const { path, field } of sources) {
    const body = await client.request('GET', path);
    version = isPlainObject(body) ? stringOr(readPointer(body, field)) : undefined;
    if (version) break;
  }
  if (!version) throw new PluginError(ErrorCodes.UpstreamError, 'Grafana reported no version');
  const major = /^v?(\d+)\./.exec(version)?.[1];
  if (!major || Number(major) < minMajor)
    throw new PluginError(
      ErrorCodes.UpstreamError,
      `Grafana ${version} is not supported; this plugin needs Grafana ${minMajor} or later`,
    );
  return version;
}
