import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALEX, CREDENTIALS, PASSWORD, PROXY_HOST, SECRETS, startFakeNpm } from './fake-npm.js';
import type { FakeNpm } from './fake-npm.js';
import { DESTINATIONS, LOCK_CASES, PARAM_SECRETS } from './locks.js';

/** The real core running this plugin's built bundle against the fake Nginx Proxy Manager, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeNpm;

beforeAll(async () => {
  fake = await startFakeNpm();
  h = await startPluginHarness({ pluginDir: PLUGIN_DIR, connection: { baseUrl: fake.url, ...CREDENTIALS } });
  // One run per lock and secret case: more than the default per-minute caps allow.
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

beforeEach(() => {
  fake.proxyHosts.set(PROXY_HOST.id, { ...PROXY_HOST, domain_names: [...PROXY_HOST.domain_names] });
  fake.users.set(ALEX.id, { ...ALEX });
});

const call = (request: unknown) => `return await npm.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);

describe('Nginx Proxy Manager end to end (fake NPM)', () => {
  it('syncs the served spec for the instance version', () => {
    expect(h.operations()).toHaveLength(64);
    expect(h.instance()).toMatchObject({ upstreamVersion: '2.16.0', lastSyncStatus: 'ok' });
    expect(h.operation('PUT /nginx/dead-hosts/{hostID}#advanced')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
  });

  it('lists proxy hosts with their certificates at Read', async () => {
    allow('GET /nginx/proxy-hosts', 'read');
    const r = await h.execute(
      `const hosts = await npm.request({ path: '/nginx/proxy-hosts', query: { expand: 'certificate' } });
       return hosts.map((x) => x.domain_names[0] + ' ' + x.certificate.nice_name);`,
    );
    expect(r).toMatchObject({ ok: true, value: ['app.home.example Home wildcard'] });
  });

  it('renews a certificate once a human approves it at Ask', async () => {
    allow('POST /nginx/certificates/{certID}/renew', 'ask');
    const shown: string[] = [];
    const r = await h.execute(call({ method: 'POST', path: '/nginx/certificates/1/renew' }), {
      onApproval: (a) => {
        shown.push(a.message);
        a.approve();
      },
    });
    expect(r).toMatchObject({ ok: true, value: { nice_name: 'Home wildcard' } });
    expect(shown[0]).toContain('Nginx Proxy Manager POST /nginx/certificates/1/renew');
  });

  it('creates a 404 host at Ask, but takes the locked twin with raw nginx config', async () => {
    allow('POST /nginx/dead-hosts', 'ask');
    const plain = await h.execute(
      call({ method: 'POST', path: '/nginx/dead-hosts', body: { domain_names: ['parked.home.example'] } }),
      { onApproval: (a) => a.approve() },
    );
    expect(plain).toMatchObject({ ok: true });
    const advanced = { domain_names: ['parked.home.example'], advanced_config: 'return 302 https://x.example;' };
    const twin = 'POST /nginx/dead-hosts#advanced';
    // Allowing the group does not reach the locked twin; only its own level does, with the literal typed.
    await expect(
      h.execute(call({ method: 'POST', path: '/nginx/dead-hosts', body: advanced }), {
        onApproval: (a) => a.approve(),
      }),
    ).resolves.toMatchObject({ ok: false });
    h.setOperationLevel(twin, 'ask');
    let literal: unknown;
    const r = await h.execute(call({ method: 'POST', path: '/nginx/dead-hosts', body: advanced }), {
      onApproval: (a) => {
        literal = a.pending.confirmLiteral;
        a.approve('parked.home.example');
      },
    });
    expect(literal).toBe('parked.home.example');
    expect(r).toMatchObject({ ok: true });
    h.setOperationLevel(twin, null);
    expect(h.audit({ operationKey: twin })).not.toEqual([]);
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
      // Where the host or stream sends traffic stays visible to the approver.
      const body = JSON.stringify(request.body ?? {});
      for (const dest of DESTINATIONS) if (body.includes(dest.split(':')[0]!)) expect(shown[0]).toContain(dest);
      // Passwords and 2FA codes in the call never reach the approver or the audit log.
      const audit = JSON.stringify(h.audit({ operationKey: key }));
      for (const secret of PARAM_SECRETS) {
        expect(shown.join('\n')).not.toContain(secret);
        expect(audit).not.toContain(secret);
      }
    });
  });

  describe('secrets stay masked', () => {
    it.each([
      ['GET /nginx/certificates', { path: '/nginx/certificates' }, [SECRETS.dnsCredentials, SECRETS.privateKey]],
      [
        'GET /nginx/proxy-hosts',
        { path: '/nginx/proxy-hosts', query: { expand: 'certificate' } },
        [SECRETS.dnsCredentials, SECRETS.privateKey],
      ],
      ['GET /nginx/access-lists', { path: '/nginx/access-lists' }, [SECRETS.basicAuthPassword]],
      ['GET /audit-log', { path: '/audit-log' }, [SECRETS.dnsCredentials, SECRETS.privateKey]],
    ])('%s', async (key, request, secrets) => {
      allow(key, 'read');
      const r = await h.execute(call(request));
      expect(r.ok).toBe(true);
      for (const secret of secrets) expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(r)).toContain('[REDACTED]');
    });

    it.each([
      ['POST /users/{userID}/2fa', { method: 'POST', path: '/users/2/2fa' }, SECRETS.totpSecret],
      [
        'POST /users/{userID}/2fa/enable',
        { method: 'POST', path: '/users/2/2fa/enable', body: { code: '918273' } },
        SECRETS.backupCode,
      ],
    ])('%s (locked) returns its 2FA secret masked', async (key, request, secret) => {
      h.setOperationLevel(key, 'ask');
      const r = await h.execute(call(request), { onApproval: (a) => a.approve(ALEX.email) });
      h.setOperationLevel(key, null);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(h.audit({ operationKey: key }))).not.toContain(secret);
    });

    it('keeps DNS-provider credentials out of a certificate request approval and the audit log', async () => {
      allow('POST /nginx/certificates', 'ask');
      const shown: string[] = [];
      const r = await h.execute(
        call({
          method: 'POST',
          path: '/nginx/certificates',
          body: {
            provider: 'letsencrypt',
            domain_names: ['*.home.example'],
            meta: { dns_challenge: true, dns_provider: 'cloudflare', dns_provider_credentials: 'cf-token-121212' },
          },
        }),
        {
          onApproval: (a) => {
            shown.push(a.message, JSON.stringify(a.pending));
            a.approve();
          },
        },
      );
      expect(r.ok).toBe(true);
      expect(shown.join('\n')).toContain('*.home.example');
      for (const text of [
        shown.join('\n'),
        JSON.stringify(r),
        JSON.stringify(h.audit({ operationKey: 'POST /nginx/certificates' })),
      ])
        expect(text).not.toContain('cf-token-121212');
    });

    it('never puts the connection password or the session token in the audit log', () => {
      const audit = JSON.stringify(h.audit({}));
      expect(audit).not.toContain(PASSWORD);
      expect(audit).not.toMatch(/jwt-\d+/);
    });
  });

  it('signs in again after the session token expires', async () => {
    allow('GET /users', 'read');
    const before = fake.signIns;
    fake.expireToken();
    await expect(h.execute(call({ path: '/users' }))).resolves.toMatchObject({ ok: true });
    expect(fake.signIns).toBe(before + 1);
  });

  it('reports an NPM permission denial as UPSTREAM_DENIED', async () => {
    allow('GET /settings', 'read');
    fake.denied.add('/api/settings');
    await expect(h.execute(call({ path: '/settings' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/api/settings');
  });

  it('reports a rejected password and an unreachable NPM cleanly', async () => {
    await expect(
      h.testConnection({ baseUrl: fake.url, email: CREDENTIALS.email, password: 'wrong' }),
    ).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      h.testConnection({ baseUrl: 'http://127.0.0.1:1', email: CREDENTIALS.email, password: 'p' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /nginx/proxy-hosts/{hostID}', code: call({ path: '/nginx/proxy-hosts/1' }) },
        write: {
          key: 'POST /nginx/access-lists',
          code: call({ method: 'POST', path: '/nginx/access-lists', body: { name: 'Guests', satisfy_any: false } }),
        },
        locked: {
          key: 'DELETE /nginx/proxy-hosts/{hostID}',
          code: call({ method: 'DELETE', path: '/nginx/proxy-hosts/1' }),
          confirm: 'app.home.example',
        },
        secrets: { code: call({ path: '/nginx/certificates' }), values: [SECRETS.dnsCredentials, SECRETS.privateKey] },
      }),
    ).toEqual([]);
    expect(fake.proxyHosts.has(PROXY_HOST.id)).toBe(false);
  });
});
