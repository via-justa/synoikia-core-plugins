import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREDENTIALS, ORG, REGION, SECRETS, startFakeGrafanaCloud, VERSION } from './fake-grafanacloud.js';
import type { FakeGrafanaCloud } from './fake-grafanacloud.js';
import { LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake grafana.com, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the approver must see first for these locked calls: privileges, what is installed, what is lost. */
const SHOWN: Record<string, string[]> = {
  'POST /v1/accesspolicies': ['realms=[{"type":"org","identifier":"7"}]', 'scopes=["metrics:write","stacks:write"]'],
  'POST /v1/accesspolicies/{id}': ['scopes=["metrics:read","accesspolicies:write"]', 'realms: stack 101'],
  'POST /v1/tokens': ['stack-readers (scopes: metrics:read, logs:read; realms: stack 101 {env="prod"})'],
  'POST /instances/{instanceId}/plugins': ['plugin="grafana-clock-panel"', 'third-party plugin code'],
  'DELETE /instances/{instanceId}': ['this cannot be undone', 'https://acme-prod.grafana.net'],
  'DELETE /v1/stacks/{idOrSlug}': ['this cannot be undone', 'https://acme-prod.grafana.net'],
  'POST /orgs/{slugOrId}/settings': ['mfaRequired=false'],
};

let h: PluginHarness;
let fake: FakeGrafanaCloud;

beforeAll(async () => {
  fake = await startFakeGrafanaCloud();
  h = await startPluginHarness({
    pluginDir: PLUGIN_DIR,
    connection: { org: ORG, apiUrl: `${fake.url}/api`, specUrl: `${fake.url}/api/openapi.json`, ...CREDENTIALS },
  });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 10000, writesPerMinute: 10000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

const call = (request: unknown) => `return await grafanacloud.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);

describe('Grafana Cloud end to end (fake grafana.com)', () => {
  it('syncs the spec and reports its version', () => {
    expect(h.operations()).toHaveLength(54);
    expect(h.instance()).toMatchObject({ upstreamVersion: VERSION, lastSyncStatus: 'ok' });
    expect(h.operation('POST /v1/tokens')).toMatchObject({ locked: true, typedConfirmation: true });
  });

  it("lists an org's stacks and a stack's plugins at Read", async () => {
    allow('GET /orgs/{orgSlug}/instances', 'read');
    allow('GET /instances/{instanceId}/plugins', 'read');
    const r = await h.execute(
      `const { items } = await grafanacloud.request({ path: '/orgs/${ORG}/instances' });
       const plugins = await grafanacloud.request({ path: '/api/instances/' + items[0].slug + '/plugins' });
       return [items[0].url, plugins.items[0].pluginSlug];`,
    );
    expect(r).toMatchObject({ ok: true, value: ['https://acme-prod.grafana.net', 'grafana-clock-panel'] });
  });

  describe('every locked operation needs its literal typed', () => {
    it.each(LOCK_CASES)('$key → "$confirm"', async ({ key, request, confirm }) => {
      h.setOperationLevel(key, 'ask');
      await expect(h.execute(call(request))).resolves.toMatchObject({ ok: false });
      let literal: unknown;
      let wrongRefused = false;
      const shown: string[] = [];
      const r = await h.execute(call(request), {
        onApproval: (a) => {
          literal = a.pending.confirmLiteral;
          shown.push(a.message);
          try {
            a.approve(`${confirm} (wrong)`);
          } catch {
            wrongRefused = true;
            a.approve(confirm);
          }
        },
      });
      h.setOperationLevel(key, null);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(wrongRefused).toBe(true);
      expect(literal).toBe(confirm);
      for (const text of SHOWN[key] ?? []) expect(shown[0]).toContain(text);
    });
  });

  describe('secrets stay masked', () => {
    it.each([
      ['GET /instances', { path: '/instances' }],
      ['GET /instances/{instanceId}', { path: '/instances/acme-prod', query: { config: true } }],
      ['GET /orgs/{orgSlug}/instances', { path: `/orgs/${ORG}/instances` }],
    ])('%s', async (key, request) => {
      allow(key, 'read');
      const r = await h.execute(call(request));
      expect(r.ok).toBe(true);
      const text = JSON.stringify(r);
      expect(text).not.toContain(SECRETS.mlLogsToken);
      expect(text).not.toContain(SECRETS.configSecret);
      expect(text).toContain('[REDACTED]');
    });

    it('keeps a new Cloud token and a new stack service account token out of results and the audit log', async () => {
      for (const [key, request, confirm, secret] of [
        [
          'POST /v1/tokens',
          {
            method: 'POST',
            path: '/v1/tokens',
            query: { region: REGION },
            body: { name: 'ci', accessPolicyId: 'ap-1' },
          },
          'stack-readers',
          SECRETS.cloudToken,
        ],
        [
          'POST /instances/{instanceId}/api/serviceaccounts/{serviceAccountId}/tokens',
          { method: 'POST', path: '/instances/acme-prod/api/serviceaccounts/5/tokens', body: { name: 'ci' } },
          'synoikia-bot',
          SECRETS.saToken,
        ],
      ] as const) {
        h.setOperationLevel(key, 'ask');
        const r = await h.execute(call(request), { onApproval: (a) => a.approve(confirm) });
        h.setOperationLevel(key, null);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(JSON.stringify(r)).not.toContain(secret);
        expect(JSON.stringify(r)).toContain('[REDACTED]');
        expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain(secret);
      }
    });
  });

  it.each([
    ['AccessPolicyId', '/v1/tokens', { name: 'ci', accessPolicyId: 'ap-1', AccessPolicyId: 'admin-policy' }],
    ['Scopes', '/v1/accesspolicies', { name: 'r', scopes: ['metrics:read'], Scopes: ['accesspolicies:write'] }],
    ['ſcopes', '/v1/accesspolicies', { name: 'r', scopes: ['metrics:read'], ſcopes: ['stacks:delete'] }],
  ])('refuses a body with a %s key before any approval or upstream call', async (_name, path, body) => {
    const key = `POST ${path}`;
    h.setOperationLevel(key, 'ask');
    const before = fake.requests.filter((r) => r.method === 'POST').length;
    let asked = false;
    const r = await h.execute(call({ method: 'POST', path, query: { region: REGION }, body }), {
      onApproval: (a) => {
        asked = true;
        a.approve('stack-readers');
      },
    });
    h.setOperationLevel(key, null);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(asked).toBe(false);
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(before);
  });

  it('reports a grafana.com denial as UPSTREAM_DENIED', async () => {
    allow('GET /stack-regions', 'read');
    fake.denied.add('/api/stack-regions');
    await expect(h.execute(call({ path: '/stack-regions' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/api/stack-regions');
  });

  it('reports a rejected token, an unknown org and an unreachable spec source cleanly', async () => {
    const base = { org: ORG, apiUrl: `${fake.url}/api`, specUrl: `${fake.url}/api/openapi.json` };
    await expect(h.testConnection({ ...base, token: 'wrong' })).resolves.toMatchObject({ ok: false });
    await expect(h.testConnection({ ...base, org: 'someone-else', ...CREDENTIALS })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      h.testConnection({ ...base, specUrl: `${fake.url}/broken/openapi.json`, ...CREDENTIALS }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('No usable Grafana Cloud API spec') });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /stack-regions', code: call({ path: '/stack-regions' }) },
        write: {
          key: 'POST /v1/tokens/{id}',
          code: call({
            method: 'POST',
            path: '/v1/tokens/tok-1',
            query: { region: REGION },
            body: { displayName: 'x' },
          }),
        },
        locked: {
          key: 'DELETE /v1/stacks/{idOrSlug}',
          code: call({ method: 'DELETE', path: '/v1/stacks/acme-prod' }),
          confirm: 'acme-prod',
        },
        secrets: { code: call({ path: '/instances' }), values: [SECRETS.mlLogsToken, SECRETS.configSecret] },
      }),
    ).toEqual([]);
  });
});
