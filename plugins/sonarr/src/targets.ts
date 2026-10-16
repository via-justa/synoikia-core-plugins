import { isPlainObject, stringOr } from '@synoikia/plugin-sdk';
import type { HttpJsonClient, ResolvedTarget } from '@synoikia/plugin-sdk';
import { destinations, safe } from './fields.js';

/** What a non-GET call acts on, for the approver: the stored series by title, year and folder, episode files by
 * series and file name, a provider connection by name with the hosts it sends to, the import script a media
 * management change runs, or a new root folder. Lookups that fail leave the id
 * (fail visible, not closed). */

const MAX_ITEMS = 10;
const PROVIDER = /^(POST|PUT|DELETE) \/api\/v3\/(downloadclient|indexer|importlist|notification|metadata)(\/|$|#)/;

type Get = (path: string) => Promise<unknown>;

async function fetchRow(get: Get, resource: string, id: string): Promise<Record<string, unknown> | undefined> {
  try {
    const row = await get(`/api/v3/${resource}/${encodeURIComponent(id)}`);
    return isPlainObject(row) ? row : undefined;
  } catch {
    return undefined;
  }
}

/** The stored media management settings, for the import-script fields a body leaves out. */
async function fetchConfig(get: Get): Promise<Record<string, unknown>> {
  try {
    const config = await get('/api/v3/config/mediamanagement');
    return isPlainObject(config) ? config : {};
  } catch {
    return {};
  }
}

function seriesName(s: Record<string, unknown>, id: string): string {
  const year = typeof s.year === 'number' && s.year > 0 ? ` (${s.year})` : '';
  return `${safe(s.title) ?? id}${year}`;
}

async function series(get: Get, id: string): Promise<ResolvedTarget> {
  const s = await fetchRow(get, 'series', id);
  if (!s) return { kind: 'series', id, name: `series ${safe(id) ?? '?'}` };
  const path = safe(s.path);
  return { kind: 'series', id, name: `${seriesName(s, id)}${path ? ` at ${path}` : ''}` };
}

async function episodeFile(get: Get, id: string): Promise<ResolvedTarget> {
  const f = await fetchRow(get, 'episodefile', id);
  if (!f) return { kind: 'episodefile', id, name: `episode file ${safe(id) ?? '?'}` };
  const seriesId = stringOr(f.seriesId);
  const s = seriesId ? await fetchRow(get, 'series', seriesId) : undefined;
  const file = safe(f.path) ?? safe(f.relativePath) ?? id;
  return { kind: 'episodefile', id, name: `${s ? `${seriesName(s, seriesId!)}: ` : ''}${file}` };
}

/** Up to MAX_ITEMS looked up, then `<n> more`. */
async function some(ids: unknown[], kind: string, noun: string, one: (id: string) => Promise<ResolvedTarget>) {
  const known = ids.map(stringOr).filter((id): id is string => id !== undefined);
  const shown = await Promise.all(known.slice(0, MAX_ITEMS).map(one));
  const more = ids.length - shown.length;
  return [...shown, ...(more > 0 ? [{ kind, id: 'more', name: `${more} more ${noun}` }] : [])];
}

/** A season pass item's `id`, read as Sonarr binds it (any case); two spellings make it unknown. */
function itemId(item: unknown): unknown {
  if (!isPlainObject(item)) return undefined;
  const ids = Object.keys(item).filter((k) => k.toLowerCase() === 'id');
  return ids.length === 1 ? item[ids[0]!] : undefined;
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
    const stored = set('useScriptImport') && set('scriptImportPath') ? {} : await fetchConfig(get);
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
    const stored = await fetchRow(get, 'rootfolder', id);
    const from = safe(stored?.path) ?? safe(id) ?? '?';
    const to = isPlainObject(body) ? safe(body.path) : undefined;
    return [{ kind: 'folder', id, name: `root folder ${from}${to ? ` → ${to}` : ''}` }];
  }
  if (/^(PUT|DELETE) \/api\/v3\/series\/\{id\}/.test(key)) {
    const id = stringOr(pathParams.id);
    if (!id) return [];
    const target = await series(get, id);
    const to = isPlainObject(body) ? safe(body.path) : undefined;
    return [to ? { ...target, name: `${target.name} → ${to}` } : target];
  }
  if (key.includes(' /api/v3/series/editor')) {
    const ids = isPlainObject(body) && Array.isArray(body.seriesIds) ? body.seriesIds : [];
    const to = isPlainObject(body) ? safe(body.rootFolderPath) : undefined;
    return [
      ...(await some(ids, 'series', 'series', (id) => series(get, id))),
      ...(to ? [{ kind: 'folder', id: 'rootFolderPath', name: `into ${to}` }] : []),
    ];
  }
  if (key.startsWith('POST /api/v3/seasonpass')) {
    const items = isPlainObject(body) && Array.isArray(body.series) ? body.series : [];
    return some(items.map(itemId), 'series', 'series', (id) => series(get, id));
  }
  if (key.startsWith('DELETE /api/v3/episodefile/{id}')) {
    const id = stringOr(pathParams.id);
    return id ? [await episodeFile(get, id)] : [];
  }
  if (key.startsWith('DELETE /api/v3/episodefile/bulk')) {
    const ids = isPlainObject(body) && Array.isArray(body.episodeFileIds) ? body.episodeFileIds : [];
    return some(ids, 'episodefile', 'episode files', (id) => episodeFile(get, id));
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
