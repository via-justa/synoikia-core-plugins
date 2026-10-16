import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS, SECRETS, startFakeProfilarr, VERSION } from './fake-profilarr.js';
import type { FakeProfilarr } from './fake-profilarr.js';
import { LOCK_CASES } from './locks.js';

/** The real core running this plugin's built bundle against the fake Profilarr, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = 'backup-2026-10-14-100005.tar.gz';
const DICTIONARRY = {
  id: 1,
  name: 'Dictionarry',
  repository_url: 'https://github.com/Dictionarry-Hub/database',
  auto_pull: 1,
  personal_access_token: SECRETS.pat,
};

let h: PluginHarness;
let fake: FakeProfilarr;

beforeAll(async () => {
  fake = await startFakeProfilarr();
  h = await startPluginHarness({ pluginDir: PLUGIN_DIR, connection: { baseUrl: fake.url, ...CREDENTIALS } });
  await h.ctx.instances.update(h.instanceId, { settings: { executePerMinute: 1000, writesPerMinute: 1000 } });
}, 60_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

const call = (request: unknown) => `return await profilarr.request(${JSON.stringify(request)});`;
const allow = (key: string, level: 'read' | 'ask') => h.setGroupLevel(h.operation(key).pluginGroup, level);

describe('Profilarr end to end (fake Profilarr)', () => {
  it('syncs the served spec for the instance version', () => {
    expect(h.operations()).toHaveLength(17);
    expect(h.instance()).toMatchObject({ upstreamVersion: VERSION, lastSyncStatus: 'ok' });
    expect(h.operation('POST /databases/{id}/sync')).toMatchObject({ locked: true, typedConfirmation: true });
  });

  it('checks status and lists arr instances at Read', async () => {
    allow('GET /status', 'read');
    allow('GET /arr', 'read');
    const r = await h.execute(
      `const s = await profilarr.request({ path: '/status' });
       const arrs = await profilarr.request({ path: '/api/v1/arr' });
       return s.version + ' ' + arrs[0].name;`,
    );
    expect(r).toMatchObject({ ok: true, value: `${VERSION} Radarr` });
  });

  it('creates a backup once a human approves it at Ask, then polls the job', async () => {
    allow('POST /backups', 'ask');
    allow('GET /jobs/{id}', 'read');
    const shown: string[] = [];
    const r = await h.execute(
      `const { jobId } = await profilarr.request({ method: 'POST', path: '/backups' });
       return (await profilarr.request({ path: '/jobs/' + jobId })).status;`,
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve();
        },
      },
    );
    expect(r).toMatchObject({ ok: true, value: 'success' });
    expect(shown[0]).toContain('Profilarr POST /backups');
  });

  describe('every locked operation needs its literal typed', () => {
    beforeEach(() => {
      fake.databases.set(1, { ...DICTIONARRY });
      fake.backups.add(BACKUP);
    });

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
      for (const secret of ['ghp_new-pat-333333', 'ghp_link-pat-555555'])
        expect(shown.join('\n')).not.toContain(secret);
      // The approver sees which repository is linked or synced.
      if (key.includes('/databases'))
        expect(shown[0]).toMatch(/github\.com\/(Dictionarry-Hub\/database|someone\/profiles)/);
    });
  });

  describe('secrets stay masked', () => {
    beforeEach(() => {
      fake.databases.set(1, { ...DICTIONARRY });
    });

    it.each([
      ['GET /arr', { path: '/arr' }, SECRETS.arrApiKey],
      ['GET /databases', { path: '/databases' }, SECRETS.pat],
      ['GET /databases/{id}', { path: '/databases/1' }, SECRETS.pat],
    ])('%s', async (key, request, secret) => {
      allow(key, 'read');
      const r = await h.execute(call(request));
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(r)).toContain('[REDACTED]');
    });

    it('keeps a database token out of the approval and the audit log', async () => {
      const pat = 'ghp_linked-pat-444444';
      h.setOperationLevel('POST /databases', 'ask');
      const shown: string[] = [];
      const r = await h.execute(
        call({
          method: 'POST',
          path: '/databases',
          body: { name: 'Private', repository_url: 'https://github.com/me/db', personal_access_token: pat },
        }),
        {
          onApproval: (a) => {
            shown.push(a.message, JSON.stringify(a.pending));
            a.approve('Profilarr');
          },
        },
      );
      h.setOperationLevel('POST /databases', null);
      expect(r.ok).toBe(true);
      // The repository the token is for stays visible to the approver.
      expect(shown.join('\n')).toContain('https://github.com/me/db');
      expect(shown.join('\n')).not.toContain(pat);
      expect(JSON.stringify(h.audit({ operationKey: 'POST /databases' }))).not.toContain(pat);
      expect(JSON.stringify(h.audit({ operationKey: 'PATCH /databases/{id}' }))).not.toContain('ghp_new-pat-333333');
    });
  });

  it('reports a Profilarr denial as UPSTREAM_DENIED', async () => {
    allow('GET /backups', 'read');
    fake.denied.add('/api/v1/backups');
    await expect(h.execute(call({ path: '/backups' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/api/v1/backups');
  });

  it('reports a rejected key and an unreachable Profilarr cleanly', async () => {
    await expect(h.testConnection({ baseUrl: fake.url, apiKey: 'wrong' })).resolves.toMatchObject({ ok: false });
    await expect(h.testConnection({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    fake.databases.set(1, { ...DICTIONARRY });
    fake.backups.add(BACKUP);
    expect(
      await checkPluginContract(h, {
        read: { key: 'GET /backups', code: call({ path: '/backups' }) },
        write: { key: 'POST /backups', code: call({ method: 'POST', path: '/backups' }) },
        locked: {
          key: 'DELETE /databases/{id}',
          code: call({ method: 'DELETE', path: '/databases/1' }),
          confirm: 'Dictionarry',
        },
        secrets: { code: call({ path: '/arr' }), values: [SECRETS.arrApiKey] },
      }),
    ).toEqual([]);
    expect(fake.databases.has(1)).toBe(false);
  });
});
