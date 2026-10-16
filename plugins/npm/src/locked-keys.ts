import { SpecError } from '@synoikia/plugin-sdk';

/** Fails closed on a live spec that lacks a key plugin.yaml locks by name: a renamed path in another
 * upstream version would otherwise drop its lock silently. Glob matches are not checked. */
export function requireLockedKeys(
  service: string,
  rules: readonly { match: string | string[]; locked?: boolean }[],
  operations: readonly { key: string }[],
): void {
  const have = new Set(operations.map((o) => o.key));
  const missing = rules
    .filter((r) => r.locked)
    .flatMap((r) => (Array.isArray(r.match) ? r.match : [r.match]))
    .filter((key) => !key.includes('*') && !have.has(key));
  if (missing.length)
    throw new SpecError(
      `The ${service} API spec lacks ${missing.length} locked operation(s) (${missing.join(', ')}); refusing a catalog that would drop their locks`,
    );
}
