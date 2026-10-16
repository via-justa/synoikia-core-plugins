import { ErrorCodes, isPlainObject, PluginError, readPointer, stringOr } from '@synoikia/plugin-sdk';
import type { HttpJsonClient, ResolvedTarget } from '@synoikia/plugin-sdk';
import { hostOf, safe } from './summary.js';

/** Most data sources one `POST /ds/query` may name; more are refused rather than shown in part. */
const MAX_QUERY_SOURCES = 20;

/** A data source named with its type and URL, so the approver sees where its queries go; undefined when it
 * can't be read. */
async function dataSource(client: HttpJsonClient, path: string, id: string | undefined, timeoutMs: number) {
  let ds: unknown;
  try {
    ds = await client.request('GET', path, { timeoutMs });
  } catch {
    return undefined;
  }
  if (!isPlainObject(ds)) return undefined;
  const key = id ?? stringOr(ds.uid);
  if (!key) return undefined;
  const name = safe(stringOr(ds.name) ?? key);
  const detail = [stringOr(ds.type), stringOr(ds.url)].flatMap((v) => (v ? [safe(v)] : [])).join(', ');
  return { kind: 'datasource', id: key, name: detail ? `${name} (${detail})` : name } satisfies ResolvedTarget;
}

/** Body pointers the targets and destinations read; anything under `queries` is checked whole. */
export const TARGET_FIELDS = ['/queries/*/datasource/uid', '/queries/*/datasourceId', '/settings/url'];
export const STRICT_FIELDS = ['/queries'];

/** What a call acts on: the stored data source of a non-GET `/datasources/{id}` or `/datasources/uid/{uid}`
 * call, every data source a `POST /ds/query` names (an unreadable one by its uid), or the host a contact
 * point's `settings.url` posts to. */
export async function resolveTargets(
  client: HttpJsonClient,
  key: string,
  params: unknown,
  timeoutMs: number,
): Promise<ResolvedTarget[]> {
  if (key.startsWith('GET ')) return [];
  const p = isPlainObject(params) ? params : {};

  if (key === 'POST /ds/query') {
    const queries = readPointer(p.body, '/queries');
    const refs = new Map<string, string>();
    for (const q of Array.isArray(queries) ? queries : []) {
      const ds = readPointer(q, '/datasource');
      const uid = stringOr(readPointer(ds, '/uid'));
      if (uid) refs.set(`uid/${encodeURIComponent(uid)}`, uid);
      else if (typeof ds === 'string' && ds) refs.set(`name/${encodeURIComponent(ds)}`, ds);
      else if (ds !== undefined && ds !== null && !isPlainObject(ds))
        throw new PluginError(ErrorCodes.TargetResolutionFailed, 'POST /ds/query names a data source it cannot read');
      const id = readPointer(q, '/datasourceId');
      if (typeof id === 'number' || (typeof id === 'string' && id))
        refs.set(encodeURIComponent(String(id)), `id ${id}`);
      else if (id !== undefined && id !== null)
        throw new PluginError(ErrorCodes.TargetResolutionFailed, 'POST /ds/query names a data source it cannot read');
    }
    if (refs.size > MAX_QUERY_SOURCES)
      throw new PluginError(
        ErrorCodes.TargetResolutionFailed,
        `POST /ds/query names ${refs.size} data sources; the limit is ${MAX_QUERY_SOURCES}`,
      );
    const resolved = await Promise.all(
      [...refs].map(async ([ref, label]): Promise<ResolvedTarget> => {
        const uid = ref.startsWith('uid/') ? label : undefined;
        const found = await dataSource(client, `/datasources/${ref}`, uid, timeoutMs);
        if (found) return found;
        // An unknown uid is shown as itself; a name or id that can't be read has no uid to scope rules on.
        if (uid) return { kind: 'datasource', id: uid, name: safe(uid) };
        throw new PluginError(
          ErrorCodes.TargetResolutionFailed,
          `POST /ds/query names data source ${safe(label)}, which can't be read`,
        );
      }),
    );
    return [...new Map(resolved.map((t) => [t.id, t])).values()];
  }

  if (key === 'POST /v1/provisioning/contact-points' || key === 'PUT /v1/provisioning/contact-points/{UID}') {
    const url = readPointer(p.body, '/settings/url');
    if (url === undefined || url === null || url === '') return [];
    const host = hostOf(url);
    return [{ kind: 'destination', id: host, name: `${host} (contact point URL)` }];
  }

  const byUid = key.includes(' /datasources/uid/{uid}');
  if (!byUid && !key.includes(' /datasources/{id}')) return [];
  const path = isPlainObject(p.path) ? p.path : {};
  const id = stringOr(byUid ? path.uid : path.id);
  if (!id) return [];
  const target = await dataSource(
    client,
    `/datasources/${byUid ? 'uid/' : ''}${encodeURIComponent(id)}`,
    id,
    timeoutMs,
  );
  return target ? [target] : [];
}

/** The approval text with the targets it acts on. */
export const withTargets = (text: string, targets: readonly ResolvedTarget[]) =>
  targets.length ? `${text} on ${targets.map((t) => t.name).join(', ')}` : text;
