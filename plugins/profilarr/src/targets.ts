import { isPlainObject, stringOr, truncate } from '@synoikia/plugin-sdk';
import type { HttpJsonClient, ResolvedTarget } from '@synoikia/plugin-sdk';

/** Text with the control, bidi and zero-width characters JSON leaves raw escaped; `safe` also makes it one line. */
const visible = (text: string) =>
  text.replace(
    /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
const safe = (text: string) => visible(JSON.stringify(truncate(text, 200)).slice(1, -1));

/** The stored database a non-GET call on `/databases/{id}…` acts on, named with its repository so the
 * approver sees what is synced; no target when it can't be read (the summary then shows the path id). */
export async function databaseTargets(
  client: HttpJsonClient,
  key: string,
  params: unknown,
  timeoutMs: number,
): Promise<ResolvedTarget[]> {
  if (key.startsWith('GET ') || !key.includes(' /databases/{id}')) return [];
  const path = isPlainObject(params) && isPlainObject(params.path) ? params.path : {};
  const id = stringOr(path.id);
  if (!id) return [];
  let db: unknown;
  try {
    db = await client.request('GET', `/databases/${encodeURIComponent(id)}`, { timeoutMs });
  } catch {
    return [];
  }
  if (!isPlainObject(db)) return [];
  const name = safe(stringOr(db.name) ?? id);
  const repo = stringOr(db.repository_url);
  return [{ kind: 'database', id, name: repo ? `${name} (${safe(repo)})` : name }];
}

/** The approval text with the targets it acts on. */
export const withTargets = (text: string, targets: readonly ResolvedTarget[]) =>
  visible(targets.length ? `${text} on ${targets.map((t) => t.name).join(', ')}` : text);
