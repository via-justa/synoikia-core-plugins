import { SpecError } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';

/** Exact keys the rules lock; wildcard patterns are left out (they can't name a missing operation). */
export function lockedKeys(rules: readonly { match: string | string[]; locked?: boolean | undefined }[]): string[] {
  return rules
    .filter((r) => r.locked)
    .flatMap((r) => (Array.isArray(r.match) ? r.match : [r.match]))
    .filter((key) => !key.includes('*'));
}

/** Refuses a spec that lacks a locked key: a path renamed upstream must not silently drop its lock. */
export function requireLockedKeys(
  operations: readonly OperationDescriptor[],
  keys: readonly string[],
  service: string,
) {
  const present = new Set(operations.map((o) => o.key));
  const missing = keys.filter((key) => !present.has(key));
  if (missing.length)
    throw new SpecError(`The ${service} API spec lacks locked operations (${missing.join(', ')}); refusing it`);
}
