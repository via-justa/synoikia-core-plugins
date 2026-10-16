import { SpecError } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';

interface KeyRule {
  match: string | string[];
  locked?: boolean | undefined;
  split?: string | string[] | undefined;
  classification?: 'read' | 'write' | undefined;
}

const exactKeys = (rules: readonly KeyRule[], keep: (r: KeyRule) => boolean) =>
  rules
    .filter(keep)
    .flatMap((r) => (Array.isArray(r.match) ? r.match : [r.match]))
    .filter((key) => !key.includes('*'));

/** Exact keys the rules lock; wildcard patterns are left out (they can't name a missing operation). */
export const lockedKeys = (rules: readonly KeyRule[]) => exactKeys(rules, (r) => r.locked === true);

/** Exact keys a rule locks, splits or makes a write: a spec without one of them is refused. */
export const requiredKeys = (rules: readonly KeyRule[]) => [
  ...new Set(exactKeys(rules, (r) => r.locked === true || r.split !== undefined || r.classification === 'write')),
];

/** Refuses a spec that lacks a required key: a path renamed upstream must not silently drop its lock or twin. */
export function requireLockedKeys(
  operations: readonly OperationDescriptor[],
  keys: readonly string[],
  service: string,
) {
  const present = new Set(operations.map((o) => o.key));
  const missing = keys.filter((key) => !present.has(key));
  if (missing.length)
    throw new SpecError(
      `The ${service} API spec lacks operations its rules lock, split or make writes (${missing.join(', ')}); refusing it`,
    );
}
