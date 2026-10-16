import { isPlainObject, stringOr } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import { metadataRows } from './catalog.js';
import type { Get } from './catalog.js';

/** What a write acts on, for the approver: the library section, items, playlist or session by name, the settings a
 * prefs write changes, and the origin of a URL Plex fetches. Lookups that fail leave the id (fail visible). */

const MAX_ITEMS = 10;

/** A string as one visible line: control, bidi and zero-width characters escaped. */
export function safe(value: unknown): string | undefined {
  const text = stringOr(value);
  if (text === undefined) return undefined;
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

const field = (value: unknown, key: string) => (isPlainObject(value) && isPlainObject(value[key]) ? value[key] : {});

const tryGet = async (get: Get, path: string) => {
  try {
    return await get(path);
  } catch {
    return undefined;
  }
};

function itemName(m: Record<string, unknown>): string {
  const show = safe(m.grandparentTitle) ?? safe(m.parentTitle);
  const title = safe(m.title) ?? safe(m.ratingKey) ?? '?';
  const year = typeof m.year === 'number' && m.year > 0 ? ` (${m.year})` : '';
  const type = safe(m.type);
  return `${show ? `${show} – ` : ''}${title}${year}${type ? ` [${type}]` : ''}`;
}

async function items(get: Get, ids: string): Promise<ResolvedTarget[]> {
  const list = ids.split(',').filter(Boolean);
  const shown = list.slice(0, MAX_ITEMS);
  const rows = metadataRows(await tryGet(get, `/library/metadata/${shown.map(encodeURIComponent).join(',')}`));
  const out = shown.map((id): ResolvedTarget => {
    const row = rows.find((m) => stringOr(m.ratingKey) === id);
    return { kind: 'item', id, name: row ? itemName(row) : `item ${safe(id) ?? '?'}` };
  });
  const more = list.length - shown.length;
  return more > 0 ? [...out, { kind: 'item', id: 'more', name: `${more} more items` }] : out;
}

async function sectionTarget(get: Get, id: string): Promise<ResolvedTarget> {
  const res = await tryGet(get, `/library/sections/${encodeURIComponent(id)}`);
  const title = safe(field(res, 'MediaContainer').title1);
  return { kind: 'library', id, name: `library ${title ?? safe(id) ?? '?'}` };
}

async function playlist(get: Get, id: string): Promise<ResolvedTarget> {
  const [row] = metadataRows(await tryGet(get, `/playlists/${encodeURIComponent(id)}`));
  return { kind: 'playlist', id, name: `playlist ${safe(row?.title) ?? safe(id) ?? '?'}` };
}

async function session(get: Get, id: string): Promise<ResolvedTarget> {
  const row = metadataRows(await tryGet(get, '/status/sessions')).find((m) => stringOr(field(m, 'Session').id) === id);
  if (!row) return { kind: 'session', id, name: `session ${safe(id) ?? '?'}` };
  const user = safe(field(row, 'User').title) ?? 'someone';
  const player = safe(field(row, 'Player').title);
  return { kind: 'session', id, name: `${user} playing ${itemName(row)}${player ? ` on ${player}` : ''}` };
}

/** `https://user:pw@host/path?token` → `https://host`; another scheme is named, not shown. */
function origin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return 'a value that is not a URL';
  }
}

/** The setting names a prefs write changes (`prefs[name]` counts as `name`). */
function settingNames(query: Record<string, unknown>): string[] {
  return Object.keys(query).map((k) => safe(k.replace(/^prefs\[(.*)\]$/, '$1')) ?? '?');
}

export async function resolveTargets(get: Get, key: string, params: unknown): Promise<ResolvedTarget[]> {
  const p = isPlainObject(params) ? params : {};
  const path = isPlainObject(p.path) ? p.path : {};
  const query = isPlainObject(p.query) ? p.query : {};
  const out: ResolvedTarget[] = [];
  const pathId = (name: string) => stringOr(path[name]);

  if (key.startsWith('PUT /:/prefs'))
    out.push({ kind: 'settings', id: 'prefs', name: `settings ${settingNames(query).join(', ')}` });
  else if (key.includes(' /library/sections/{sectionId}/collection/{collectionId}') && pathId('collectionId'))
    out.push(...(await items(get, pathId('collectionId')!)));
  else if (key.includes(' /library/sections/{sectionId}') && pathId('sectionId'))
    out.push(await sectionTarget(get, pathId('sectionId')!));
  else if (key.includes(' /library/metadata/{ids}') && pathId('ids')) out.push(...(await items(get, pathId('ids')!)));
  else if (key.includes(' /playlists/{playlistId}') && pathId('playlistId'))
    out.push(await playlist(get, pathId('playlistId')!));
  else if (key.startsWith('DELETE /playlists') && stringOr(query.ratingKey))
    out.push(await playlist(get, stringOr(query.ratingKey)!));
  else if (key.startsWith('POST /status/sessions/terminate') && stringOr(query.sessionId))
    out.push(await session(get, stringOr(query.sessionId)!));

  const to = origin(query.url);
  if (query.url !== undefined && to) out.push({ kind: 'url', id: 'url', name: `fetches ${safe(to) ?? '?'}` });
  const device = key.startsWith('POST /media/grabbers/devices') ? origin(query.uri) : undefined;
  if (query.uri !== undefined && device)
    out.push({ kind: 'url', id: 'uri', name: `connects to ${safe(device) ?? '?'}` });
  return out;
}

/** The approval text with what it acts on placed right after the method and path, ahead of the query and notes, so
 * a long query can't push it out of view. */
export function withTargets(text: string, targets: readonly ResolvedTarget[]): string {
  if (!targets.length) return text;
  const head = /^\S+ \S+ [^\s?]*/.exec(text)?.[0] ?? '';
  const rest = text.slice(head.length).trimStart();
  return `${head} on ${targets.map((t) => t.name).join('; ')}${rest ? ` ${rest}` : ''}`;
}
