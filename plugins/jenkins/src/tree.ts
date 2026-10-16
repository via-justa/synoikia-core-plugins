import { ErrorCodes, PluginError, truncate } from '@synoikia/plugin-sdk';

const MAX_TREE = 2048;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RANGE = /^\{\d*,?\d*\}$/;

const invalid = (message: string) => new PluginError(ErrorCodes.InvalidParams, message);

/** The leaf field paths a `tree` names: `a,b[c,d[e]]{0,5}` → `a`, `b.c`, `b.d.e`. Throws on a malformed tree. */
export function treeLeaves(tree: string): string[] {
  let i = 0;
  const list = (prefix: string, close: string | undefined): string[] => {
    const out: string[] = [];
    for (;;) {
      const start = i;
      while (i < tree.length && !',[]{}'.includes(tree[i]!)) i++;
      const name = tree.slice(start, i);
      if (!NAME.test(name))
        throw invalid(`query.tree has an invalid field name near ${truncate(JSON.stringify(name), 60)}`);
      const path = prefix ? `${prefix}.${name}` : name;
      if (tree[i] === '[') {
        i++;
        out.push(...list(path, ']'));
      } else out.push(path);
      if (tree[i] === '{') {
        const end = tree.indexOf('}', i);
        if (end === -1 || !RANGE.test(tree.slice(i, end + 1))) throw invalid('query.tree has an invalid {range}');
        i = end + 1;
      }
      if (tree[i] === ',') {
        i++;
        continue;
      }
      if (close === undefined ? i === tree.length : tree[i] === close) {
        if (close) i++;
        return out;
      }
      throw invalid('query.tree is malformed');
    }
  };
  if (tree.length > MAX_TREE) throw invalid(`query.tree is longer than ${MAX_TREE} characters`);
  return list('', undefined);
}

/** Folders nest: `jobs.jobs.fullName` reads like `jobs.fullName`. */
const collapse = (path: string) => path.replace(/\b(jobs\.)+(?=jobs\b)/g, '');

/** Refuses a `tree` that names a field outside the operation's default tree (plus `_class`), so a call
 * cannot select fields such as git `remoteUrls` or an environment map that the defaults leave out. */
export function checkTree(op: string, tree: unknown, defaults: string): void {
  if (typeof tree !== 'string' || !tree) throw invalid('query.tree must be a non-empty string');
  const allowed = new Set(treeLeaves(defaults).map(collapse));
  for (const leaf of treeLeaves(tree.replace(/\s+/g, ''))) {
    const path = collapse(leaf);
    if (path === '_class' || path.endsWith('._class') || allowed.has(path)) continue;
    throw invalid(`${op} cannot select ${truncate(path, 120)} in query.tree; it may select fields of its default tree`);
  }
}

/** `depth` 0 to 2: deeper replies get large and reach fields no default tree selects. */
export function checkDepth(depth: unknown): void {
  const n = typeof depth === 'string' && /^\d$/.test(depth) ? Number(depth) : depth;
  if (n !== 0 && n !== 1 && n !== 2) throw invalid('query.depth must be 0, 1 or 2');
}
