import { maskSensitiveResult } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrafanaPlugin } from '../src/plugin.js';
import { CREDENTIALS, startFakeGrafana } from './fake-grafana.js';
import type { FakeGrafana } from './fake-grafana.js';
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

const plugin = createGrafanaPlugin();
let fake: FakeGrafana;
let operations: OperationDescriptor[];

beforeAll(async () => {
  fake = await startFakeGrafana();
  await plugin.init({
    instanceId: 'grafana',
    config: { baseUrl: fake.url },
    secrets: CREDENTIALS,
    sdkVersion: '1.0.0',
  });
  operations = (await plugin.syncCatalog()).operations as OperationDescriptor[];
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const context = { callId: 'golden', deadlineMs: 5000 };

describe('Grafana golden record', () => {
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
      const targets = (await plugin.resolveTargets?.({ key, params })) ?? [];
      out[c.key] = { resolved: key, targets, ...(await plugin.summarize({ key, params: shown, targets })) };
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/summaries.json');
  });

  it('destinations stay ahead of a padded body', async () => {
    const padding = 'x'.repeat(2000);
    const calls = [
      { method: 'POST', path: '/datasources', body: { padding, name: 'Loki', url: 'http://loki.example.net:3100' } },
      {
        method: 'PUT',
        path: '/v1/provisioning/contact-points/cp-1',
        body: { padding, settings: { url: 'https://hooks.example.net/T0KEN', addresses: 'oncall@example.net' } },
      },
      { method: 'POST', path: '/reports/email', body: { padding, id: '7', emails: 'someone@example.com' } },
      { method: 'PUT', path: '/v1/provisioning/policies', body: { padding, receiver: 'Pager' } },
      { method: 'POST', path: '/snapshots', body: { padding, external: true } },
    ];
    const out: Record<string, unknown> = {};
    for (const request of calls) {
      const { key, params } = await plugin.resolveOperation({ fn: 'request', args: [request] });
      const declared = operations.find((o) => o.key === key)?.sensitiveParams ?? [];
      const targets = (await plugin.resolveTargets?.({ key, params })) ?? [];
      out[key] = { targets, ...(await plugin.summarize({ key, params: redactPaths(params, declared), targets })) };
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/destinations.json');
  });

  it('results with secrets, as core masks them by descriptor', async () => {
    const calls = [
      { method: 'GET', path: '/datasources' },
      { method: 'GET', path: '/datasources/uid/prom' },
      { method: 'GET', path: '/v1/provisioning/contact-points' },
      { method: 'GET', path: '/org/invites' },
      { method: 'POST', path: '/serviceaccounts/4/tokens', body: { name: 'ci' } },
      { method: 'POST', path: '/snapshots', body: { dashboard: { title: 'Home Lab' } } },
      {
        method: 'POST',
        path: '/datasources',
        body: { name: 'Loki', type: 'loki', url: 'http://loki:3100', secureJsonData: { password: 'x' } },
      },
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
