import { isPlainObject, stringOr } from '@synoikia/plugin-sdk';
import type { HttpJsonClient, ResolvedTarget } from '@synoikia/plugin-sdk';
import { destinations, safe } from './fields.js';

/** What a non-GET call acts on, for the approver: the stored artist(s) by name and folder, an album by title and
 * artist, track files by path, or a provider connection by name with the hosts it sends to. Lookups that fail
 * leave the id (fail visible, not closed). */

const MAX_ITEMS = 10;
const PROVIDER = /^(POST|PUT|DELETE) \/api\/v1\/(downloadclient|indexer|importlist|notification|metadata)(\/|$|#)/;

type Get = (path: string) => Promise<unknown>;

const tryGet = async (get: Get, path: string): Promise<unknown> => {
  try {
    return await get(path);
  } catch {
    return undefined;
  }
};

async function storedConfig(get: Get): Promise<Record<string, unknown>> {
  const config = await tryGet(get, '/api/v1/config/mediamanagement');
  return isPlainObject(config) ? config : {};
}

async function artist(get: Get, id: string): Promise<ResolvedTarget> {
  const a = await tryGet(get, `/api/v1/artist/${encodeURIComponent(id)}`);
  if (!isPlainObject(a)) return { kind: 'artist', id, name: `artist ${safe(id) ?? '?'}` };
  const path = safe(a.path);
  return { kind: 'artist', id, name: `${safe(a.artistName) ?? id}${path ? ` at ${path}` : ''}` };
}

async function album(get: Get, id: string): Promise<ResolvedTarget> {
  const a = await tryGet(get, `/api/v1/album/${encodeURIComponent(id)}`);
  if (!isPlainObject(a)) return { kind: 'album', id, name: `album ${safe(id) ?? '?'}` };
  const by = isPlainObject(a.artist) ? safe(a.artist.artistName) : undefined;
  return { kind: 'album', id, name: `${safe(a.title) ?? id}${by ? ` by ${by}` : ''}` };
}

async function trackFile(get: Get, id: string): Promise<ResolvedTarget> {
  const f = await tryGet(get, `/api/v1/trackfile/${encodeURIComponent(id)}`);
  const path = isPlainObject(f) ? safe(f.path) : undefined;
  return { kind: 'trackfile', id, name: path ?? `track file ${safe(id) ?? '?'}` };
}

/** Up to MAX_ITEMS looked up, then a count of the rest. */
async function several(ids: unknown, noun: string, one: (id: string) => Promise<ResolvedTarget>) {
  const known = (Array.isArray(ids) ? ids.map(stringOr) : []).filter((id): id is string => id !== undefined);
  const shown = await Promise.all(known.slice(0, MAX_ITEMS).map(one));
  const more = known.length - shown.length;
  return [...shown, ...(more > 0 ? [{ kind: noun, id: 'more', name: `${more} more ${noun}s` }] : [])];
}

async function provider(get: Get, resource: string, body: unknown, id: string | undefined): Promise<ResolvedTarget[]> {
  let source = body;
  if (!isPlainObject(body) || !Array.isArray(body.fields)) {
    if (!id) return [];
    try {
      source = await get(`/api/v1/${resource}/${encodeURIComponent(id)}`);
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
      to = destinations(await get(`/api/v1/${resource}/${encodeURIComponent(id)}`));
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
  if (/^(PUT|DELETE) \/api\/v1\/artist\/\{id\}/.test(key)) {
    const id = stringOr(pathParams.id);
    if (!id) return [];
    const target = await artist(get, id);
    const to = isPlainObject(body) ? safe(body.path) : undefined;
    return [to ? { ...target, name: `${target.name} → ${to}` } : target];
  }
  if (key.includes(' /api/v1/artist/editor')) {
    const b = isPlainObject(body) ? body : {};
    const to = safe(b.rootFolderPath);
    return [
      ...(await several(b.artistIds, 'artist', (id) => artist(get, id))),
      ...(to ? [{ kind: 'folder', id: 'rootFolderPath', name: `into ${to}` }] : []),
    ];
  }
  if (/^(PUT|DELETE) \/api\/v1\/album\/\{id\}/.test(key)) {
    const id = stringOr(pathParams.id);
    return id ? [await album(get, id)] : [];
  }
  if (key === 'DELETE /api/v1/trackfile/{id}') {
    const id = stringOr(pathParams.id);
    return id ? [await trackFile(get, id)] : [];
  }
  if (key === 'DELETE /api/v1/trackfile/bulk')
    return several(isPlainObject(body) ? body.trackFileIds : undefined, 'track file', (id) => trackFile(get, id));
  if (key.startsWith('PUT /api/v1/config/mediamanagement/{id}')) {
    // Servarr keeps the stored value for a field the body leaves out, sends as null or, for the path, empty.
    const set = (k: string) => isPlainObject(body) && body[k] !== undefined && body[k] !== null && body[k] !== '';
    if (!set('useScriptImport') && !set('scriptImportPath')) return [];
    const b = body as Record<string, unknown>;
    const stored = set('useScriptImport') && set('scriptImportPath') ? {} : await storedConfig(get);
    const on = (set('useScriptImport') ? b.useScriptImport : stored.useScriptImport) === true;
    const path = safe(set('scriptImportPath') ? b.scriptImportPath : stored.scriptImportPath) || '(none)';
    return [{ kind: 'script', id: 'scriptImportPath', name: `import script ${on ? 'on' : 'off'}: ${path}` }];
  }
  if (/^(POST|PUT) \/api\/v1\/rootfolder(\/|$)/.test(key) && isPlainObject(body)) {
    const path = safe(body.path);
    return path ? [{ kind: 'folder', id: 'path', name: `root folder ${path}` }] : [];
  }
  const match = PROVIDER.exec(key);
  if (match) {
    const id = stringOr(pathParams.id) ?? (isPlainObject(body) ? stringOr(body.id) : undefined);
    return provider(get, match[2]!, body, id && id !== '0' ? id : undefined);
  }
  if (key.startsWith('POST /api/v1/release/push') && isPlainObject(body)) {
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
