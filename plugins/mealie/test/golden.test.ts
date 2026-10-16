import { maskSensitiveResult } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMealiePlugin } from '../src/plugin.js';
import { CREDENTIALS, startFakeMealie } from './fake-mealie.js';
import type { FakeMealie } from './fake-mealie.js';
import { LOCK_CASES } from './locks.js';

/** Golden record of what the plugin tells core (policy per descriptor, locked summaries and literals,
 * result masking): review snapshot diffs as security changes. */

/** Stable JSON (sorted keys): property order means nothing to core. */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value), null, 2);
}

/** Core summarizes params with the declared `sensitiveParams` hidden; do the same here. */
function redactPaths(params: unknown, pointers: string[]): unknown {
  const copy: unknown = structuredClone(params);
  for (const pointer of pointers) {
    const parts = pointer.split('/').slice(1);
    const last = parts.pop();
    let node: unknown = copy;
    for (const p of parts) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[p] : undefined;
    if (last && node && typeof node === 'object' && last in node)
      (node as Record<string, unknown>)[last] = '[REDACTED]';
  }
  return copy;
}

const plugin = createMealiePlugin();
let fake: FakeMealie;
let operations: OperationDescriptor[];

beforeAll(async () => {
  fake = await startFakeMealie();
  await plugin.init({ instanceId: 'mealie', config: { baseUrl: fake.url }, secrets: CREDENTIALS, sdkVersion: '1.0.0' });
  operations = (await plugin.syncCatalog()).operations as OperationDescriptor[];
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const context = { callId: 'golden', deadlineMs: 5000 };

describe('Mealie golden record', () => {
  // paramsSchema and docs come verbatim from the upstream spec; the policy fields are what this plugin decides.
  it('catalog policy per descriptor', async () => {
    const policy = operations.map(({ paramsSchema: _schema, docs: _docs, ...rest }) => rest);
    await expect(stable(policy)).toMatchFileSnapshot('__golden__/catalog.json');
  });

  it('summaries and confirm literals of locked operations', async () => {
    const out: Record<string, unknown> = {};
    for (const c of LOCK_CASES) {
      const { key, params } = await plugin.resolveOperation({ fn: 'request', args: [c.request] });
      const declared = operations.find((o) => o.key === key)?.sensitiveParams ?? [];
      const shown = redactPaths(params, declared);
      out[c.key] = { resolved: key, ...(await plugin.summarize({ key, params: shown, targets: [] })) };
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/summaries.json');
  });

  it('results with secrets, as core masks them by descriptor', async () => {
    const calls = [
      { method: 'GET', path: '/api/admin/about' },
      { method: 'GET', path: '/api/households/webhooks' },
      { method: 'GET', path: '/api/households/invitations' },
      { method: 'POST', path: '/api/users/api-tokens', body: { name: 'scripts' } },
      { method: 'POST', path: '/api/admin/users/password-reset-token', body: { email: 'alex@example.com' } },
    ];
    const out: Record<string, unknown> = {};
    for (const request of calls) {
      const { key, params } = await plugin.resolveOperation({ fn: 'request', args: [request] });
      const descriptor = operations.find((o) => o.key === key);
      const result = await plugin.invoke({ key, params, context });
      out[key] = {
        sensitiveParams: descriptor?.sensitiveParams ?? [],
        masked: maskSensitiveResult(result, descriptor?.sensitiveResult),
      };
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/masked.json');
  });
});
