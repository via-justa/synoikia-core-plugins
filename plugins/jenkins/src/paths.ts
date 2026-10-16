import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';

/** Longest job full name accepted. */
const MAX_NAME = 1024;
const NUMBER = /^[1-9]\d{0,9}$/;
const CONTROL = /\p{Cc}/u;
/** Characters Jenkins refuses in item names (`Jenkins.checkGoodName`), so no stored job has them. */
const UNSAFE = /[?*\\%!@#$^&|<>[\]:;]/;

const invalid = (message: string) => new PluginError(ErrorCodes.InvalidParams, message);

/** `team/apps/api` → `team/job/apps/job/api`: each folder level its own encoded segment. Refuses empty,
 * `.` and `..` segments (also after Unicode normalization), control characters and characters Jenkins
 * forbids in names, so a name can only reach the job it names. */
export function jobSegments(name: unknown, param = 'job'): string {
  if (typeof name !== 'string' || !name) throw invalid(`path.${param} must be a job full name such as folder/job`);
  if (name.length > MAX_NAME) throw invalid(`path.${param} is longer than ${MAX_NAME} characters`);
  if (CONTROL.test(name)) throw invalid(`path.${param} has control characters`);
  if (UNSAFE.test(name)) throw invalid(`path.${param} has a character Jenkins does not allow in names`);
  const parts = name.split('/');
  if (parts.some((p) => p === '' || ['.', '..'].includes(p.normalize('NFKC').trim())))
    throw invalid(`path.${param} must be folder/job names separated by single slashes, without . or ..`);
  return parts.map(encodeURIComponent).join('/job/');
}

/** A build number, or for a read one of `permalinks`. */
export function buildNumber(value: unknown, permalinks: readonly string[]): string {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text === 'string' && (NUMBER.test(text) || permalinks.includes(text))) return text;
  throw invalid(
    permalinks.length
      ? `path.number must be a build number or one of ${permalinks.join(', ')}`
      : 'path.number must be a build number',
  );
}

function queueId(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text === 'string' && NUMBER.test(text)) return text;
  throw invalid('path.id must be a queue item id');
}

/** The request path for an operation's template: `{job}` and `{folder}` as nested job segments (`{folder}`
 * optional: without it the path starts at the root), `{number}` a build, `{id}` a queue item. Any other
 * placeholder, or a path param the template doesn't take, is refused. */
export function fillPath(template: string, path: Record<string, unknown>, permalinks: readonly string[]): string {
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const extra = Object.keys(path).filter((k) => !names.includes(k));
  if (extra.length) throw invalid(`path.${extra[0]} is not a parameter of this operation`);
  if (names.includes('folder') && (path.folder === undefined || path.folder === ''))
    template = template.replace('/job/{folder}', '');
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    if (name === 'job' || name === 'folder') return jobSegments(path[name], name);
    if (name === 'number') return buildNumber(path.number, permalinks);
    if (name === 'id') return queueId(path.id);
    throw invalid(`unknown path parameter ${name}`);
  });
}
