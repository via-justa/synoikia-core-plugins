import { ErrorCodes, fetchSpec, isPlainObject, PluginError, stringOr } from '@synoikia/plugin-sdk';

/** A catalog built from the first spec source that serves a usable spec, the host it came from, and the spec's
 * `info.version`. */
export interface LoadedSpec<C> {
  catalog: C;
  source: string;
  version: string;
}

/** Tries each URL in order (no credentials sent); a source that fails to download or yields no usable catalog
 * moves on to the next, and the error names every failure. */
export async function loadSpec<C>(
  urls: readonly string[],
  build: (spec: Record<string, unknown>) => C,
  opts: { service: string; maxBytes: number; timeoutMs: number },
): Promise<LoadedSpec<C>> {
  const failures: string[] = [];
  for (const url of urls) {
    const source = new URL(url).host;
    try {
      const { text } = await fetchSpec({
        service: opts.service,
        candidates: [{ url, ref: source }],
        maxBytes: opts.maxBytes,
        timeoutMs: opts.timeoutMs,
      });
      let spec: unknown;
      try {
        spec = JSON.parse(text);
      } catch {
        throw new Error(`The ${opts.service} API spec is not JSON`);
      }
      if (!isPlainObject(spec)) throw new Error(`The ${opts.service} API spec is not an object`);
      const info = isPlainObject(spec.info) ? spec.info : {};
      return { catalog: build(spec), source, version: stringOr(info.version) ?? 'unknown' };
    } catch (err) {
      failures.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new PluginError(ErrorCodes.UpstreamError, `No usable ${opts.service} API spec (${failures.join('; ')})`);
}
