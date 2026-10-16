import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREDENTIALS, ORG, SECRETS, startFakeGrafana, VERSION } from './fake-grafana.js';
import type { FakeGrafana } from './fake-grafana.js';
import { LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake Grafana, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every secret value the lock cases send in a body; none may reach an approval or the audit log. */
const SENT_SECRETS = [
  'gh-client-secret-777777',
  'new-user-password-555555',
  'cloud-migration-token-888888',
  'new-ds-password-666666',
  'license-jwt-999999',
  'webhook-password-171717',
  'T0KEN-121212',
  'T0KEN-181818',
  'reset-password-131313',
  'old-password-141414',
  'new-password-151515',
];

/** Destinations a locked call points data at: the approver must see them. */
const DESTINATIONS: Record<string, string> = {
  'POST /datasources': 'http://loki.example.net:3100',
  'PUT /datasources/{id}': 'http://elsewhere.example.net:9090',
  'PUT /datasources/uid/{uid}': 'http://elsewhere.example.net:9090',
  'POST /v1/provisioning/contact-points': 'hooks.example.net (contact point URL)',
  'PUT /v1/provisioning/contact-points/{UID}': 'elsewhere.example.net (contact point URL)',
  'POST /reports/test-email': 'test@example.org',
  'PUT /reports/{id}': 'outside@example.net',
  'POST /reports/email': 'someone@example.com',
};

let h: PluginHarness;
let fake: FakeGrafana;

beforeAll(async () => {
  fake = await startFakeGrafana();
  h = await startPluginHarness({ pluginDir: PLUGIN_DIR, connection: { baseUrl: fake.url, ...CREDENTIALS } });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 10000, writesPerMinute: 10000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

const call = (request: unknown) => `return await grafana.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);

describe('Grafana end to end (fake Grafana)', () => {
  it('syncs the served spec for the instance version', () => {
    expect(h.operations()).toHaveLength(310);
    expect(h.instance()).toMatchObject({ upstreamVersion: VERSION, lastSyncStatus: 'ok' });
    expect(h.operation('POST /serviceaccounts/{serviceAccountId}/tokens')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('finds a dashboard at Read', async () => {
    allow('GET /search', 'read');
    allow('GET /dashboards/uid/{uid}', 'read');
    const r = await h.execute(
      `const [hit] = await grafana.request({ path: '/search', query: { query: 'home', type: 'dash-db' } });
       return (await grafana.request({ path: '/api/dashboards/uid/' + hit.uid })).dashboard.title;`,
    );
    expect(r).toMatchObject({ ok: true, value: 'Home Lab' });
  });

  it('queries data sources only after approval, naming each one it hits', async () => {
    const query = {
      method: 'POST',
      path: '/ds/query',
      body: {
        queries: [
          { refId: 'A', datasource: { uid: 'prom' }, expr: 'up' },
          { refId: 'B', datasource: { uid: 'mysql-prod' }, rawSql: 'DELETE FROM users' },
        ],
        from: 'now-1h',
        to: 'now',
      },
    };
    allow('POST /ds/query', 'read');
    await expect(h.execute(call(query))).resolves.toMatchObject({ ok: false });
    allow('POST /ds/query', 'ask');
    const shown: string[] = [];
    const r = await h.execute(`return (await grafana.request(${JSON.stringify(query)})).results.A.status;`, {
      onApproval: (a) => {
        shown.push(a.message, JSON.stringify(a.pending));
        a.approve();
      },
    });
    expect(r).toMatchObject({ ok: true, value: 200 });
    expect(shown[0]).toContain('on Prometheus (prometheus, http://prometheus:9090), mysql-prod');
  });

  it('creates an annotation once a human approves it at Ask', async () => {
    allow('POST /annotations', 'ask');
    const shown: string[] = [];
    const r = await h.execute(call({ method: 'POST', path: '/annotations', body: { text: 'deploy', tags: ['ci'] } }), {
      onApproval: (a) => {
        shown.push(a.message);
        a.approve();
      },
    });
    expect(r).toMatchObject({ ok: true });
    expect(shown[0]).toContain('Grafana POST /annotations');
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
          shown.push(a.message, JSON.stringify(a.pending));
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
      const text = shown.join('\n');
      for (const secret of SENT_SECRETS) expect(text).not.toContain(secret);
      expect(JSON.stringify(h.audit({ operationKey: key }))).not.toMatch(SENT_SECRETS.join('|'));
      const destination = DESTINATIONS[key];
      if (destination) expect(shown[0]).toContain(destination);
      // The approver of a data source change sees where its queries go today.
      if (/ \/datasources\/(\{id\}|uid\/\{uid\})$/.test(key)) expect(shown[0]).toContain('http://prometheus:9090');
    });

    it('covers the organization fallback literal', () => {
      expect(LOCK_CASES.some((c) => c.confirm === ORG)).toBe(true);
    });
  });

  describe('secrets stay masked', () => {
    it.each([
      ['GET /datasources', { path: '/datasources' }, SECRETS.dsPassword],
      ['GET /datasources/uid/{uid}', { path: '/datasources/uid/prom' }, SECRETS.dsPassword],
      ['GET /v1/provisioning/contact-points', { path: '/v1/provisioning/contact-points' }, SECRETS.slackUrl],
      ['GET /org/invites', { path: '/org/invites' }, SECRETS.inviteCode],
    ])('%s', async (key, request, secret) => {
      allow(key, 'read');
      const r = await h.execute(call(request));
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(r)).toContain('[REDACTED]');
    });

    it('keeps a new service account token and a snapshot delete key out of the result', async () => {
      for (const [key, request, secret] of [
        [
          'POST /serviceaccounts/{serviceAccountId}/tokens',
          { method: 'POST', path: '/serviceaccounts/4/tokens', body: { name: 'ci' } },
          SECRETS.saToken,
        ],
        [
          'POST /snapshots',
          { method: 'POST', path: '/snapshots', body: { dashboard: { title: 'x' } } },
          SECRETS.deleteKey,
        ],
      ] as const) {
        h.setOperationLevel(key, 'ask');
        const confirm = key.startsWith('POST /serviceaccounts') ? 'synoikia-bot' : ORG;
        const r = await h.execute(call(request), { onApproval: (a) => a.approve(confirm) });
        h.setOperationLevel(key, null);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(JSON.stringify(r)).not.toContain(secret);
        expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain(secret);
      }
    });
  });

  it.each([
    ['Datasource', '/ds/query', { queries: [{ datasource: { uid: 'prom' }, Datasource: { uid: 'mysql-prod' } }] }],
    ['URL', '/datasources', { name: 'loki', url: 'http://loki:3100', URL: 'http://evil.example.net' }],
    ['ſettings', '/v1/provisioning/contact-points', { settings: { url: 'https://a.example' }, ſettings: {} }],
  ])('refuses a body with a %s key before any approval or upstream call', async (_name, path, body) => {
    const key = `POST ${path}`;
    h.setOperationLevel(key, 'ask');
    const before = fake.requests.filter((r) => r.method === 'POST').length;
    let asked = false;
    const r = await h.execute(call({ method: 'POST', path, body }), {
      onApproval: (a) => {
        asked = true;
        a.approve(ORG);
      },
    });
    h.setOperationLevel(key, null);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(asked).toBe(false);
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(before);
  });

  it('masks a contact point URL sent as Settings.URL and shows only its host', async () => {
    const key = 'POST /v1/provisioning/contact-points';
    h.setOperationLevel(key, 'ask');
    const url = 'https://hooks.slack.com/services/EXAMPLE';
    const body = { name: 'S', type: 'slack', Settings: { URL: url } };
    const shown: string[] = [];
    const r = await h.execute(call({ method: 'POST', path: '/v1/provisioning/contact-points', body }), {
      onApproval: (a) => {
        shown.push(a.message, JSON.stringify(a.pending));
        a.approve(ORG);
      },
    });
    h.setOperationLevel(key, null);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(shown[0]).toContain('hooks.slack.com (contact point URL)');
    expect(shown.join('\n')).not.toContain('services/EXAMPLE');
    expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain('services/EXAMPLE');
    expect(fake.requests.at(-1)?.body).toMatchObject({ settings: { url } });
  });

  it('reports a Grafana denial as UPSTREAM_DENIED', async () => {
    allow('GET /folders', 'read');
    fake.denied.add('/api/folders');
    await expect(h.execute(call({ path: '/folders' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/api/folders');
  });

  it('reports a rejected token, an old Grafana and an unreachable one cleanly', async () => {
    await expect(h.testConnection({ baseUrl: fake.url, token: 'wrong' })).resolves.toMatchObject({ ok: false });
    fake.setVersion('11.6.0');
    await expect(h.testConnection({ baseUrl: fake.url, ...CREDENTIALS })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('needs Grafana 12 or later'),
    });
    fake.setVersion(VERSION);
    await expect(h.testConnection({ baseUrl: 'http://127.0.0.1:1', token: 'k' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /search', code: call({ path: '/search' }) },
        write: { key: 'POST /annotations', code: call({ method: 'POST', path: '/annotations', body: { text: 'x' } }) },
        locked: {
          key: 'DELETE /datasources/uid/{uid}',
          code: call({ method: 'DELETE', path: '/datasources/uid/prom' }),
          confirm: 'Prometheus',
        },
        secrets: { code: call({ path: '/datasources' }), values: [SECRETS.dsPassword] },
      }),
    ).toEqual([]);
  });
});
