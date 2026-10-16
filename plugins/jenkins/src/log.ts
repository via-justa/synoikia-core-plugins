import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';
import type { HttpJsonClient } from '@synoikia/plugin-sdk';
import { send } from './jenkins.js';

export interface LogLimits {
  defaultBytes: number;
  maxBytes: number;
  maxLines: number;
}

export interface LogSlice {
  text: string;
  /** Byte offsets of `text` in the log. */
  start: number;
  end: number;
  /** Bytes in the log so far. */
  size: number;
  /** True while the build still writes to the log. */
  more: boolean;
  /** True when the log has bytes after `end` that this call left out (call again with `start: end`). */
  truncated: boolean;
}

function count(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    throw new PluginError(ErrorCodes.InvalidParams, `query.${name} must be an integer from ${min} to ${max}`);
  return n;
}

const NEWLINE = 0x0a;
const continuation = (buf: Buffer, i: number) => i < buf.length && ((buf[i] ?? 0) & 0xc0) === 0x80;

/** The bytes `[from, to)` moved so neither edge splits a UTF-8 character: the start forward, the end back. */
function whole(buf: Buffer, from: number, to: number): [number, number] {
  while (from < to && continuation(buf, from)) from++;
  while (to > from && continuation(buf, to)) to--;
  return [from, to];
}

/** A slice of a build's console log, from `progressiveText`: from `start` on, or else the tail, at most
 * `bytes` (or the first or last `lines` of those). Jenkins sends everything after `start`; it is cut here. */
export async function readLog(
  client: HttpJsonClient,
  path: string,
  query: Record<string, unknown>,
  limits: LogLimits,
  timeoutMs: number,
): Promise<LogSlice> {
  const start = count(query.start, 'start', 0, Number.MAX_SAFE_INTEGER);
  const bytes = count(query.bytes, 'bytes', 1, limits.maxBytes) ?? limits.defaultBytes;
  const lines = count(query.lines, 'lines', 1, limits.maxLines);
  const res = await send(client, 'GET', path, { query: { start: start ?? 0 }, timeoutMs });
  // The client parses a body that happens to be JSON; the log is its text either way.
  const raw = typeof res.body === 'string' ? res.body : res.body === null ? '' : JSON.stringify(res.body);
  const all = Buffer.from(raw, 'utf8');
  const offset = start ?? 0;
  const header = Number(res.headers['x-text-size']);
  const size = Number.isSafeInteger(header) && header >= offset ? header : offset + all.length;
  // Jenkins starts over from 0 when `start` is past the end of the log.
  if (start !== undefined && Number.isSafeInteger(header) && start > header)
    throw new PluginError(ErrorCodes.InvalidParams, `query.start is past the end of the log (${header} bytes)`);
  const more = res.headers['x-more-data'] === 'true';

  let from: number;
  let to: number;
  if (start !== undefined) {
    [from, to] = whole(all, 0, Math.min(bytes, all.length));
    if (lines !== undefined) {
      let cut = from;
      for (let n = 0; n < lines && cut < to; n++) {
        const nl = all.indexOf(NEWLINE, cut);
        cut = nl === -1 || nl >= to ? to : nl + 1;
      }
      to = cut;
    }
  } else {
    [from, to] = whole(all, Math.max(0, all.length - bytes), all.length);
    if (lines !== undefined) {
      // Walk back over `lines` newlines, not counting the one that ends the log.
      let cut = all[to - 1] === NEWLINE ? to - 1 : to;
      let found = true;
      for (let n = 0; n < lines && found; n++) {
        const nl = cut > from ? all.lastIndexOf(NEWLINE, cut - 1) : -1;
        if (nl < from) found = false;
        else cut = nl;
      }
      if (found) from = cut + 1;
    }
  }
  return {
    text: all.subarray(from, to).toString('utf8'),
    start: offset + from,
    end: offset + to,
    size,
    more,
    truncated: offset + to < size,
  };
}
