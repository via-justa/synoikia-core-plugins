import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginContract, startPluginHarness } from '@synoikia/core/testing';
import type { PluginHarness } from '@synoikia/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_API_KEY, startFakeTrueNas } from './fake-truenas.js';
import type { FakeTrueNas } from './fake-truenas.js';

/** The real core running this plugin's built bundle against a fake TrueNAS, via core's harness. */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let h: PluginHarness;
let fake: FakeTrueNas;

beforeAll(async () => {
  fake = await startFakeTrueNas();
  h = await startPluginHarness({
    pluginDir: PLUGIN_DIR,
    slug: 'nas',
    connection: { baseUrl: fake.url, apiKey: FAKE_API_KEY },
  });
}, 30_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
});

describe('TrueNAS plugin end to end (fake TrueNAS)', () => {
  it('syncs core.get_methods into groups that start at Read', () => {
    const rows = h.operations();
    expect(rows.length).toBeGreaterThan(30);
    expect(h.operation('pool.dataset.delete')).toMatchObject({ locked: true, typedConfirmation: true });
    expect(h.operation('filesystem.setacl#pool-root')).toMatchObject({ locked: true });
    expect(h.instance()).toMatchObject({ upstreamVersion: 'TrueNAS-25.04.2', lastSyncStatus: 'ok' });
  });

  it('runs reads at Read, redacts secrets in results, and hides writes', async () => {
    await expect(h.execute(`return (await truenas.call('pool.query', [])).map((p) => p.name);`)).resolves.toMatchObject(
      { ok: true, value: ['tank'] },
    );
    const shares = await h.execute(`return await truenas.call('sharing.smb.query');`);
    expect(JSON.stringify(shares)).not.toContain('share-secret-123');
    expect(shares).toMatchObject({ ok: true, value: [{ name: 'media', password: '[REDACTED]' }] });
    const secrets = await h.execute(
      `return await Promise.all(['ups.config', 'snmp.config', 'ssh.config', 'kerberos.keytab.query'].map((m) => truenas.call(m)));`,
    );
    for (const s of ['ups-secret-456', 'snmp-secret-789', 'ssh-secret-key', 'keytab-secret-b64'])
      expect(JSON.stringify(secrets)).not.toContain(s);
    expect(secrets).toMatchObject({
      ok: true,
      value: [
        { monuser: 'upsmon', monpwd: '[REDACTED]' },
        { community: '[REDACTED]' },
        { tcpport: 22, host_ed25519_key: '[REDACTED]' },
        [{ file: '[REDACTED]' }],
      ],
    });
    // Password hashes in user rows (TrueNAS marks them Secret).
    const users = await h.execute(`return await truenas.call('user.query');`);
    expect(JSON.stringify(users)).not.toMatch(/alice-unix-hash|ALICE-NT-HASH/);
    // At Read a group's writes are off (new groups start at Ask in newer core).
    h.setGroupLevel('pool.dataset', 'read');
    await expect(
      h.execute(`return await truenas.call('pool.dataset.create', { name: 'tank/x' });`),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_DISABLED' } });
  });

  it('asks for a write at Ask and runs it once a human approves', async () => {
    h.setGroupLevel('pool.dataset', 'ask');
    const shown: string[] = [];
    const r = await h.execute(`return (await truenas.call('pool.dataset.create', { name: 'tank/apps' })).name;`, {
      onApproval: (a) => {
        shown.push(a.message);
        a.approve();
      },
    });
    expect(r).toMatchObject({ ok: true, value: 'tank/apps' });
    expect(shown[0]).toContain('TrueNAS pool.dataset.create({"name":"tank/apps"})');
    expect(fake.datasets.has('tank/apps')).toBe(true);
  });

  it('auto-approves a call a strict rule covers on its positional params', async () => {
    h.addRule({
      operation: 'pool.dataset.create',
      match: [{ field: '/0/name', op: 'prefix', value: 'tank/media' }],
      reason: 'media datasets',
    });
    const covered = await h.execute(
      `return (await truenas.call('pool.dataset.create', { name: 'tank/media/music' })).name;`,
    );
    expect(covered).toMatchObject({ ok: true, value: 'tank/media/music' });
    // An extra option isn't covered by the strict rule, so a human is asked (and here, nobody can be).
    const extra = await h.execute(
      `return await truenas.call('pool.dataset.create', { name: 'tank/media/tv', quota: 1 });`,
    );
    expect(extra).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(h.audit({ operationKey: 'pool.dataset.create' }).map((a) => a.decision)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^auto-approved:rule:/), 'human-approved', 'denied']),
    );
  });

  it('needs the typed dataset name to delete a dataset (locked)', async () => {
    h.setOperationLevel('pool.dataset.delete', 'ask');
    const attempts: string[] = [];
    const r = await h.execute(`return await truenas.call('pool.dataset.delete', 'tank/apps', { recursive: true });`, {
      onApproval: (a) => {
        try {
          a.approve('tank');
        } catch (err) {
          attempts.push((err as Error).message);
          a.approve('tank/apps');
        }
      },
    });
    expect(attempts[0]).toMatch(/Type "tank\/apps" exactly/);
    expect(r).toMatchObject({ ok: true, value: true });
    expect(fake.datasets.has('tank/apps')).toBe(false);
  });

  it('never hands the model a new API key, token or dataset encryption key', async () => {
    h.setOperationLevel('api_key.create', 'ask');
    h.setOperationLevel('auth.generate_token', 'ask');
    h.setOperationLevel('auth.generate_onetime_password', 'ask');
    h.setOperationLevel('pool.dataset.export_key', 'ask');
    const approveAll = {
      onApproval: (a: { approve: (typed?: string) => void; message: string }) => {
        // Locked calls need their literal: the key's user, or the system's hostname.
        if (a.message.includes('api_key.create')) a.approve('root');
        else if (a.message.includes('auth.generate_')) a.approve('nas01');
        else if (a.message.includes('pool.dataset.export_key')) a.approve('tank/secure');
        else a.approve();
      },
    };
    const results = [
      await h.execute(`return await truenas.call('api_key.create', { name: 'ci', username: 'root' });`, approveAll),
      await h.execute(`return await truenas.call('auth.generate_token');`, approveAll),
      await h.execute(`return await truenas.call('auth.generate_onetime_password');`, approveAll),
      await h.execute(`return await truenas.call('pool.dataset.export_key', 'tank/secure');`, approveAll),
    ];
    expect(results).toMatchObject([
      { ok: true, value: { name: 'ci', key: '[REDACTED]' } },
      { ok: true, value: '[REDACTED]' },
      { ok: true, value: '[REDACTED]' },
      { ok: true, value: '[REDACTED]' },
    ]);
    // Job records don't hand the key back either.
    h.setGroupLevel('core', 'read');
    const jobs = await h.execute(
      `return await truenas.call('core.get_jobs', [['method', '=', 'pool.dataset.export_key']]);`,
    );
    expect(jobs).toMatchObject({ ok: true, value: [{ method: 'pool.dataset.export_key', result: '[REDACTED]' }] });
    // Query options that reshape the records don't get around it: one record (`get`), no method,
    // a renamed result, a count.
    const filter = `[['method', '=', 'pool.dataset.export_key']]`;
    const reshaped = [
      await h.execute(`return await truenas.call('core.get_jobs', ${filter}, { get: true });`),
      await h.execute(`return await truenas.call('core.get_jobs', ${filter}, { select: ['id', 'result'] });`),
      await h.execute(
        `return await truenas.call('core.get_jobs', ${filter}, { select: ['method', ['result', 'r']] });`,
      ),
      await h.execute(`return await truenas.call('core.get_jobs', ${filter}, { count: true });`),
    ];
    expect(reshaped).toMatchObject([
      { ok: true, value: { method: 'pool.dataset.export_key', result: '[REDACTED]' } },
      { ok: true, value: [{ id: expect.any(Number), result: '[REDACTED]' }] },
      { ok: true, value: [{ method: 'pool.dataset.export_key', r: '[REDACTED]' }] },
      { ok: true, value: 1 },
    ]);
    const all = JSON.stringify([results, jobs, reshaped, h.audit({})]);
    for (const secret of ['4-fresh-api-key-secret', 'fresh-session-token-secret', 'dataset-key-secret'])
      expect(all).not.toContain(secret);
  });

  it('keeps a positional password out of the approval and the audit log, via core', async () => {
    h.setOperationLevel('user.setup_local_administrator', 'ask');
    const shown: string[] = [];
    const r = await h.execute(
      `return await truenas.call('user.setup_local_administrator', 'truenas_admin', 'hunter2-local-secret');`,
      {
        onApproval: (a) => {
          shown.push(a.message);
          a.approve('truenas_admin');
        },
      },
    );
    expect(r).toMatchObject({ ok: true, value: { username: 'truenas_admin', configured: true } });
    // The upstream got the real password; nobody else saw it.
    expect(fake.calls.at(-1)).toEqual({
      method: 'user.setup_local_administrator',
      params: ['truenas_admin', 'hunter2-local-secret'],
    });
    const audit = h.audit({ operationKey: 'user.setup_local_administrator' }).filter((a) => a.kind === 'call');
    expect(audit[0]?.params).toEqual(['truenas_admin', '[REDACTED]']);
    expect(JSON.stringify([shown, audit])).not.toContain('hunter2-local-secret');
  });

  it('keeps a cloud credential key out of results and the audit log', async () => {
    h.setOperationLevel('cloudsync.credentials.query', 'read');
    const q = await h.execute(`return await truenas.call('cloudsync.credentials.query');`);
    expect(JSON.stringify(q)).not.toContain('b2-application-key-secret');
    h.setOperationLevel('cloudsync.credentials.create', 'write');
    const r = await h.execute(
      `return await truenas.call('cloudsync.credentials.create', { name: 'b2', provider: { type: 'B2', account: 'a', key: 'b2-new-key-secret' } });`,
    );
    expect(r).toMatchObject({ ok: true });
    expect(JSON.stringify(r)).not.toContain('b2-new-key-secret');
    expect(fake.calls.at(-1)?.params).toEqual([
      { name: 'b2', provider: { type: 'B2', account: 'a', key: 'b2-new-key-secret' } },
    ]);
    const audit = h.audit({ operationKey: 'cloudsync.credentials.create' }).filter((a) => a.kind === 'call');
    expect(JSON.stringify(audit)).not.toContain('b2-new-key-secret');
  });

  it('reports a TrueNAS permission denial as UPSTREAM_DENIED', async () => {
    fake.denied.add('user.query');
    await expect(h.execute(`return await truenas.call('user.query');`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('user.query');
  });

  it('loads under the permission model and reports an unreachable TrueNAS cleanly', async () => {
    await expect(h.testConnection({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('keeps the plugin contract (shared checks from @synoikia/core/testing)', async () => {
    fake.datasets.set('tank/contract', { id: 'tank/contract', name: 'tank/contract' });
    expect(
      await checkPluginContract(h, {
        read: { key: 'pool.query', code: `return await truenas.call('pool.query');` },
        write: {
          key: 'pool.dataset.create',
          code: `return await truenas.call('pool.dataset.create', { name: 'tank/x' });`,
        },
        locked: {
          key: 'pool.dataset.delete',
          code: `return await truenas.call('pool.dataset.delete', 'tank/contract');`,
          confirm: 'tank/contract',
        },
        // The keytab sits under the common name `file`: no key name gives it away; plugin.yaml's
        // sensitiveResult declares it, and core masks it.
        secrets: { code: `return await truenas.call('kerberos.keytab.query');`, values: ['keytab-secret-b64'] },
      }),
    ).toEqual([]);
    expect(fake.datasets.has('tank/contract')).toBe(false);
  });
});
