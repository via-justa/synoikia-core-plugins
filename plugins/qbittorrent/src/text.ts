import { truncate } from '@synoikia/plugin-sdk';

/** A string as one visible line: control, bidi and zero-width characters escaped. */
export function safe(value: unknown, max = 200): string {
  return JSON.stringify(truncate(String(value), max))
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

/** `"value"`, escaped. */
export const quote = (value: unknown, max?: number) => `"${safe(value, max)}"`;

/** `"a", "b" and 3 more`. */
export function quotedList(values: readonly unknown[], max: number): string {
  const shown = values.slice(0, max).map((v) => quote(v));
  return values.length > max ? `${shown.join(', ')} and ${values.length - max} more` : shown.join(', ');
}
