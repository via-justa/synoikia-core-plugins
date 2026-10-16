import { maskSensitiveResult } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNpmPlugin } from '../src/plugin.js';
import { CREDENTIALS, startFakeNpm } from './fake-npm.js';
import type { FakeNpm } from './fake-npm.js';
import { LOCK_CASES } from './locks.js';
import type { LockCase } from './locks.js';

/** Writes whose summaries carry a secret, a destination or raw nginx config. */
const EXTRA_CASES: (Omit<LockCase, 'confirm'> & { label?: string })[] = [
  {
    label: 'POST /nginx/proxy-hosts (advanced_config)',
    key: 'POST /nginx/proxy-hosts',
    request: {
      method: 'POST',
      path: '/nginx/proxy-hosts',
      body: {
        domain_names: ['raw.home.example'],
        forward_scheme: 'http',
        forward_host: '10.0.0.8',
        forward_port: 80,
        advanced_config: 'location /admin { proxy_pass http://10.9.9.9; }',
      },
    },
  },
  {
    label: 'PUT /nginx/proxy-hosts/{hostID} (location advanced_config)',
    key: 'PUT /nginx/proxy-hosts/{hostID}',
    request: {
      method: 'PUT',
      path: '/nginx/proxy-hosts/1',
      body: { locations: [{ path: '/x', forward_host: '10.0.0.9', forward_port: 81, advanced_config: 'allow all;' }] },
    },
  },
  {
    key: 'POST /nginx/certificates',
    request: {
      method: 'POST',
      path: '/nginx/certificates',
      body: {
        provider: 'letsencrypt',
        domain_names: ['*.home.example'],
        meta: { dns_challenge: true, dns_provider: 'cloudflare', dns_provider_credentials: 'cf-token-111111' },
      },
    },
  },
  {
    key: 'POST /nginx/dead-hosts',
    request: { method: 'POST', path: '/nginx/dead-hosts', body: { domain_names: ['parked.home.example'] } },
  },
];

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

const plugin = createNpmPlugin();
let fake: FakeNpm;
let operations: OperationDescriptor[];

beforeAll(async () => {
  fake = await startFakeNpm();
  await plugin.init({
    instanceId: 'npm',
    config: { baseUrl: fake.url, email: CREDENTIALS.email },
    secrets: { password: CREDENTIALS.password },
    sdkVersion: '1.0.0',
  });
  operations = (await plugin.syncCatalog()).operations as OperationDescriptor[];
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const context = { callId: 'golden', deadlineMs: 5000 };

describe('Nginx Proxy Manager golden record', () => {
  // paramsSchema and docs come verbatim from the upstream spec; the policy fields are what this plugin decides.
  it('catalog policy per descriptor', async () => {
    const policy = operations.map(({ paramsSchema: _schema, docs: _docs, ...rest }) => rest);
    await expect(stable(policy)).toMatchFileSnapshot('__golden__/catalog.json');
  });

  it('summaries and confirm literals of locked operations, and of writes with secrets', async () => {
    const out: Record<string, unknown> = {};
    for (const c of [...LOCK_CASES, ...EXTRA_CASES]) {
      const { key, params } = await plugin.resolveOperation({ fn: 'request', args: [c.request] });
      const declared = operations.find((o) => o.key === key)?.sensitiveParams ?? [];
      const shown = redactPaths(params, declared);
      out['label' in c && c.label ? c.label : c.key] = {
        resolved: key,
        ...(await plugin.summarize({ key, params: shown, targets: [] })),
      };
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/summaries.json');
  });

  it('results with secrets, as core masks them by descriptor', async () => {
    const calls = [
      { method: 'GET', path: '/nginx/certificates' },
      { method: 'GET', path: '/nginx/proxy-hosts', query: { expand: 'certificate' } },
      { method: 'GET', path: '/nginx/access-lists' },
      { method: 'GET', path: '/audit-log' },
      { method: 'POST', path: '/users/2/2fa' },
      { method: 'POST', path: '/users/2/2fa/enable', body: { code: '918273' } },
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
