import { baseKey, fillTemplate, isPlainObject, queryString, readPointer, truncate } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';

/** Longest field value shown. */
const MAX_VALUE = 300;

/** JSON text with the control, bidi and zero-width characters JSON leaves raw escaped too, so a model-written
 * value can't hide or reorder what the approver reads. */
const visible = (json: string) =>
  json.replace(
    /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** A string as one visible line; quotes stay as they are. */
export const safe = (text: string) => visible(JSON.stringify(text).slice(1, -1).replaceAll('\\"', '"'));

/** A body value as JSON on one visible line. */
const shown = (v: unknown) => truncate(visible(JSON.stringify(v)), MAX_VALUE);

/** Puts the body's privilege and destination fields right after `Grafana Cloud VERB /path?query`, ahead of
 * the truncated body, so padding the body cannot push them past the summary's cut. */
export function withFields(text: string, service: string, key: string, params: unknown, pointers: readonly string[]) {
  const p = isPlainObject(params) ? params : {};
  const fields = pointers.flatMap((pointer) => {
    const v = readPointer(p.body, pointer);
    return v === undefined || v === null || v === '' ? [] : [`${pointer.slice(1)}=${shown(v)}`];
  });
  if (!fields.length) return text;
  const [method = '', template = ''] = baseKey(key).split(' ');
  let path = template;
  try {
    path = fillTemplate(template, isPlainObject(p.path) ? p.path : {});
  } catch {
    // the binding keeps the template too
  }
  const head = `${service} ${method} ${path}${queryString(isPlainObject(p.query) ? p.query : undefined)}`;
  const list = ` [${fields.join(', ')}]`;
  return text.startsWith(head) ? `${head}${list}${text.slice(head.length)}` : `${head}${list} ${text}`;
}

/** The approval text with the stored records it acts on. */
export const withTargets = (text: string, targets: readonly ResolvedTarget[]) =>
  targets.length ? `${text} on ${targets.map((t) => t.name).join(', ')}` : text;
