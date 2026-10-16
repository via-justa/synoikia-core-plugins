import { maskSensitiveResult } from '@synoikia/plugin-sdk';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrafanaCloudPlugin } from '../src/plugin.js';
import { CREDENTIALS, ORG, REGION, startFakeGrafanaCloud } from './fake-grafanacloud.js';
import type { FakeGrafanaCloud } from './fake-grafanacloud.js';
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

const plugin = createGrafanaCloudPlugin();
let fake: FakeGrafanaCloud;
let operations: OperationDescriptor[];

beforeAll(async () => {
  fake = await startFakeGrafanaCloud();
  await plugin.init({
    instanceId: 'grafanacloud',
    config: { org: ORG, apiUrl: `${fake.url}/api`, specUrl: `${fake.url}/api/openapi.json` },
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

/** What the approver sees for a call: resolved key, targets, summary and literal. */
async function approval(request: unknown) {
  const { key, params } = await plugin.resolveOperation({ fn: 'request', args: [request] });
  const declared = operations.find((o) => o.key === key)?.sensitiveParams ?? [];
  const targets = (await plugin.resolveTargets?.({ key, params })) ?? [];
  return { key, targets, ...(await plugin.summarize({ key, params: redactPaths(params, declared), targets })) };
}

describe('Grafana Cloud golden record', () => {
  // paramsSchema and docs come verbatim from the upstream spec; the policy fields are what this plugin decides.
  it('catalog policy per descriptor', async () => {
    const policy = operations.map(({ paramsSchema: _schema, docs: _docs, ...rest }) => rest);
    await expect(stable(policy)).toMatchFileSnapshot('__golden__/catalog.json');
  });

  it('summaries and confirm literals of locked operations', async () => {
    const out: Record<string, unknown> = {};
    for (const c of LOCK_CASES) {
      const { key, ...shown } = await approval(c.request);
      out[c.key] = { resolved: key, ...shown };
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/summaries.json');
  });

  it('privileges and destinations stay ahead of a padded body', async () => {
    const padding = 'x'.repeat(2000);
    const calls = [
      {
        method: 'POST',
        path: '/v1/accesspolicies',
        query: { region: REGION },
        body: { padding, name: 'w', scopes: ['stacks:delete'], realms: [{ type: 'org', identifier: '7' }] },
      },
      {
        method: 'POST',
        path: '/v1/tokens',
        query: { region: REGION },
        body: { padding, name: 'ci', accessPolicyId: 'ap-1' },
      },
      {
        method: 'POST',
        path: '/instances/acme-prod/plugins',
        body: { padding, plugin: 'some-panel', version: '1.0.0' },
      },
      {
        method: 'POST',
        path: '/v1/stacks/acme-prod',
        body: { padding, deleteProtection: false, url: 'https://x.example.net' },
      },
      {
        method: 'POST',
        path: '/orgs/acme/settings',
        body: { padding, mfaRequired: false, allowedInviteDomains: ['example.net'] },
      },
    ];
    const out: Record<string, unknown> = {};
    for (const request of calls) {
      const { key, ...shown } = await approval(request);
      out[key] = shown;
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/fields.json');
  });

  // grafana.com (Go) binds keys case-insensitively and folds ſ and the Kelvin sign: such requests are refused.
  it('requests grafana.com would bind to another field than the approval shows', async () => {
    const calls = {
      AccessPolicyId: {
        method: 'POST',
        path: '/v1/tokens',
        query: { region: REGION },
        body: { name: 'ci', accessPolicyId: 'ap-1', AccessPolicyId: 'admin-policy' },
      },
      Scopes: {
        method: 'POST',
        path: '/v1/accesspolicies',
        query: { region: REGION },
        body: { name: 'r', scopes: ['metrics:read'], Scopes: ['accesspolicies:write'], realms: [] },
      },
      ſcopes: {
        method: 'POST',
        path: '/v1/accesspolicies',
        query: { region: REGION },
        body: { name: 'r', scopes: ['metrics:read'], ſcopes: ['accesspolicies:write'], realms: [] },
      },
      'lone AccessPolicyID': {
        method: 'POST',
        path: '/v1/tokens',
        query: { region: REGION },
        body: { name: 'ci', AccessPolicyID: 'ap-1' },
      },
    };
    const out: Record<string, unknown> = {};
    for (const [name, request] of Object.entries(calls)) {
      try {
        out[name] = { approval: await approval(request) };
      } catch (err) {
        const e = err as { code?: unknown; message?: unknown };
        out[name] = { refused: { code: e.code, message: e.message } };
      }
    }
    await expect(stable(out)).toMatchFileSnapshot('__golden__/case-folding.json');
  });

  it('results with secrets, as core masks them by descriptor', async () => {
    const calls = [
      { method: 'GET', path: '/instances' },
      { method: 'GET', path: '/instances/acme-prod', query: { config: true } },
      { method: 'GET', path: '/orgs/acme/instances' },
      { method: 'POST', path: '/v1/tokens', query: { region: REGION }, body: { name: 'ci', accessPolicyId: 'ap-1' } },
      { method: 'POST', path: '/instances/acme-prod/api/serviceaccounts/5/tokens', body: { name: 'ci' } },
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
