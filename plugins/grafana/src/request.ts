import { ErrorCodes, isPlainObject, PluginError } from '@synoikia/plugin-sdk';
import type { RestParams } from '@synoikia/plugin-sdk';

// Grafana's encoding/json binds keys case-insensitively, last match wins, folding ſ and K (docs/designs/grafana.md).

export interface ReadTree {
  keys: Map<string, { key: string; node: ReadTree }>;
  items?: ReadTree;
  strict?: boolean;
}

const node = (): ReadTree => ({ keys: new Map() });

/** The tree of body pointers the plugin reads, `*` standing for array items (`/queries/*\/datasource/uid`). */
export function readTree(pointers: readonly string[], strict: readonly string[] = []): ReadTree {
  const root = node();
  const at = (pointer: string) => {
    let n = root;
    for (const seg of pointer.slice(1).split('/')) {
      if (seg === '*') n = n.items ??= node();
      else {
        const lower = seg.toLowerCase();
        const child = n.keys.get(lower) ?? { key: seg, node: node() };
        n.keys.set(lower, child);
        n = child.node;
      }
    }
    return n;
  };
  for (const p of pointers) at(p);
  for (const p of strict) at(p).strict = true;
  return root;
}

const refuse = (where: string, detail: string): never => {
  throw new PluginError(ErrorCodes.InvalidParams, `${where}: ${detail}; send each key once, in one ASCII spelling`);
};

function walk(value: unknown, n: ReadTree | undefined, strict: boolean, where: string): unknown {
  strict ||= n?.strict === true;
  if (Array.isArray(value)) {
    const items = n?.items;
    return items || strict ? value.map((v, i) => walk(v, items, strict, `${where}[${i}]`)) : value;
  }
  if (!isPlainObject(value) || (!strict && !n?.keys.size)) return value;
  const seen = new Map<string, string>();
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!/^[\x20-\x7e]*$/.test(key)) refuse(where, `the key ${JSON.stringify(key)} is not ASCII`);
    const lower = key.toLowerCase();
    const other = seen.get(lower);
    if (other !== undefined) refuse(where, `"${other}" and "${key}" name the same field`);
    seen.set(lower, key);
    const child = n?.keys.get(lower);
    Object.defineProperty(out, child?.key ?? key, {
      value: walk(v, child?.node, strict, `${where}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** `params` checked and renamed along `body`; the flat query is always checked. */
export function normalizeRequest(params: RestParams, body: ReadTree): RestParams {
  const out: RestParams = { ...params };
  if (params.query !== undefined) out.query = walk(params.query, undefined, true, 'query') as RestParams['query'];
  if (params.body !== undefined) out.body = walk(params.body, body, false, 'body');
  return out;
}
