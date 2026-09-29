import { createHash } from 'node:crypto';
import { ErrorCodes, PluginError } from '@synoikia/plugin-sdk';

/**
 * Surgical config edits with optimistic locking (HA §2.8). A read returns the object and its
 * `config_hash`; a write sends a small JSON Patch (RFC 6902: add, remove, replace, test) plus that
 * hash. The plugin applies the patch to the live object, refuses if the object changed since it was
 * read, and hands core a field-level diff for the approval prompt.
 */

export interface PatchOp {
  op: 'add' | 'remove' | 'replace' | 'test';
  path: string;
  value?: unknown;
}

export interface DiffEntry {
  path: string;
  before?: unknown;
  after?: unknown;
}

const MAX_OPS = 200;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Content hash of a config object (key order doesn't matter). */
export function configHash(config: unknown): string {
  return createHash('sha256').update(canonical(config)).digest('hex').slice(0, 32);
}

const invalid = (message: string) => new PluginError(ErrorCodes.InvalidParams, message);

/** Tokens that would reach an object's prototype instead of its own data. */
const FORBIDDEN_TOKENS = new Set(['__proto__', 'constructor', 'prototype']);

function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw invalid(`Patch path "${path}" must be a JSON pointer starting with /`);
  const tokens = path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const bad = tokens.find((t) => FORBIDDEN_TOKENS.has(t));
  if (bad) throw invalid(`Patch path "${path}" may not contain "${bad}"`);
  return tokens;
}

const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] => !!v && typeof v === 'object';

function index(arr: unknown[], token: string, forAdd: boolean): number {
  if (forAdd && token === '-') return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(token)) throw invalid(`"${token}" is not an array index`);
  const i = Number(token);
  if (i > arr.length || (!forAdd && i >= arr.length)) throw invalid(`Index ${i} is out of range`);
  return i;
}

/** Validates the patch shape (so an invalid patch is refused before anything is fetched). */
export function validatePatch(patch: unknown): PatchOp[] {
  if (!Array.isArray(patch) || patch.length === 0) throw invalid('patch must be a non-empty list of operations');
  if (patch.length > MAX_OPS) throw invalid(`patch has more than ${MAX_OPS} operations`);
  return patch.map((raw, i) => {
    const p = raw as Partial<PatchOp> | null;
    if (!p || typeof p !== 'object') throw invalid(`patch[${i}] must be an object`);
    if (!['add', 'remove', 'replace', 'test'].includes(String(p.op)))
      throw invalid(`patch[${i}].op must be add, remove, replace or test`);
    if (typeof p.path !== 'string') throw invalid(`patch[${i}].path must be a string`);
    parsePointer(p.path);
    if (p.op !== 'remove' && !('value' in p)) throw invalid(`patch[${i}] (${p.op}) needs a value`);
    return { op: p.op as PatchOp['op'], path: p.path, ...(p.op !== 'remove' ? { value: p.value } : {}) };
  });
}

/** Applies a patch to a copy of `doc`. Throws INVALID_PARAMS on a path that doesn't exist or a failed test. */
export function applyPatch<T>(doc: T, patch: PatchOp[]): T {
  const root = { v: structuredClone(doc) as unknown };
  for (const [i, p] of patch.entries()) {
    const tokens = parsePointer(p.path);
    if (tokens.length === 0) {
      if (p.op === 'test') {
        if (canonical(root.v) !== canonical(p.value)) throw invalid(`patch[${i}] test failed at ${p.path || '/'}`);
        continue;
      }
      if (p.op === 'remove') throw invalid('patch cannot remove the whole object');
      root.v = structuredClone(p.value);
      continue;
    }
    let parent: unknown = root.v;
    for (const t of tokens.slice(0, -1)) {
      if (!isContainer(parent)) throw invalid(`patch[${i}] path ${p.path} does not exist`);
      if (Array.isArray(parent)) parent = parent[index(parent, t, false)];
      else if (Object.hasOwn(parent, t)) parent = (parent as Record<string, unknown>)[t];
      else throw invalid(`patch[${i}] path ${p.path} does not exist`);
    }
    if (!isContainer(parent)) throw invalid(`patch[${i}] path ${p.path} does not exist`);
    const last = tokens.at(-1)!;
    if (Array.isArray(parent)) {
      const at = index(parent, last, p.op === 'add');
      if (p.op === 'add') parent.splice(at, 0, structuredClone(p.value));
      else if (p.op === 'remove') parent.splice(at, 1);
      else if (p.op === 'replace') parent[at] = structuredClone(p.value);
      else if (canonical(parent[at]) !== canonical(p.value)) throw invalid(`patch[${i}] test failed at ${p.path}`);
    } else {
      const has = Object.hasOwn(parent, last);
      if (p.op !== 'add' && !has) throw invalid(`patch[${i}] path ${p.path} does not exist`);
      if (p.op === 'remove') delete parent[last];
      else if (p.op === 'test') {
        if (canonical(parent[last]) !== canonical(p.value)) throw invalid(`patch[${i}] test failed at ${p.path}`);
      } else parent[last] = structuredClone(p.value);
    }
  }
  return root.v as T;
}

const escape = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** Leaf-level differences between two values, as JSON pointers. Unchanged fields don't appear. */
export function diff(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (canonical(before) === canonical(after)) return [];
  const bothObjects = isContainer(before) && isContainer(after) && !Array.isArray(before) && !Array.isArray(after);
  if (bothObjects) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => {
      const b = (before as Record<string, unknown>)[k];
      const a = (after as Record<string, unknown>)[k];
      const p = `${path}/${escape(k)}`;
      if (b === undefined) return [{ path: p, after: a }];
      if (a === undefined) return [{ path: p, before: b }];
      return diff(b, a, p);
    });
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((b, i) => diff(b, after[i], `${path}/${i}`));
  }
  return [
    { path: path || '/', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) },
  ];
}
