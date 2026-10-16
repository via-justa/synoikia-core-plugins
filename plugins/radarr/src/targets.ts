import { isPlainObject, stringOr } from '@synoikia/plugin-sdk';
import type { HttpJsonClient, ResolvedTarget } from '@synoikia/plugin-sdk';
import { destinations, safe } from './fields.js';

/** What a non-GET call acts on, for the approver: the stored movie(s) by title, year and folder, a provider
 * connection by name with the hosts it sends to, the import script a media management change runs, or a root
 * folder. Lookups that fail leave the id (fail visible, not closed). */

const MAX_MOVIES = 10;
const PROVIDER = /^(POST|PUT|DELETE) \/api\/v3\/(downloadclient|indexer|importlist|notification|metadata)(\/|$|#)/;

type Get = (path: string) => Promise<unknown>;

async function fetchObject(get: Get, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const row = await get(path);
    return isPlainObject(row) ? row : undefined;
  } catch {
    return undefined;
  }
}

async function movie(get: Get, id: string): Promise<ResolvedTarget> {
  const m = await fetchObject(get, `/api/v3/movie/${encodeURIComponent(id)}`);
  if (!m) return { kind: 'movie', id, name: `movie ${safe(id) ?? '?'}` };
  const year = typeof m.year === 'number' && m.year > 0 ? ` (${m.year})` : '';
  const path = safe(m.path);
  return { kind: 'movie', id, name: `${safe(m.title) ?? id}${year}${path ? ` at ${path}` : ''}` };
}

async function provider(get: Get, resource: string, body: unknown, id: string | undefined): Promise<ResolvedTarget[]> {
  let source = body;
  if (!isPlainObject(body) || !Array.isArray(body.fields)) {
    if (!id) return [];
    try {
      source = await get(`/api/v3/${resource}/${encodeURIComponent(id)}`);
    } catch {
      return [{ kind: resource, id, name: `${resource} ${safe(id) ?? '?'}` }];
    }
  }
  if (!isPlainObject(source)) return [];
  const name = safe(source.name) ?? safe(id) ?? 'new';
  const impl = safe(source.implementation);
  let to = destinations(source);
  // A body that names no destination keeps the stored one.
  if (!to.length && source === body && id) {
    try {
      to = destinations(await get(`/api/v3/${resource}/${encodeURIComponent(id)}`));
    } catch {
      to = [];
    }
  }
  return [
    {
      kind: resource,
      id: id ?? 'new',
      name: `${resource} ${name}${impl ? ` (${impl})` : ''}${to.length ? ` → ${to.join(', ')}` : ''}`,
    },
  ];
}

export async function resolveTargets(
  client: HttpJsonClient,
  key: string,
  params: unknown,
  timeoutMs: number,
): Promise<ResolvedTarget[]> {
  if (key.startsWith('GET ')) return [];
  const get: Get = (path) => client.request('GET', path, { timeoutMs });
  const p = isPlainObject(params) ? params : {};
  const pathParams = isPlainObject(p.path) ? p.path : {};
  const body = p.body;
  if (key.startsWith('PUT /api/v3/config/mediamanagement/{id}')) {
    // Servarr keeps the stored value for a field the body leaves out, sends as null or, for the path, empty.
    const set = (k: string) => isPlainObject(body) && body[k] !== undefined && body[k] !== null && body[k] !== '';
    if (!set('useScriptImport') && !set('scriptImportPath')) return [];
    const b = body as Record<string, unknown>;
    const stored =
      set('useScriptImport') && set('scriptImportPath')
        ? {}
        : ((await fetchObject(get, '/api/v3/config/mediamanagement')) ?? {});
    const on = (set('useScriptImport') ? b.useScriptImport : stored.useScriptImport) === true;
    const path = safe(set('scriptImportPath') ? b.scriptImportPath : stored.scriptImportPath) || '(none)';
    return [{ kind: 'script', id: 'scriptImportPath', name: `import script ${on ? 'on' : 'off'}: ${path}` }];
  }
  if (key.startsWith('POST /api/v3/rootfolder') && isPlainObject(body)) {
    const path = safe(body.path);
    return path ? [{ kind: 'folder', id: 'path', name: `root folder ${path}` }] : [];
  }
  if (key.startsWith('PUT /api/v3/rootfolder/{id}')) {
    const id = stringOr(pathParams.id);
    if (!id) return [];
    const stored = await fetchObject(get, `/api/v3/rootfolder/${encodeURIComponent(id)}`);
    const from = safe(stored?.path) ?? safe(id) ?? '?';
    const to = isPlainObject(body) ? safe(body.path) : undefined;
    return [{ kind: 'folder', id, name: `root folder ${from}${to ? ` → ${to}` : ''}` }];
  }
  if (/^(PUT|DELETE) \/api\/v3\/movie\/\{id\}/.test(key)) {
    const id = stringOr(pathParams.id);
    if (!id) return [];
    const target = await movie(get, id);
    const to = isPlainObject(body) ? safe(body.path) : undefined;
    return [to ? { ...target, name: `${target.name} → ${to}` } : target];
  }
  if (key.includes(' /api/v3/movie/editor')) {
    const ids = isPlainObject(body) && Array.isArray(body.movieIds) ? body.movieIds.map(stringOr) : [];
    const known = ids.filter((id): id is string => id !== undefined);
    const shown = await Promise.all(known.slice(0, MAX_MOVIES).map((id) => movie(get, id)));
    const more = known.length - shown.length;
    const to = isPlainObject(body) ? safe(body.rootFolderPath) : undefined;
    return [
      ...shown,
      ...(more > 0 ? [{ kind: 'movie', id: 'more', name: `${more} more movies` }] : []),
      ...(to ? [{ kind: 'folder', id: 'rootFolderPath', name: `into ${to}` }] : []),
    ];
  }
  const match = PROVIDER.exec(key);
  if (match) {
    const id = stringOr(pathParams.id) ?? (isPlainObject(body) ? stringOr(body.id) : undefined);
    return provider(get, match[2]!, body, id && id !== '0' ? id : undefined);
  }
  if (key.startsWith('POST /api/v3/release/push') && isPlainObject(body)) {
    const from = [body.downloadUrl, body.magnetUrl].map((u) => safe(originOrScheme(u))).find(Boolean);
    return [{ kind: 'release', id: 'push', name: `${safe(body.title) ?? 'release'}${from ? ` from ${from}` : ''}` }];
  }
  return [];
}

/** `magnet:?xt=…` has no host: say it is a magnet link. */
function originOrScheme(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^magnet:/i.test(value)) return 'a magnet link';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/** The approval text with what it acts on placed right after the method and path, ahead of the (truncated) body,
 * so a long body can't push the destination out of view. */
export function withTargets(text: string, targets: readonly ResolvedTarget[]): string {
  if (!targets.length) return text;
  const head = text.split(' ', 3).join(' ');
  return `${head} on ${targets.map((t) => t.name).join('; ')}${text.slice(head.length)}`;
}
