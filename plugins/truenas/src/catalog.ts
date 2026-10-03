import { compileRules, isPlainObject, parsePluginSettings, toGroup } from '@synoikia/plugin-sdk';
import type { OperationDescriptor, OperationDraft } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';

/**
 * Turns `core.get_methods` into the catalog (TN §2.2–§2.3). Classification is layered and fails
 * closed: plugin.yaml's locks always win, then the roles TrueNAS declares and naming conventions,
 * and anything ambiguous is a write. Core applies admin overrides on top.
 */

export interface MethodInfo {
  description?: string | null;
  accepts?: unknown[] | null;
  job?: boolean;
  /** Roles that may call the method (TrueNAS 24.04+), e.g. `POOL_READ`, `POOL_WRITE`, `READONLY_ADMIN`. */
  roles?: unknown;
}

const words = (p: Record<string, unknown>, key: string): Set<string> => {
  const list = p[key];
  if (!Array.isArray(list) || !list.every((w) => typeof w === 'string'))
    throw new Error(`plugin.yaml plugin.${key} must be a list of words`);
  return new Set(list);
};

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    return {
      readLast: words(p, 'readLast'),
      readVerbs: words(p, 'readVerbs'),
      writeLast: words(p, 'writeLast'),
      writeVerbs: words(p, 'writeVerbs'),
      jobPollMs: typeof p.jobPollMs === 'number' ? p.jobPollMs : 250,
    };
  },
});

/** plugin.yaml's rules, without upstream lookups (confirmation literals compile their own per instance). */
export const policy = compileRules(settings);

/** Methods plugin.yaml locks by name (namespaces such as `api_key.*` are locked too; see `isLocked`). */
export const LOCKED = new Set(
  settings.rules
    .filter((r) => r.locked)
    .flatMap((r) => (Array.isArray(r.match) ? r.match : [r.match]))
    .filter((m) => !m.includes('*')),
);

export const isLocked = (method: string) => policy.isLocked(method);

/**
 * Methods whose risk depends on their params get a second catalog key (design §3.4): an ACL or owner
 * change at a pool's root (`/mnt/<pool>`) is locked; the same call deeper down is an ordinary write.
 */
export const POOL_ROOT = 'pool-root';
export const POOL_ROOT_SUFFIX = `#${POOL_ROOT}`;

/** A role that only grants reading: `READONLY_ADMIN` or any `*_READ` role. */
const isReadRole = (role: string) => role === 'READONLY_ADMIN' || role.endsWith('_READ');

/** What the method's name says: a definite read or write, or nothing when the name is unclear. */
function byName(method: string): { classification: 'read' | 'write'; reason: string } | null {
  const { readLast, readVerbs, writeLast, writeVerbs } = settings.plugin;
  const last = method.split('.').at(-1) ?? method;
  const verb = last.split('_')[0] ?? last;
  if (writeLast.has(last)) return { classification: 'write', reason: `naming:write(.${last})` };
  if (writeVerbs.has(verb)) return { classification: 'write', reason: `naming:write(${verb})` };
  if (readLast.has(last) || last.endsWith('_choices'))
    return { classification: 'read', reason: `naming:read(.${last})` };
  if (readVerbs.has(verb)) return { classification: 'read', reason: `naming:read(${verb})` };
  return null;
}

/**
 * Read or write. A lock always wins. The roles TrueNAS declares (`core.get_methods`) are upstream
 * data, so they may only make a method stricter or settle an unclear name, never turn a write-named
 * method into a read: declared roles with no read role make it a write; a read role (`READONLY_ADMIN`,
 * `*_READ`) makes it a read unless its name says write. Without roles, the name decides, and anything
 * unclear is a write (fail closed).
 */
export function classify(
  method: string,
  roles?: unknown,
): { classification: 'read' | 'write'; reason: string; locked: boolean } {
  if (isLocked(method)) return { classification: 'write', reason: 'locked:destructive', locked: true };
  const named = byName(method);
  const declared = (Array.isArray(roles) ? roles : []).filter((r): r is string => typeof r === 'string' && r !== '');
  if (declared.length > 0) {
    const read = declared.find(isReadRole);
    if (!read) {
      const write = declared.find((r) => r !== 'FULL_ADMIN') ?? declared[0]!;
      return { classification: 'write', reason: `roles:write(${write})`, locked: false };
    }
    if (named?.classification !== 'write')
      return { classification: 'read', reason: `roles:read(${read})`, locked: false };
  }
  return { ...(named ?? { classification: 'write', reason: 'default:ambiguous' }), locked: false };
}

/** Access group: the method's namespace (`pool.dataset.create` → `pool.dataset`). */
export function groupOf(method: string): string {
  const parts = method.split('.');
  return toGroup((parts.length > 1 ? parts.slice(0, -1) : parts).join('.'), 'misc');
}

export interface Catalog {
  operations: OperationDescriptor[];
  /** Methods that return a job id and must be waited for. */
  jobs: Set<string>;
  /** Every callable method name (for `resolveOperation`). */
  methods: Set<string>;
}

function draft(method: string, info: MethodInfo): OperationDraft {
  const { classification, reason } = classify(method, info.roles);
  const accepts = Array.isArray(info.accepts) ? info.accepts : undefined;
  const summary = info.description?.trim().slice(0, 500);
  return {
    key: method,
    kind: 'method',
    group: groupOf(method),
    classification,
    classificationReason: reason,
    // TrueNAS params are positional: `truenas.call('pool.dataset.create', { name })` → `[{ name }]`.
    ...(accepts ? { paramsSchema: { type: 'array', prefixItems: accepts } } : {}),
    ...(summary ? { docs: { summary } } : {}),
  };
}

export function buildCatalog(methods: Record<string, MethodInfo>): Catalog {
  const operations: OperationDescriptor[] = [];
  const jobs = new Set<string>();
  const names = new Set<string>();
  for (const [method, info] of Object.entries(methods).sort(([a], [b]) => a.localeCompare(b))) {
    if (policy.excluded(method) || !/^[a-z0-9_.]+$/i.test(method)) continue;
    names.add(method);
    if (info?.job) jobs.add(method);
    operations.push(...policy.describe(draft(method, info ?? {})));
  }
  return { operations, jobs, methods: names };
}

/**
 * Whether an ACL/owner change on `path` needs the locked `#pool-root` key. Fails closed: only a plain
 * absolute path strictly inside a pool (`/mnt/tank/media`) gets the ordinary key. A pool root
 * (`/mnt/tank`), anything outside `/mnt`, a relative path, or any `.`/`..` segment (`/mnt/tank/.`,
 * `/mnt/tank/media/..`) is locked. A missing or non-string path keeps the ordinary key; TrueNAS
 * rejects the call as invalid.
 */
export function needsPoolRootKey(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  if (!path.startsWith('/')) return true;
  const parts = path.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return true;
  return !(parts[0] === 'mnt' && parts.length >= 3);
}
