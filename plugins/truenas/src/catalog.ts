import type { OperationDescriptor } from '@synoikia/plugin-sdk';

/**
 * Turns `core.get_methods` into the catalog (TN §2.2–§2.3). Classification is layered and fails
 * closed: a hardcoded locked list always wins, then naming conventions, and anything ambiguous is a
 * write. Core applies admin overrides on top.
 */

export interface MethodInfo {
  description?: string | null;
  accepts?: unknown[] | null;
  job?: boolean;
  /** Roles that may call the method (TrueNAS 24.04+), e.g. `POOL_READ`, `POOL_WRITE`, `READONLY_ADMIN`. */
  roles?: unknown;
}

/** Destructive or irreversible: always a human with a typed confirmation, never pre-approved (TN §3.4). */
export const LOCKED = new Set([
  'system.reboot',
  'system.shutdown',
  'pool.export',
  'disk.wipe',
  'config.reset',
  'user.set_password',
  'user.delete',
  'pool.dataset.change_key',
  'pool.dataset.delete',
  'app.delete',
  'audit.config',
  'auth.generate_token',
  'docker.delete_backup',
  'interface.network_config_to_be_removed',
  'user.has_local_administrator_set_up',
  'user.renew_2fa_secret',
  'user.setup_local_administrator',
]);

/** Whole namespaces that are locked, including methods a future TrueNAS adds to them. */
export const LOCKED_PREFIXES = ['api_key.'] as const;

export const isLocked = (method: string) =>
  LOCKED.has(method) || LOCKED_PREFIXES.some((p) => method.startsWith(p)) || method.endsWith(POOL_ROOT_SUFFIX);

/**
 * Methods whose risk depends on their params get a second catalog key (design §3.4): an ACL or owner
 * change at a pool's root (`/mnt/<pool>`) is locked; the same call deeper down is an ordinary write.
 */
export const POOL_ROOT_SPLIT = ['filesystem.setacl', 'filesystem.chown'] as const;
export const POOL_ROOT_SUFFIX = '#pool-root';

/** Session plumbing the model has no business calling. */
const EXCLUDED = new Set([
  'auth.login',
  'auth.login_ex',
  'auth.login_with_api_key',
  'auth.login_with_token',
  'auth.logout',
]);

/**
 * `core.*` is middleware plumbing, and some of it dispatches other methods (`core.bulk`,
 * `core.download`) or opens a debugger (`core.debug`), which would bypass the locked list. Only these
 * are exposed; anything else under `core`, including methods a future TrueNAS adds, is excluded.
 */
const CORE_ALLOWED = new Set(['core.get_jobs', 'core.get_methods', 'core.ping', 'core.job_abort']);

const excluded = (method: string) => EXCLUDED.has(method) || (method.startsWith('core.') && !CORE_ALLOWED.has(method));

const READ_LAST = new Set(['query', 'get_instance', 'config', 'status', 'choices', 'info']);
const READ_VERBS = new Set(['list', 'listdir', 'get', 'search']);
const WRITE_LAST = new Set(['create', 'update', 'delete']);
const WRITE_VERBS = new Set([
  'run',
  'start',
  'stop',
  'restart',
  'install',
  'upgrade',
  'reboot',
  'shutdown',
  'wipe',
  'attach',
  'detach',
  'export',
  'remove',
  'replace',
  'set',
]);

/** A role that only grants reading: `READONLY_ADMIN` or any `*_READ` role. */
const isReadRole = (role: string) => role === 'READONLY_ADMIN' || role.endsWith('_READ');

/** What the method's name says: a definite read or write, or nothing when the name is unclear. */
function byName(method: string): { classification: 'read' | 'write'; reason: string } | null {
  const last = method.split('.').at(-1) ?? method;
  const verb = last.split('_')[0] ?? last;
  if (WRITE_LAST.has(last)) return { classification: 'write', reason: `naming:write(.${last})` };
  if (WRITE_VERBS.has(verb)) return { classification: 'write', reason: `naming:write(${verb})` };
  if (READ_LAST.has(last) || last.endsWith('_choices'))
    return { classification: 'read', reason: `naming:read(.${last})` };
  if (READ_VERBS.has(verb)) return { classification: 'read', reason: `naming:read(${verb})` };
  return null;
}

/**
 * Read or write. The locked list always wins. The roles TrueNAS declares (`core.get_methods`) are
 * upstream data, so they may only make a method stricter or settle an unclear name, never turn a
 * write-named method into a read: declared roles with no read role make it a write; a read role
 * (`READONLY_ADMIN`, `*_READ`) makes it a read unless its name says write. Without roles, the name
 * decides, and anything unclear is a write (fail closed).
 */
export function classify(
  method: string,
  roles?: unknown,
): { classification: 'read' | 'write'; reason: string; locked: boolean } {
  if (isLocked(method)) {
    return { classification: 'write', reason: 'locked:destructive', locked: true };
  }
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
  const group = (parts.length > 1 ? parts.slice(0, -1) : parts).join('.').toLowerCase();
  return group.replace(/[^a-z0-9._-]/g, '_').replace(/^[^a-z0-9]+/, '') || 'misc';
}

const MATCH_PROFILES: Record<string, string> = {
  'pool.dataset.create': 'dataset-name-prefix',
  'app.upgrade': 'app-name-in',
};

/** Wizard-style guidance the old 52-tool server baked into its prompts (TN §6), now on demand. */
const GUIDANCE: Record<string, string> = {
  'pool.dataset.create':
    'Name is "<pool>/<path>". Common options: type FILESYSTEM (default) or VOLUME (needs volsize), share_type ' +
    'GENERIC/SMB/APPS, compression, quota/refquota in bytes, acltype. Create parents first; check pool.dataset.query.',
  'sharing.smb.create':
    'Needs path under /mnt/<pool>/… (an existing dataset) and name. purpose presets: DEFAULT_SHARE, ' +
    'MULTIPROTOCOL_SHARE, TIMEMACHINE_SHARE. The dataset should use share_type SMB for correct ACLs.',
  'sharing.nfs.create':
    'Needs path under /mnt/<pool>/…; restrict with networks/hosts; maproot/mapall for ownership mapping.',
  'app.create':
    'Needs app_name, catalog_app (see app.available / catalog), train, version and a values object following ' +
    'the app schema (catalog.get_app_details). Storage usually maps host paths under an existing dataset.',
};

export interface Catalog {
  operations: OperationDescriptor[];
  /** Methods that return a job id and must be waited for. */
  jobs: Set<string>;
  /** Every callable method name (for `resolveOperation`). */
  methods: Set<string>;
}

function describe(key: string, method: string, info: MethodInfo): OperationDescriptor {
  const { classification, reason, locked } = classify(key, info.roles);
  const accepts = Array.isArray(info.accepts) ? info.accepts : undefined;
  const summary = info.description?.trim().slice(0, 500);
  const guidance = GUIDANCE[method];
  return {
    key,
    kind: 'method',
    group: groupOf(method),
    classification,
    classificationReason: reason,
    locked,
    typedConfirmation: locked,
    ...(MATCH_PROFILES[key] ? { matchProfile: MATCH_PROFILES[key] } : {}),
    // TrueNAS params are positional: `truenas.call('pool.dataset.create', { name })` → `[{ name }]`.
    ...(accepts ? { paramsSchema: { type: 'array', prefixItems: accepts } } : {}),
    ...(summary || guidance
      ? {
          docs: {
            ...(summary ? { summary } : {}),
            ...(key.endsWith(POOL_ROOT_SUFFIX)
              ? {
                  description: `${method} on a pool's root (/mnt/<pool>), outside /mnt, or on a path with . or .. segments: locked.`,
                }
              : {}),
            ...(guidance ? { guidance } : {}),
          },
        }
      : {}),
  };
}

export function buildCatalog(methods: Record<string, MethodInfo>): Catalog {
  const operations: OperationDescriptor[] = [];
  const jobs = new Set<string>();
  const names = new Set<string>();
  for (const [method, info] of Object.entries(methods).sort(([a], [b]) => a.localeCompare(b))) {
    if (excluded(method) || !/^[a-z0-9_.]+$/i.test(method)) continue;
    names.add(method);
    if (info?.job) jobs.add(method);
    operations.push(describe(method, method, info ?? {}));
    if ((POOL_ROOT_SPLIT as readonly string[]).includes(method)) {
      operations.push(describe(`${method}${POOL_ROOT_SUFFIX}`, method, info ?? {}));
    }
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
