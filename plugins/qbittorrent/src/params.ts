import { ErrorCodes, isPlainObject, PluginError, truncate } from '@synoikia/plugin-sdk';
import type { StaticOperation } from '@synoikia/plugin-sdk';

export type HttpOperation = StaticOperation & { http: NonNullable<StaticOperation['http']> };

/** A call's params after the checks: flat, as qBittorrent names them. */
export type CallParams = Record<string, unknown>;

export const invalid = (message: string) => new PluginError(ErrorCodes.InvalidParams, message);

/** A torrent id as qBittorrent prints it: the v1 info hash, or a hybrid/v2 torrent's truncated v2 hash. */
const HASH = /^[0-9a-f]{40}$/;

/** The torrents a call names: a list of hashes, or `all` (every torrent, where qBittorrent takes it). */
export type HashSelection = { all: true } | { all: false; hashes: string[] };

/** `abc…|def…` or `all`, normalized to lower case. qBittorrent compares `all` exactly and parses hashes as hex, so
 * `ALL`, empty entries and anything else are refused rather than silently matching nothing. */
export function parseHashes(value: unknown, name: string, allowAll: boolean): HashSelection {
  if (typeof value !== 'string' || !value) throw invalid(`${name} must be torrent hashes joined with |`);
  if (value === 'all') {
    if (!allowAll) throw invalid(`${name} takes torrent hashes, not all`);
    return { all: true };
  }
  const hashes = value.split('|').map((h) => h.toLowerCase());
  for (const h of hashes)
    if (!HASH.test(h))
      throw invalid(`${name}: ${JSON.stringify(truncate(h, 80))} is not a torrent hash (40 hex characters)`);
  return { all: false, hashes: [...new Set(hashes)] };
}

/** Params whose value names torrents, by operation; the rest name one torrent in `hash`. */
export const HASH_PARAM: Record<string, 'hashes' | 'id'> = { 'torrents.setSavePath': 'id' };

/** Operations whose `hashes` take `all` (qBittorrent's applyToTorrents); queue moves parse each entry as a hash. */
const NO_ALL = new Set(['torrents.topPrio', 'torrents.bottomPrio', 'torrents.info']);

/** Fields that hold one entry per line. */
const MULTILINE = new Set(['torrents.add urls', 'torrents.addTrackers urls', 'torrents.removeCategories categories']);

const schemaOf = (op: HttpOperation) => (isPlainObject(op.paramsSchema) ? op.paramsSchema : {});
const propsOf = (op: HttpOperation): Record<string, unknown> => {
  const props = schemaOf(op).properties;
  return isPlainObject(props) ? props : {};
};

function checkValue(op: HttpOperation, name: string, value: unknown, schema: Record<string, unknown>): void {
  const where = `${op.key} ${name}`;
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) throw invalid(`${where} must be one of ${schema.enum.join(', ')}`);
    return;
  }
  switch (schema.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(`${where} must be true or false`);
      return;
    case 'integer':
    case 'number': {
      const ok =
        typeof value === 'number' && (schema.type === 'number' ? Number.isFinite(value) : Number.isInteger(value));
      if (!ok) throw invalid(`${where} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`);
      if (typeof schema.minimum === 'number' && value < schema.minimum)
        throw invalid(`${where} must be at least ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && value > schema.maximum)
        throw invalid(`${where} must be at most ${schema.maximum}`);
      return;
    }
    case 'object':
      if (!isPlainObject(value)) throw invalid(`${where} must be an object`);
      if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties)
        throw invalid(`${where} must not be empty`);
      return;
    default:
      if (typeof value !== 'string') throw invalid(`${where} must be a string`);
      if (typeof schema.minLength === 'number' && value.trim().length < schema.minLength)
        throw invalid(`${where} must not be empty`);
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
        throw invalid(`${where} must be at most ${schema.maxLength} characters`);
      // qBittorrent splits these fields on line breaks, or keeps a CR that changes the name: only the multi-line
      // fields take a LF, and none a CR or NUL.
      if (/[\0\r]/.test(value) || (value.includes('\n') && !MULTILINE.has(`${op.key} ${name}`)))
        throw invalid(
          `${where} must not contain ${MULTILINE.has(`${op.key} ${name}`) ? 'CR or NUL' : 'line breaks or NUL'} characters`,
        );
  }
}

/** The checked params of a call: the declared names only (qBittorrent reads them case-sensitively, so a name in
 * another case would be ignored by qBittorrent while the plugin read it), each of its declared type, objects only
 * where declared, and torrent hashes normalized. */
export function checkParams(op: HttpOperation, raw: unknown): CallParams {
  if (raw !== undefined && raw !== null && !isPlainObject(raw))
    throw invalid(`${op.key}: params must be an object of fields`);
  const params = raw ?? {};
  const props = propsOf(op);
  const keys = Object.keys(params);
  const folded = new Set(keys.map((k) => k.toLowerCase()));
  if (folded.size !== keys.length) throw invalid(`${op.key}: param names must not differ only by case`);
  for (const k of keys)
    if (!Object.hasOwn(props, k)) {
      const known = Object.keys(props);
      throw invalid(
        `${op.key} takes no ${truncate(k, 80)}${known.length ? `; it takes ${known.join(', ')}` : '; it takes no params'}`,
      );
    }
  const required = Array.isArray(schemaOf(op).required) ? (schemaOf(op).required as unknown[]) : [];
  for (const r of required) if (typeof r === 'string' && params[r] === undefined) throw invalid(`${op.key} needs ${r}`);
  const out: CallParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const schema = props[k];
    checkValue(op, k, v, isPlainObject(schema) ? schema : {});
    out[k] = v;
  }
  normalizeHashes(op, out);
  return out;
}

function normalizeHashes(op: HttpOperation, params: CallParams): void {
  const name = HASH_PARAM[op.key] ?? 'hashes';
  if (typeof params[name] === 'string' && Object.hasOwn(propsOf(op), name)) {
    const sel = parseHashes(params[name], name, !NO_ALL.has(op.key));
    params[name] = sel.all ? 'all' : sel.hashes.join('|');
  }
  if (typeof params.hash === 'string') {
    const sel = parseHashes(params.hash, 'hash', false);
    if (sel.all || sel.hashes.length !== 1) throw invalid(`${op.key} takes one torrent hash`);
    params.hash = sel.hashes[0];
  }
}

/** The torrents a write names, or undefined when it names none. */
export function selection(key: string, params: CallParams): HashSelection | undefined {
  const name = HASH_PARAM[key] ?? 'hashes';
  if (typeof params[name] === 'string') return parseHashes(params[name], name, true);
  if (typeof params.hash === 'string') return parseHashes(params.hash, 'hash', false);
  return undefined;
}

// eslint-disable-next-line no-control-regex
const NOT_IN_CATEGORY = /[\\\x00-\x1f\x7f]/;

/** A category name that names a directory under the save root, whatever the subcategory setting: 5.0 and 5.1
 * accept `../x` as a name, and their save path for it leaves the root once `QDir::cleanPath` resolves the `..`. So no
 * leading `/`, backslash, control character, or empty, `.` or `..` segment (split on `/`), nor a segment that trims
 * to one or ends in a space or dot. Empty means no category. */
export function checkCategoryName(op: HttpOperation, where: string, value: unknown): void {
  if (value === undefined || value === '') return;
  const name = typeof value === 'string' ? value : '';
  // Win32 path normalization also drops trailing spaces and dots, so `.. ` and `x.` are refused too.
  const bad =
    !name ||
    NOT_IN_CATEGORY.test(name) ||
    name.split('/').some((s) => s === '' || ['.', '..'].includes(s.trim()) || /[ .]$/.test(s));
  if (bad)
    throw invalid(
      `${op.key} ${where} must be a category name: segments joined with /, none empty, . or .., no backslash or control characters`,
    );
}

/** A path inside a torrent: relative, without `..`, `.`, empty segments or a drive. */
export function checkInnerPath(op: HttpOperation, name: string, value: unknown): void {
  const text = typeof value === 'string' ? value : '';
  const segments = text.split(/[\\/]/);
  // `:` is refused in any segment: on Windows `C:name` is relative to drive C, not to the torrent.
  if (!text || /^[\\/]/.test(text) || segments.some((s) => s === '' || s === '.' || s === '..' || s.includes(':')))
    throw invalid(`${op.key} ${name} must be a path inside the torrent, as torrents.files names it`);
}
