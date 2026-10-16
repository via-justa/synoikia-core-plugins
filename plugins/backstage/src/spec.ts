import {
  DEFAULT_REF_BUDGET,
  ErrorCodes,
  HTTP_VERBS,
  isPlainObject,
  notify,
  parseOpenApi,
  PluginError,
  resolveRefs,
  SpecError,
  stringOr,
} from '@synoikia/plugin-sdk';
import type { HttpJsonClient } from '@synoikia/plugin-sdk';

/** One backend plugin's served spec. */
export interface PluginSpec {
  id: string;
  spec: string | Record<string, unknown>;
}

const PLUGIN_ID = /^[a-z0-9-]+$/;

/** The connection's `pluginIds`, or the defaults; each one must be a plain plugin ID. */
export function pluginIdsOf(config: Record<string, unknown>, defaults: readonly string[]): string[] {
  const value = config.pluginIds ?? defaults;
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every((id): id is string => typeof id === 'string' && PLUGIN_ID.test(id))
  )
    throw new PluginError(ErrorCodes.InvalidParams, '`pluginIds` must be a list of backend plugin IDs ([a-z0-9-]+)');
  return [...new Set(value)];
}

/** Fetches each plugin's spec; one that is not installed (404) is skipped with a warning, but none at all fails. */
export async function loadSpecs(
  client: HttpJsonClient,
  ids: readonly string[],
  specPath: string,
  service: string,
): Promise<PluginSpec[]> {
  const specs: PluginSpec[] = [];
  for (const id of ids) {
    let spec: unknown;
    try {
      spec = await client.request('GET', `/api/${id}${specPath}`);
    } catch (err) {
      if (err instanceof PluginError && isPlainObject(err.data) && err.data.status === 404) {
        notify({
          method: 'log',
          params: { level: 'warn', message: `${service} plugin "${id}" serves no spec; skipped` },
        });
        continue;
      }
      throw err;
    }
    if (typeof spec !== 'string' && !isPlainObject(spec))
      throw new PluginError(ErrorCodes.UpstreamError, `${service} plugin "${id}" served no OpenAPI spec`);
    specs.push({ id, spec });
  }
  if (!specs.length)
    throw new PluginError(ErrorCodes.UpstreamError, `No ${service} plugin served a spec (${ids.join(', ')})`);
  return specs;
}

/** One spec from the per-plugin ones: refs resolved per spec (their components may clash), untagged operations
 * tagged with their plugin, and every path kept under its own `/api/<id>` so one plugin's spec cannot
 * describe, or unlock, another's routes. */
export function mergeSpecs(specs: readonly PluginSpec[], service: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const budget = { left: DEFAULT_REF_BUDGET };
  let version: string | undefined;
  for (const { id, spec } of specs) {
    const doc = parseOpenApi(spec, `${service} ${id}`);
    const prefix = `/api/${id}`;
    const own = isPlainObject(doc.paths) ? doc.paths : {};
    for (const [path, item] of Object.entries(own)) {
      if (path !== prefix && !path.startsWith(`${prefix}/`))
        throw new SpecError(`The ${service} ${id} API spec has a path outside ${prefix}; refusing it`);
      const resolved = resolveRefs(doc, item, 0, [], budget);
      // Untagged operations (all but the catalog's) group under their plugin.
      if (isPlainObject(resolved))
        for (const verb of HTTP_VERBS) {
          const op = resolved[verb.toLowerCase()];
          if (isPlainObject(op) && !Array.isArray(op.tags)) op.tags = [id];
        }
      paths[path] = resolved;
    }
    version ??= isPlainObject(doc.info) ? stringOr(doc.info.version) : undefined;
  }
  return { openapi: '3.1.0', info: { title: service, version: version ?? '0' }, paths };
}

/** The version the first loaded plugin's spec reports (Backstage has no version endpoint). */
export function specVersion(merged: Record<string, unknown>): string {
  return (isPlainObject(merged.info) && stringOr(merged.info.version)) || '0';
}
